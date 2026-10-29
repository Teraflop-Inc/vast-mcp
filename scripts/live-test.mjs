// End-to-end test against a real Vast account. SPENDS MONEY (a few cents).
// Drives the built server over stdio the way an assistant would:
// search -> quote -> rent -> wait -> logs -> (destroy, or let the time limit destroy it).
//
//   pnpm build && node scripts/live-test.mjs            # destroy via the tool
//   node scripts/live-test.mjs --let-ttl-expire         # prove the on-instance timer destroys it
//   node scripts/live-test.mjs --http                   # same run against hosted mode (vast-mcp --http)
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { findApiKey } from "../dist/config.js";

const letTtlExpire = process.argv.includes("--let-ttl-expire");
const useHttp = process.argv.includes("--http");
const hours = letTtlExpire ? 0.1 : 0.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const maxPrice = process.env.VAST_MCP_MAX_PRICE_PER_HOUR ?? "0.4";
let httpServer;
let transport;
if (useHttp) {
  const port = "8799";
  httpServer = spawn("node", ["dist/index.js", "--http", "--port", port], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, VAST_MCP_MAX_PRICE_PER_HOUR: maxPrice },
  });
  await sleep(1500);
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${findApiKey(process.env)}` } },
  });
} else {
  transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, VAST_MCP_MAX_PRICE_PER_HOUR: maxPrice },
  });
}
const client = new Client({ name: "live-test", version: "0" });
await client.connect(transport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text).join("\n");
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return text.startsWith("{") ? JSON.parse(text) : text;
}
const log = (label, data) => console.log(`\n== ${label}\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`);

const tools = await client.listTools();
log("tools", tools.tools.map((t) => t.name).join(", "));
const account = await call("account_status");
log("account_status", account);
if (account.limits.max_price_per_hour !== Number(maxPrice)) throw new Error("price cap was not applied");

const search = await call("search_gpus", { max_price_per_hour: 0.4, min_gpu_ram_gb: 8, limit: 5 });
log("search_gpus", search);
if (!search.offers.length) throw new Error("no offers");

let instanceId;
for (const offer of search.offers) {
  try {
    const quote = await call("quote_rental", {
      offer_id: offer.offer_id,
      hours,
      name: "live-test",
      // Small image with python3 (needed by the self-destroy timer): cheap hosts can take
      // 20+ minutes to pull the default pytorch image, which tests the host, not this server.
      image: process.env.LIVE_TEST_IMAGE ?? "python:3.12-slim",
      command: "nvidia-smi --query-gpu=name,memory.total --format=csv; echo VAST_MCP_HELLO",
    });
    log("quote_rental", quote);
    const rent = await call("rent_gpu", { quote_id: quote.quote_id });
    log("rent_gpu", rent);
    instanceId = rent.instance_id;
    break;
  } catch (err) {
    console.log(`offer ${offer.offer_id} failed, trying next: ${err.message}`);
  }
}
if (!instanceId) throw new Error("could not rent any offer");

try {
  let status;
  for (let i = 0; i < 80; i++) {
    status = await call("get_instance", { instance_id: instanceId });
    console.log(`[${i}] status=${status.status} ${status.status_message ?? ""}`.slice(0, 160));
    if (status.status === "running") break;
    await sleep(15000);
  }
  if (status.status !== "running") throw new Error("instance never reached running");

  let logs = "";
  for (let i = 0; i < 12; i++) {
    logs = await call("instance_logs", { instance_id: instanceId, tail: 100 });
    if (logs.includes("VAST_MCP_HELLO")) break;
    await sleep(10000);
  }
  log("instance_logs", logs);
  console.log(logs.includes("VAST_MCP_HELLO") ? "\nPASS: command output visible in logs" : "\nFAIL: command output not in logs");

  log("blocked destroy of a non-vast-mcp instance", "(checked in unit tests)");
  log("list_instances", await call("list_instances", { only_vast_mcp: true }));
} finally {
  if (letTtlExpire) {
    console.log(`\nLeaving instance ${instanceId} for its ${hours * 60} minute time limit. Check with: vastai show instances`);
  } else {
    log("destroy_instance", await call("destroy_instance", { instance_id: instanceId }));
  }
  await client.close();
  httpServer?.kill();
}
