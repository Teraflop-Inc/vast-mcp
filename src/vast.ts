// Thin client for the Vast REST API. Request shapes mirror the official
// vast-cli (github.com/vast-ai/vast-cli, vast.py) so behavior matches `vastai`.

export const DEFAULT_API_URL = "https://console.vast.ai";

export type Fetch = typeof fetch;

export interface Offer {
  id: number;
  gpu_name: string;
  num_gpus: number;
  gpu_ram: number; // MB
  dph_total: number; // $/hour, includes storage at allocated_storage
  reliability2?: number;
  reliability?: number;
  geolocation?: string;
  cuda_max_good?: number;
  inet_down?: number;
  disk_bw?: number; // MB/s
  disk_space?: number;
  verified?: boolean;
  rentable?: boolean;
  [key: string]: unknown;
}

export interface Instance {
  id: number;
  actual_status: string | null;
  intended_status?: string | null;
  label: string | null;
  gpu_name?: string;
  num_gpus?: number;
  dph_total?: number;
  start_date?: number;
  ssh_host?: string;
  ssh_port?: number;
  image_uuid?: string;
  status_msg?: string | null;
  [key: string]: unknown;
}

export interface CreateInstanceRequest {
  image: string;
  disk: number;
  label: string;
  onstart: string;
  env?: Record<string, string>;
}

export class VastApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class VastClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl: string = DEFAULT_API_URL,
    private readonly maxRetries = 4,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
    let url = this.baseUrl + path;
    if (query) {
      url +=
        "?" +
        Object.entries(query)
          .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v))}`)
          .join("&");
    }
    // Vast rate-limits each key to about 10 requests per few seconds and answers 429
    // with retry_after (seconds). One tool call can make 3-4 requests, so wait and retry.
    let res: Response;
    let text: string;
    for (let attempt = 0; ; attempt++) {
      res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
      if (res.status !== 429 || attempt >= this.maxRetries) break;
      let waitSec = 3;
      try {
        waitSec = Number(JSON.parse(text).retry_after) || waitSec;
      } catch {
        // non-JSON 429 body; use the default wait
      }
      await new Promise((r) => setTimeout(r, Math.min(waitSec, 30) * 1000));
    }
    if (!res.ok) {
      throw new VastApiError(`Vast API ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async searchOffers(query: Record<string, unknown>): Promise<Offer[]> {
    const res = await this.request<{ offers: Offer[] }>("POST", "/api/v0/bundles/", query);
    return res.offers ?? [];
  }

  async getOffer(offerId: number, disk: number): Promise<Offer | undefined> {
    // The bundles search ignores `id`; the offer id is filterable as ask_contract_id.
    const offers = await this.searchOffers({
      ask_contract_id: { eq: offerId },
      rentable: { eq: true },
      rented: { eq: false },
      allocated_storage: disk,
      type: "on-demand",
      limit: 1,
    });
    return offers.find((o) => o.id === offerId);
  }

  async createInstance(offerId: number, req: CreateInstanceRequest): Promise<{ new_contract: number }> {
    const res = await this.request<{ success: boolean; new_contract?: number; msg?: string; error?: string }>(
      "PUT",
      `/api/v0/asks/${offerId}/`,
      {
        client_id: "me",
        image: req.image,
        env: req.env ?? {},
        disk: req.disk,
        label: req.label,
        onstart: req.onstart,
        runtype: "ssh_proxy",
        cancel_unavail: true,
      },
    );
    if (!res.success || res.new_contract === undefined) {
      throw new VastApiError(`Rent failed: ${res.msg ?? res.error ?? JSON.stringify(res)}`);
    }
    return { new_contract: res.new_contract };
  }

  async listInstances(): Promise<Instance[]> {
    const rows: Instance[] = [];
    const params: Record<string, unknown> = {
      select_filters: {},
      order_by: [{ col: "id", dir: "asc" }],
      limit: 25,
    };
    for (;;) {
      const page = await this.request<{ instances?: Instance[]; next_token?: string }>(
        "GET",
        "/api/v1/instances/",
        undefined,
        params,
      );
      rows.push(...(page.instances ?? []));
      if (!page.next_token) return rows;
      params.after_token = page.next_token;
    }
  }

  async setState(instanceId: number, state: "running" | "stopped"): Promise<void> {
    const res = await this.request<{ success: boolean; msg?: string }>("PUT", `/api/v0/instances/${instanceId}/`, { state });
    if (!res.success) throw new VastApiError(`Could not set instance ${instanceId} to ${state}: ${res.msg}`);
  }

  async destroyInstance(instanceId: number): Promise<void> {
    const res = await this.request<{ success: boolean; msg?: string }>("DELETE", `/api/v0/instances/${instanceId}/`, {});
    if (!res.success) throw new VastApiError(`Could not destroy instance ${instanceId}: ${res.msg}`);
  }

  // Logs are produced asynchronously: the API returns a URL that fills in a few seconds later.
  async getLogs(instanceId: number, tail: number, pollMs = 1000, attempts = 15): Promise<string> {
    const res = await this.request<{ result_url?: string; msg?: string }>(
      "PUT",
      `/api/v0/instances/request_logs/${instanceId}/`,
      { tail: String(tail) },
    );
    if (!res.result_url) throw new VastApiError(`No logs for instance ${instanceId}: ${res.msg ?? "unknown error"}`);
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const r = await this.fetchImpl(res.result_url);
      if (r.ok) return (await r.text()).replace(/\n\s*\n/g, "\n");
    }
    throw new VastApiError(`Logs for instance ${instanceId} were not ready in time. Try again.`);
  }

  async getUser(): Promise<{ credit: number; balance?: number; email?: string; username?: string }> {
    return this.request("GET", "/api/v0/users/current/");
  }
}
