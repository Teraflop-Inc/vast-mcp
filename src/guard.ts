import type { Limits } from "./limits.js";
import { MemoryStore, type Store } from "./store.js";
import type { Instance, Offer, VastClient } from "./vast.js";

// Every instance this server rents carries this label prefix plus its expiry
// time. Only labeled instances can be stopped or destroyed through the MCP.
export const LABEL_PREFIX = "vast-mcp";
const QUOTE_TTL_MS = 10 * 60 * 1000;
// GPU utilization (percent) below which a minute counts as idle.
export const IDLE_UTIL_PERCENT = 5;
// A quote stays valid if the live price rose by at most this much.
const PRICE_SLACK = 1.05;

export class PolicyError extends Error {}

export interface ManagedLabel {
  name: string;
  expiresAt: number; // unix seconds
}

export function makeLabel(name: string, expiresAt: number): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "job";
  return `${LABEL_PREFIX}:${safe}:exp=${expiresAt}`;
}

export function parseLabel(label: string | null | undefined): ManagedLabel | undefined {
  const m = /^vast-mcp:([^:]*):exp=(\d+)$/.exec(label ?? "");
  return m ? { name: m[1], expiresAt: Number(m[2]) } : undefined;
}

// Runs on the instance itself, so the time limit holds even after the user
// closes their assistant and this server stops. Vast injects CONTAINER_ID and
// a per-instance CONTAINER_API_KEY that is allowed to destroy its own instance.
export function buildOnstart(opts: {
  hours: number;
  command?: string;
  destroyOnExit: boolean;
  apiUrl: string;
  // Destroy after this many minutes with every GPU under IDLE_UTIL_PERCENT. 0 or unset turns it off.
  idleMinutes?: number;
}): string {
  const ttlSeconds = Math.round(opts.hours * 3600);
  const lines = [
    "cat > /tmp/vast-mcp-destroy.sh <<'VASTMCP'",
    "#!/bin/sh",
    `URL="${opts.apiUrl}/api/v0/instances/\${CONTAINER_ID}/"`,
    "for i in 1 2 3 4 5 6 7 8 9 10; do",
    "  if command -v curl >/dev/null 2>&1; then",
    '    curl -fsS -X DELETE -H "Authorization: Bearer ${CONTAINER_API_KEY}" -H "Content-Type: application/json" -d "{}" "$URL" && exit 0',
    "  elif command -v python3 >/dev/null 2>&1; then",
    `    U="$URL" python3 -c "import os,urllib.request as u;u.urlopen(u.Request(os.environ['U'],data=b'{}',method='DELETE',headers={'Authorization':'Bearer '+os.environ['CONTAINER_API_KEY'],'Content-Type':'application/json'}))" && exit 0`,
    "  fi",
    "  sleep 30",
    "done",
    "VASTMCP",
    "chmod +x /tmp/vast-mcp-destroy.sh",
    // Without either tool the timer cannot call the API; say so where instance_logs can see it.
    'command -v curl >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 || echo "vast-mcp: WARNING: image has neither curl nor python3, so the self-destroy timer cannot run. Destroy this instance yourself." >/proc/1/fd/1',
    `nohup sh -c 'sleep ${ttlSeconds}; echo "vast-mcp: time limit reached, destroying"; /tmp/vast-mcp-destroy.sh' >/tmp/vast-mcp-ttl.log 2>&1 &`,
  ];
  if (opts.idleMinutes && opts.idleMinutes > 0) {
    // Checks once a minute; the busiest GPU decides, so one working GPU keeps a multi-GPU box alive.
    lines.push(
      "cat > /tmp/vast-mcp-idle.sh <<'VASTMCPIDLE'",
      "#!/bin/sh",
      'command -v nvidia-smi >/dev/null 2>&1 || { echo "vast-mcp: WARNING: no nvidia-smi, idle auto-stop is off" >/proc/1/fd/1; exit 0; }',
      "idle=0",
      "while true; do",
      "  sleep 60",
      "  util=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | sort -n | tail -1 | tr -dc 0-9)",
      `  if [ -n "$util" ] && [ "$util" -lt ${IDLE_UTIL_PERCENT} ]; then idle=$((idle+1)); else idle=0; fi`,
      `  if [ "$idle" -ge ${Math.round(opts.idleMinutes)} ]; then`,
      `    echo "vast-mcp: GPU idle for ${Math.round(opts.idleMinutes)} minutes, destroying" >/proc/1/fd/1`,
      "    /tmp/vast-mcp-destroy.sh; exit 0",
      "  fi",
      "done",
      "VASTMCPIDLE",
      "nohup sh /tmp/vast-mcp-idle.sh >/tmp/vast-mcp-idle.log 2>&1 &",
    );
  }
  if (opts.command) {
    const after = opts.destroyOnExit ? '; echo "vast-mcp: job finished, destroying"; /tmp/vast-mcp-destroy.sh' : "";
    lines.push(
      "cat > /tmp/vast-mcp-job.sh <<'VASTMCPJOB'",
      opts.command,
      "VASTMCPJOB",
      `nohup sh -c 'bash /tmp/vast-mcp-job.sh; echo "vast-mcp: job exited with code $?"${after}' >/tmp/vast-mcp-job.log 2>&1 &`,
      // Mirror job output to the container log so `instance_logs` can read it without SSH.
      "nohup tail -F /tmp/vast-mcp-job.log >/proc/1/fd/1 2>/dev/null &",
    );
  }
  return lines.join("\n");
}

export interface QuoteRequest {
  offerId: number;
  hours: number;
  image: string;
  disk: number;
  name: string;
  command?: string;
  destroyOnExit: boolean;
  idleMinutes?: number;
  env?: Record<string, string>;
}

export interface Quote extends QuoteRequest {
  quoteId: string;
  offer: Offer;
  pricePerHour: number;
  maxCost: number;
  createdAt: number;
}

export function isActive(i: Instance): boolean {
  const s = (i.actual_status ?? i.intended_status ?? "").toLowerCase();
  return s !== "exited" && s !== "stopped" && s !== "offline";
}

export interface GuardOptions {
  store?: Store;
  // Whose quotes and spend these are. One fixed owner locally; a hash of the user's key when hosted.
  owner?: string;
  // Session spend counts rentals in this rolling window. Unset means since this Guard was created,
  // which for the local server is the life of the process.
  spendWindowMs?: number;
  now?: () => number;
}

export class Guard {
  private readonly store: Store;
  private readonly owner: string;
  private readonly now: () => number;
  private readonly createdAt: number;

  constructor(
    readonly limits: Limits,
    private readonly client: VastClient,
    private readonly opts: GuardOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.store = opts.store ?? new MemoryStore(this.now);
    this.owner = opts.owner ?? "local";
    this.createdAt = this.now();
  }

  private spendWindowStart(): number {
    return this.opts.spendWindowMs === undefined ? this.createdAt : this.now() - this.opts.spendWindowMs;
  }

  committedSpend(): Promise<number> {
    return this.store.spendSince(this.owner, this.spendWindowStart());
  }

  assertWritable(): void {
    if (this.limits.readOnly) throw new PolicyError("Read-only mode is on (VAST_MCP_READ_ONLY). Renting and changing instances is disabled.");
  }

  assertManaged(instance: Instance): ManagedLabel {
    const managed = parseLabel(instance.label);
    if (!managed) {
      throw new PolicyError(
        `Instance ${instance.id} was not created by vast-mcp (label "${instance.label ?? ""}"). Manage it in the Vast console instead.`,
      );
    }
    return managed;
  }

  private async managedInstances(): Promise<Instance[]> {
    return (await this.client.listInstances()).filter((i) => parseLabel(i.label));
  }

  // Checks that an extra `pricePerHour` for `hours` stays inside every limit.
  async checkBudget(pricePerHour: number, hours: number, opts: { newInstance: boolean }): Promise<void> {
    const l = this.limits;
    if (pricePerHour > l.maxPricePerHour) {
      throw new PolicyError(`$${pricePerHour.toFixed(3)}/hr is over the per-GPU limit of $${l.maxPricePerHour}/hr (VAST_MCP_MAX_PRICE_PER_HOUR).`);
    }
    if (hours > l.maxHours) {
      throw new PolicyError(`${hours} hours is over the time limit of ${l.maxHours} hours (VAST_MCP_MAX_HOURS).`);
    }
    const committed = (await this.committedSpend()) + pricePerHour * hours;
    if (committed > l.maxSessionSpend) {
      throw new PolicyError(
        `This would bring session spend to $${committed.toFixed(2)}, over the $${l.maxSessionSpend} limit (VAST_MCP_MAX_SESSION_SPEND).`,
      );
    }
    const active = (await this.managedInstances()).filter(isActive);
    if (opts.newInstance && active.length >= l.maxInstances) {
      throw new PolicyError(`Already running ${active.length} vast-mcp instances, the limit is ${l.maxInstances} (VAST_MCP_MAX_INSTANCES).`);
    }
    const runningPerHour = active.reduce((sum, i) => sum + (i.dph_total ?? 0), 0);
    if (runningPerHour + pricePerHour > l.maxTotalPerHour) {
      throw new PolicyError(
        `Total would be $${(runningPerHour + pricePerHour).toFixed(3)}/hr across instances, over the $${l.maxTotalPerHour}/hr limit (VAST_MCP_MAX_TOTAL_PER_HOUR).`,
      );
    }
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    this.assertWritable();
    const offer = await this.client.getOffer(req.offerId, req.disk);
    // Not a limit: the market moved. A plain Error keeps "Blocked by vast-mcp limits" for real limits.
    if (!offer) throw new Error(`Offer ${req.offerId} is no longer available. Search again.`);
    await this.checkBudget(offer.dph_total, req.hours, { newInstance: true });
    const quote: Quote = {
      ...req,
      quoteId: crypto.randomUUID(),
      offer,
      pricePerHour: offer.dph_total,
      maxCost: offer.dph_total * req.hours,
      createdAt: this.now(),
    };
    await this.store.putQuote(this.owner, quote, QUOTE_TTL_MS);
    return quote;
  }

  // Validates a quote at rent time and consumes it, pass or fail. Re-checks the
  // live price, because offers are single-use and prices move.
  async redeem(quoteId: string): Promise<{ quote: Quote; offer: Offer }> {
    this.assertWritable();
    const quote = await this.store.takeQuote(this.owner, quoteId);
    if (!quote) throw new PolicyError("Unknown or already used quote. Call quote_rental first.");
    if (this.now() - quote.createdAt > QUOTE_TTL_MS) throw new PolicyError("Quote expired (10 minutes). Call quote_rental again.");
    const offer = await this.client.getOffer(quote.offerId, quote.disk);
    if (!offer) throw new Error(`Offer ${quote.offerId} was taken. Nothing was rented or charged. Search again and get a new quote.`);
    if (offer.dph_total > quote.pricePerHour * PRICE_SLACK) {
      throw new PolicyError(
        `Price rose from $${quote.pricePerHour.toFixed(3)} to $${offer.dph_total.toFixed(3)}/hr. Get a new quote and confirm with the user.`,
      );
    }
    await this.checkBudget(offer.dph_total, quote.hours, { newInstance: true });
    return { quote, offer };
  }

  recordRental(pricePerHour: number, hours: number): Promise<void> {
    return this.store.addSpend(this.owner, pricePerHour * hours, this.now());
  }

  // Second line of defense behind the on-instance timer: destroy any vast-mcp
  // instance whose time limit passed (plus a grace period) while it still exists.
  async sweepExpired(graceSeconds = 600): Promise<number[]> {
    if (this.limits.readOnly) return [];
    const nowSec = Math.floor(this.now() / 1000);
    const destroyed: number[] = [];
    for (const inst of await this.managedInstances()) {
      const managed = parseLabel(inst.label)!;
      if (nowSec > managed.expiresAt + graceSeconds) {
        await this.client.destroyInstance(inst.id);
        destroyed.push(inst.id);
      }
    }
    return destroyed;
  }
}
