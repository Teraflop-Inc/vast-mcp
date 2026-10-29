import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { Guard, makeLabel } from "../src/guard.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { createServer } from "../src/server.js";
import { VastClient } from "../src/vast.js";

const OFFER = { id: 1, gpu_name: "RTX 3060", num_gpus: 1, gpu_ram: 12000, dph_total: 0.07 };

// A fake Vast API. `statuses` is what the instance reports on successive list calls.
async function harness(opts: { statuses?: (string | null)[]; logs?: string; rentResponse?: Response } = {}) {
  let t = 0;
  let listCalls = 0;
  const statuses = opts.statuses ?? ["running"];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
    if (url.pathname === "/api/v1/instances/") {
      const s = statuses[Math.min(listCalls++, statuses.length - 1)];
      return ok({ instances: [{ id: 7, actual_status: s, label: makeLabel("t", 9e9), dph_total: 0.07 }] });
    }
    if (url.pathname === "/api/v0/bundles/") return ok({ offers: [OFFER] });
    if (url.pathname.startsWith("/api/v0/asks/")) return opts.rentResponse ?? ok({ success: true, new_contract: 7 });
    if (url.pathname.startsWith("/api/v0/instances/request_logs/")) return ok({ result_url: "https://logs.test/x" });
    if (url.hostname === "logs.test") return new Response(opts.logs ?? "hello", { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const client = new VastClient("k", fakeFetch, "https://vast.test");
  const now = () => t;
  const server = createServer({
    client,
    guard: new Guard(DEFAULT_LIMITS, client, { now }),
    audit: () => {},
    apiUrl: "https://vast.test",
    now,
    sleep: async (ms) => {
      t += ms;
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "t", version: "0" });
  await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: Boolean(r.isError), text: r.content[0].text };
  };
  return { call, listCalls: () => listCalls };
}

describe("get_instance wait_seconds", () => {
  it("waits until the instance is running", async () => {
    const h = await harness({ statuses: [null, "loading", "loading", "running"] });
    const r = await h.call("get_instance", { instance_id: 7, wait_seconds: 50 });
    expect(JSON.parse(r.text).status).toBe("running");
  });

  it("gives up at the deadline and reports the current status", async () => {
    const h = await harness({ statuses: ["loading"] });
    const r = await h.call("get_instance", { instance_id: 7, wait_seconds: 30 });
    expect(JSON.parse(r.text).status).toBe("loading");
  });

  it("checks once without wait_seconds", async () => {
    const h = await harness({ statuses: ["loading", "running"] });
    const before = h.listCalls();
    await h.call("get_instance", { instance_id: 7 });
    // One list call for the expiry sweep, one for the lookup.
    expect(h.listCalls() - before).toBe(2);
  });
});

describe("clear messages for common states", () => {
  it("says the box has not started instead of a raw docker error", async () => {
    const h = await harness({ logs: "Error response from daemon: No such container: C.7" });
    const r = await h.call("instance_logs", { instance_id: 7 });
    expect(r.text).toMatch(/no container yet/);
  });

  it("says an offer was taken, with nothing charged", async () => {
    const taken = new Response(JSON.stringify({ success: false, error: "invalid_args", msg: "error 404/3603: no_such_ask" }), { status: 400 });
    const h = await harness({ statuses: [], rentResponse: taken });
    const q = await h.call("quote_rental", { offer_id: 1, hours: 1, name: "t" });
    const r = await h.call("rent_gpu", { quote_id: JSON.parse(q.text).quote_id });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/taken by someone else.*Nothing was rented or charged/);
  });
});
