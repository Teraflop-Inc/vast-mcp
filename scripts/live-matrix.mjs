// Every safety rail against a real Vast account. SPENDS MONEY (a few cents).
//
//   pnpm build && node scripts/live-matrix.mjs           # local (stdio) mode
//   node scripts/live-matrix.mjs --http                  # hosted mode
//   VAST_MCP_URL=https://.../mcp node scripts/live-matrix.mjs --http   # a deployed server
//
// Checks: read-only blocks renting, a price cap blocks a real offer, rent + logs,
// stop/start, refusal to destroy a box it didn't label, idle auto-destroy, and
// the time-limit self-destroy. Needs the `vastai` CLI (for relabeling and for
// checking boxes really disappeared) logged in to the same account.
import { execFileSync, spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { findApiKey } from "../dist/config.js";

const useHttp = process.argv.includes("--http");
const mode = useHttp ? "hosted" : "local";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const owned = new Set();
const IMAGE = "python:3.12-slim";

const remoteUrl = process.env.VAST_MCP_URL;
const httpServers = [];
let port = 8798;

// Limits are server settings, so hosted mode starts a local server for each set of limits.
async function connect(limits = {}) {
  let transport;
  if (useHttp) {
    let url = remoteUrl;
    if (!url) {
      port++;
      const env = { ...process.env, ...limits };
      httpServers.push(spawn("node", ["dist/index.js", "--http", "--port", String(port)], { stdio: ["ignore", "ignore", "inherit"], env }));
      await sleep(1500);
      url = `http://127.0.0.1:${port}/mcp`;
    }
    const headers = { authorization: `Bearer ${findApiKey(process.env)}` };
    transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  } else {
    transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, ...limits } });
  }
  const client = new Client({ name: "live-matrix", version: "0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text).join("\n");
    return { isError: Boolean(res.isError), text, data: text.startsWith("{") ? JSON.parse(text) : undefined };
  };
  return { client, call };
}

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} [${mode}] ${name}${detail ? `: ${detail}` : ""}`);
}

function vastaiInstances() {
  const out = execFileSync("vastai", ["show", "instances", "--raw"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

async function rent(mcp, { hours, idleMinutes = 0, command }) {
  const search = await mcp.call("search_gpus", { max_price_per_hour: 0.2, min_gpu_ram_gb: 8, limit: 6 });
  for (const offer of search.data?.offers ?? []) {
    const quote = await mcp.call("quote_rental", {
      offer_id: offer.offer_id, hours, name: "matrix", image: IMAGE, idle_minutes: idleMinutes, command,
    });
    if (quote.isError) continue;
    const r = await mcp.call("rent_gpu", { quote_id: quote.data.quote_id });
    if (r.isError) continue;
    owned.add(r.data.instance_id);
    return r.data.instance_id;
  }
  throw new Error(`could not rent: ${search.text.slice(0, 300)}`);
}

async function waitFor(mcp, id, statuses, maxMinutes) {
  for (let i = 0; i < maxMinutes * 4; i++) {
    const s = await mcp.call("get_instance", { instance_id: id });
    if (s.isError) return "gone";
    if (statuses.includes(s.data.status)) return s.data.status;
    await sleep(15000);
  }
  return "timeout";
}

// Polls the account directly (not through the MCP) until the box is gone.
async function waitGone(id, maxMinutes) {
  const start = Date.now();
  while (Date.now() - start < maxMinutes * 60000) {
    if (!vastaiInstances().some((i) => i.id === id)) return (Date.now() - start) / 60000;
    await sleep(20000);
  }
  return undefined;
}

const mcp = await connect({ VAST_MCP_MAX_PRICE_PER_HOUR: "0.2" });
try {
  // Read-only and the price cap need their own server settings, so a deployed server skips them.
  if (!remoteUrl) {
    const ro = await connect({ VAST_MCP_READ_ONLY: "1" });
    const offers = (await ro.call("search_gpus", { limit: 1 })).data.offers;
    const roQuote = await ro.call("quote_rental", { offer_id: offers[0].offer_id, hours: 0.1, name: "ro" });
    check("read-only allows search, blocks quote", offers.length === 1 && roQuote.isError && /Read-only/.test(roQuote.text));
    await ro.client.close();

    // Price cap against a real offer that costs more than the cap
    const capped = await connect({ VAST_MCP_MAX_PRICE_PER_HOUR: "0.01" });
    const pricey = (await capped.call("search_gpus", { limit: 1 })).data.offers[0];
    const capQuote = await capped.call("quote_rental", { offer_id: pricey.offer_id, hours: 0.1, name: "cap" });
    check("price cap blocks a real offer", capQuote.isError && /per-GPU limit/.test(capQuote.text), `offer at $${pricey.price_per_hour}/hr`);
    await capped.client.close();
  }

  // Box A: rent, logs, stop/start, foreign-label refusal, destroy
  const a = await rent(mcp, { hours: 0.5, command: "echo MATRIX_HELLO" });
  check("rent", true, `instance ${a}`);
  check("reaches running", (await waitFor(mcp, a, ["running"], 20)) === "running");
  let logs = "";
  for (let i = 0; i < 12 && !logs.includes("MATRIX_HELLO"); i++) {
    logs = (await mcp.call("instance_logs", { instance_id: a, tail: 100 })).text;
    if (!logs.includes("MATRIX_HELLO")) await sleep(10000);
  }
  check("command output in logs", logs.includes("MATRIX_HELLO"));

  const stop = await mcp.call("stop_instance", { instance_id: a });
  const stopped = await waitFor(mcp, a, ["exited", "stopped"], 5);
  check("stop", !stop.isError && (stopped === "exited" || stopped === "stopped"), stopped);
  const startRes = await mcp.call("start_instance", { instance_id: a });
  const restarted = await waitFor(mcp, a, ["running"], 10);
  check("start", !startRes.isError && restarted === "running", startRes.isError ? startRes.text : restarted);

  const label = vastaiInstances().find((i) => i.id === a).label;
  execFileSync("vastai", ["label", "instance", String(a), "someone-elses-box"], { stdio: "ignore" });
  const refusedDestroy = await mcp.call("destroy_instance", { instance_id: a });
  const refusedStop = await mcp.call("stop_instance", { instance_id: a });
  const stillThere = vastaiInstances().some((i) => i.id === a);
  check(
    "refuses to stop or destroy a box it didn't label",
    refusedDestroy.isError && refusedStop.isError && /not created by vast-mcp/.test(refusedDestroy.text) && stillThere,
  );
  execFileSync("vastai", ["label", "instance", String(a), label], { stdio: "ignore" });

  const destroyed = await mcp.call("destroy_instance", { instance_id: a });
  check("destroy", !destroyed.isError && (await waitGone(a, 3)) !== undefined);
  owned.delete(a);

  // Box B: idle auto-destroy (2 idle minutes). Box C: 6-minute time limit, idle off. Run together.
  const b = await rent(mcp, { hours: 0.5, idleMinutes: 2 });
  const c = await rent(mcp, { hours: 0.1, idleMinutes: 0 });
  const [bRun, cRun] = await Promise.all([waitFor(mcp, b, ["running"], 20), waitFor(mcp, c, ["running"], 20)]);
  // From "running": idle needs about 2-3 minutes; the 30-minute time limit is far away.
  const [bGone, cGone] = await Promise.all([bRun === "running" ? waitGone(b, 10) : undefined, cRun === "running" ? waitGone(c, 12) : undefined]);
  check("idle auto-destroy (2 min idle, 30 min limit)", bGone !== undefined, bGone === undefined ? `status ${bRun}` : `gone ${bGone.toFixed(1)} min after running`);
  check("time-limit self-destroy (6 min)", cGone !== undefined, cGone === undefined ? `status ${cRun}` : `gone ${cGone.toFixed(1)} min after running`);
  if (bGone !== undefined) owned.delete(b);
  if (cGone !== undefined) owned.delete(c);
} catch (err) {
  check("matrix ran to the end", false, err.message);
} finally {
  // Anything still alive gets destroyed here, so a failed run never leaves a box billing.
  for (const id of owned) {
    try {
      execFileSync("vastai", ["destroy", "instance", String(id), "-y"], { stdio: "ignore" });
      console.log(`cleanup: destroyed ${id}`);
    } catch {
      console.log(`cleanup: could not destroy ${id}, check the Vast console`);
    }
  }
  await mcp.client.close();
  for (const s of httpServers) s.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n[${mode}] ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
