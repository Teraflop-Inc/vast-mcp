import { describe, expect, it } from "vitest";
import type { Limits } from "../src/config.js";
import { buildOnstart, Guard, makeLabel, parseLabel, PolicyError } from "../src/guard.js";
import { MemoryStore } from "../src/store.js";
import type { Instance, Offer, VastClient } from "../src/vast.js";

const limits: Limits = { maxPricePerHour: 1, maxTotalPerHour: 1.5, maxInstances: 2, maxHours: 2, maxSessionSpend: 3, readOnly: false };

function offer(id: number, dph: number): Offer {
  return { id, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24000, dph_total: dph };
}

function fakeClient(state: { offers: Offer[]; instances: Instance[]; destroyed?: number[] }) {
  return {
    getOffer: async (id: number) => state.offers.find((o) => o.id === id),
    listInstances: async () => state.instances,
    destroyInstance: async (id: number) => {
      (state.destroyed ??= []).push(id);
    },
  } as unknown as VastClient;
}

const req = (offerId: number, hours = 1) => ({ offerId, hours, image: "img", disk: 32, name: "t", destroyOnExit: false });

describe("labels", () => {
  it("round-trips name and expiry", () => {
    expect(parseLabel(makeLabel("my job!", 123))).toEqual({ name: "my-job-", expiresAt: 123 });
  });
  it("ignores labels it did not make", () => {
    expect(parseLabel("someone-else")).toBeUndefined();
    expect(parseLabel(null)).toBeUndefined();
  });
});

describe("Guard", () => {
  it("quotes then redeems once", async () => {
    const g = new Guard(limits, fakeClient({ offers: [offer(1, 0.4)], instances: [] }));
    const q = await g.quote(req(1, 2));
    expect(q.maxCost).toBeCloseTo(0.8);
    await g.redeem(q.quoteId);
    await expect(g.redeem(q.quoteId)).rejects.toThrow(/already used/);
  });

  it("reports a vanished offer as unavailable, not as a limit", async () => {
    const g = new Guard(limits, fakeClient({ offers: [], instances: [] }));
    const err = await g.quote(req(1)).catch((e) => e);
    expect(err).not.toBeInstanceOf(PolicyError);
    expect(err.message).toMatch(/no longer available/);
  });

  it("blocks a GPU over the per-hour price limit", async () => {
    const g = new Guard(limits, fakeClient({ offers: [offer(1, 1.2)], instances: [] }));
    await expect(g.quote(req(1))).rejects.toThrow(PolicyError);
  });

  it("blocks a time limit over max hours", async () => {
    const g = new Guard(limits, fakeClient({ offers: [offer(1, 0.4)], instances: [] }));
    await expect(g.quote(req(1, 3))).rejects.toThrow(/time limit/);
  });

  it("blocks when session spend would pass the cap", async () => {
    const g = new Guard(limits, fakeClient({ offers: [offer(1, 0.9)], instances: [] }));
    await g.recordRental(0.9, 2);
    await expect(g.quote(req(1, 2))).rejects.toThrow(/session spend/);
  });

  it("blocks past max instances and total hourly", async () => {
    const running = (id: number, dph: number): Instance => ({ id, actual_status: "running", label: makeLabel("x", 9e9), dph_total: dph });
    const full = new Guard(limits, fakeClient({ offers: [offer(1, 0.1)], instances: [running(10, 0.1), running(11, 0.1)] }));
    await expect(full.quote(req(1))).rejects.toThrow(/MAX_INSTANCES/);
    const pricey = new Guard(limits, fakeClient({ offers: [offer(1, 0.6)], instances: [running(10, 1.0)] }));
    await expect(pricey.quote(req(1))).rejects.toThrow(/TOTAL_PER_HOUR/);
  });

  it("rejects a quote when the live price rose", async () => {
    const state = { offers: [offer(1, 0.4)], instances: [] as Instance[] };
    const g = new Guard(limits, fakeClient(state));
    const q = await g.quote(req(1));
    state.offers = [offer(1, 0.5)];
    await expect(g.redeem(q.quoteId)).rejects.toThrow(/Price rose/);
  });

  it("rejects an expired quote", async () => {
    let t = 0;
    const g = new Guard(limits, fakeClient({ offers: [offer(1, 0.4)], instances: [] }), { now: () => t });
    const q = await g.quote(req(1));
    t = 11 * 60 * 1000;
    await expect(g.redeem(q.quoteId)).rejects.toThrow(/expired/);
  });

  it("never lets one user redeem another user's quote", async () => {
    const store = new MemoryStore();
    const client = fakeClient({ offers: [offer(1, 0.4)], instances: [] });
    const alice = new Guard(limits, client, { store, owner: "alice" });
    const bob = new Guard(limits, client, { store, owner: "bob" });
    const q = await alice.quote(req(1));
    await expect(bob.redeem(q.quoteId)).rejects.toThrow(/Unknown or already used/);
    await expect(alice.redeem(q.quoteId)).resolves.toBeDefined();
  });

  it("keeps each user's spend separate and counts it over a rolling window", async () => {
    let t = 0;
    const store = new MemoryStore(() => t);
    const client = fakeClient({ offers: [offer(1, 0.9)], instances: [] });
    const day = 24 * 3600 * 1000;
    const alice = new Guard(limits, client, { store, owner: "alice", spendWindowMs: day, now: () => t });
    const bob = new Guard(limits, client, { store, owner: "bob", spendWindowMs: day, now: () => t });
    await alice.recordRental(0.9, 2);
    await expect(alice.quote(req(1, 2))).rejects.toThrow(/session spend/);
    await expect(bob.quote(req(1, 2))).resolves.toBeDefined();
    t = day + 1;
    await expect(alice.quote(req(1, 2))).resolves.toBeDefined();
  });

  it("read-only mode blocks renting", async () => {
    const g = new Guard({ ...limits, readOnly: true }, fakeClient({ offers: [offer(1, 0.4)], instances: [] }));
    await expect(g.quote(req(1))).rejects.toThrow(/Read-only/);
  });

  it("refuses to manage instances it did not create", () => {
    const g = new Guard(limits, fakeClient({ offers: [], instances: [] }));
    expect(() => g.assertManaged({ id: 5, actual_status: "running", label: "prod-db" })).toThrow(/not created by vast-mcp/);
  });

  it("sweeps only expired vast-mcp instances", async () => {
    const state = {
      offers: [],
      destroyed: [] as number[],
      instances: [
        { id: 1, actual_status: "running", label: makeLabel("old", 100) },
        { id: 2, actual_status: "running", label: makeLabel("new", 10_000) },
        { id: 3, actual_status: "running", label: "not-ours" },
      ] as Instance[],
    };
    const g = new Guard(limits, fakeClient(state), { now: () => 2000 * 1000 });
    expect(await g.sweepExpired(600)).toEqual([1]);
    expect(state.destroyed).toEqual([1]);
  });
});

describe("buildOnstart", () => {
  it("always arms the self-destroy timer", () => {
    const s = buildOnstart({ expiresAt: 1_900_000_000, destroyOnExit: false, apiUrl: "https://console.vast.ai" });
    // Counts down to a fixed time, so a restart can't extend it.
    expect(s).toContain("left=$((1900000000 - $(date +%s)))");
    expect(s).toContain("CONTAINER_API_KEY");
    expect(s).not.toContain("vast-mcp-job.sh");
  });
  it("destroys after the command only when asked", () => {
    const keep = buildOnstart({ expiresAt: 1, command: "nvidia-smi", destroyOnExit: false, apiUrl: "u" });
    const kill = buildOnstart({ expiresAt: 1, command: "nvidia-smi", destroyOnExit: true, apiUrl: "u" });
    expect(keep).toContain("nvidia-smi");
    expect(keep).not.toContain("job finished, destroying");
    expect(kill).toContain("job finished, destroying");
  });
  it("keeps the whole command inside the job file, even a line that looks like the delimiter", () => {
    const s = buildOnstart({ expiresAt: 1, command: "echo a\nVASTMCPJOB\necho b", destroyOnExit: false, apiUrl: "u" });
    const eof = /<<'(VASTMCPJOB_[0-9a-f]+)'/.exec(s)![1];
    expect(s.split("\n").filter((l) => l === eof)).toHaveLength(1);
  });
});

describe("buildOnstart warnings", () => {
  it("warns in the instance log when the timer has no way to call the API", () => {
    expect(buildOnstart({ expiresAt: 1, destroyOnExit: false, apiUrl: "u" })).toContain("neither curl nor python3");
  });
});
