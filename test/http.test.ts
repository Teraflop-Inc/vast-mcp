import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createHttpHandler } from "../src/http.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { MemoryStore } from "../src/store.js";

const OFFER = { id: 1, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24000, dph_total: 0.3 };

function setup(limits: Partial<typeof DEFAULT_LIMITS> = {}) {
  const vastCalls: { method: string; path: string; auth: string | null }[] = [];
  const auditLines: string[] = [];
  const fakeVast = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    vastCalls.push({ method, path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
    const body = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url.pathname === "/api/v0/users/current/") return body({ credit: 12.5 });
    if (url.pathname === "/api/v1/instances/") return body({ instances: [] });
    if (url.pathname === "/api/v0/bundles/") return body({ offers: [OFFER] });
    if (url.pathname === "/api/v0/asks/1/") {
      // Renting takes a moment, which is when parallel rentals used to slip past the caps.
      await new Promise((r) => setTimeout(r, 20));
      return body({ success: true, new_contract: 99 });
    }
    return new Response("not found", { status: 404 });
  };
  const handler = createHttpHandler({
    store: new MemoryStore(),
    apiUrl: "https://vast.test",
    limits: { ...DEFAULT_LIMITS, maxPricePerHour: 0.5, ...limits },
    audit: (line) => auditLines.push(line),
    fetch: fakeVast,
  });

  async function connect(key: string) {
    const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: (input, init) => handler(new Request(input, init)),
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = res.content.map((c) => c.text).join("\n");
      return { isError: Boolean(res.isError), text, data: text.startsWith("{") ? JSON.parse(text) : undefined };
    };
    return { client, call };
  }

  return { handler, connect, vastCalls, auditLines };
}

describe("hosted HTTP mode", () => {
  it("asks for a credential and answers health checks", async () => {
    const { handler } = setup();
    const res = await handler(new Request("http://mcp.test/mcp", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await handler(new Request("http://mcp.test/health"))).status).toBe(200);
  });

  it("calls Vast with each user's own key and applies the server's limits", async () => {
    const { connect, vastCalls } = setup();
    const { call } = await connect("key-alice");
    const status = await call("account_status");
    expect(status.data.credit_usd).toBe(12.5);
    expect(status.data.limits.max_price_per_hour).toBe(0.5);
    expect(vastCalls.every((c) => c.auth === "Bearer key-alice")).toBe(true);
  });

  it("runs one user's parallel rentals one at a time, so both can't pass the spend cap", async () => {
    const { connect } = setup({ maxSessionSpend: 0.5 });
    const alice = await connect("key-alice");
    const q1 = await alice.call("quote_rental", { offer_id: 1, hours: 1, name: "a" });
    const q2 = await alice.call("quote_rental", { offer_id: 1, hours: 1, name: "b" });
    const results = await Promise.all([
      alice.call("rent_gpu", { quote_id: q1.data.quote_id }),
      alice.call("rent_gpu", { quote_id: q2.data.quote_id }),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(results.find((r) => r.isError)?.text).toMatch(/session spend/);
  });

  it("keeps quotes per user and never logs the key", async () => {
    const { connect, auditLines } = setup();
    const alice = await connect("key-alice");
    const bob = await connect("key-bob");
    const quote = await alice.call("quote_rental", { offer_id: 1, hours: 1, name: "t" });
    expect(quote.isError).toBe(false);

    const stolen = await bob.call("rent_gpu", { quote_id: quote.data.quote_id });
    expect(stolen.isError).toBe(true);
    expect(stolen.text).toMatch(/Unknown or already used quote/);

    const rent = await alice.call("rent_gpu", { quote_id: quote.data.quote_id });
    expect(rent.data.instance_id).toBe(99);
    expect(rent.data.session_spend_committed_usd).toBe(0.3);

    expect(auditLines.some((l) => JSON.parse(l).event === "rent")).toBe(true);
    expect(auditLines.join("\n")).not.toMatch(/key-alice|key-bob/);
  });
});
