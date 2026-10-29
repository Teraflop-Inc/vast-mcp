// Two users on one hosted server at the same time. SPENDS MONEY (a few cents).
//
//   pnpm build && VAST_MCP_SECOND_KEY=<another key> node scripts/live-two-users.mjs
//
// User A uses your normal key, user B the second key. Checks that quotes and
// spend stay per user while both rent at once, and measures whether Vast's
// rate limit is per key or per IP (both keys send from this one machine).
// With two keys on one Vast account, both users can see the same instances:
// separation between different Vast accounts comes from Vast's API itself.
import { execFileSync, spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { findApiKey } from "../dist/config.js";

const keyA = findApiKey(process.env);
const keyB = process.env.VAST_MCP_SECOND_KEY;
if (!keyB) throw new Error("Set VAST_MCP_SECOND_KEY");
const PORT = "8795";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const owned = new Set();
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

// Raw requests with no retry, to see where 429s start.
async function burst(key, n) {
  const statuses = await Promise.all(
    Array.from({ length: n }, () =>
      fetch("https://console.vast.ai/api/v0/users/current/", { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.status),
    ),
  );
  return statuses.filter((s) => s === 429).length;
}

const server = spawn("node", ["dist/index.js", "--http", "--port", PORT], { stdio: ["ignore", "ignore", "inherit"] });
await sleep(1500);

async function connect(key) {
  const client = new Client({ name: "two-users", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}`, "x-vast-mcp-max-price-per-hour": "0.2" } },
    }),
  );
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text).join("\n");
    return { isError: Boolean(res.isError), text, data: text.startsWith("{") ? JSON.parse(text) : undefined };
  };
  return { client, call };
}

const a = await connect(keyA);
const b = await connect(keyB);
try {
  // Rate limit: 8 parallel requests on each key alone, then 8 on both at once.
  const aloneA = await burst(keyA, 8);
  await sleep(5000);
  const [bothA, bothB] = await Promise.all([burst(keyA, 8), burst(keyB, 8)]);
  console.log(`rate limit: key A alone 8 req -> ${aloneA} x 429; both keys 8 req each -> A ${bothA}, B ${bothB} x 429`);
  check("rate limit measured", true, bothA + bothB > aloneA * 2 + 2 ? "looks per IP" : "looks per key");
  await sleep(5000);

  const offers = (await a.call("search_gpus", { max_price_per_hour: 0.2, min_gpu_ram_gb: 8, limit: 8 })).data.offers;
  const quoteFor = (mcp, offer) =>
    mcp.call("quote_rental", { offer_id: offer.offer_id, hours: 0.25, name: "two-users", image: "python:3.12-slim", idle_minutes: 0 });

  const qa = await quoteFor(a, offers[0]);
  const stolen = await b.call("rent_gpu", { quote_id: qa.data.quote_id });
  check("user B cannot use user A's quote", stolen.isError && /Unknown or already used/.test(stolen.text));

  // B's attempt looked up B's own quotes, so A's quote is untouched and still usable.
  let rentA;
  let rentB;
  for (let i = 1; i < offers.length && !(rentA && rentB); i++) {
    const qb = await quoteFor(b, offers[i]);
    if (qb.isError) continue;
    const [ra, rb] = await Promise.all([
      rentA ? Promise.resolve({ data: rentA }) : a.call("rent_gpu", { quote_id: qa.data.quote_id }),
      b.call("rent_gpu", { quote_id: qb.data.quote_id }),
    ]);
    if (!ra.isError && ra.data?.instance_id) {
      rentA = ra.data;
      owned.add(rentA.instance_id);
    }
    if (!rb.isError && rb.data?.instance_id) {
      rentB = rb.data;
      owned.add(rentB.instance_id);
    }
  }
  check("both users rent at the same time", Boolean(rentA && rentB), `${rentA?.instance_id} and ${rentB?.instance_id}`);

  const [sa, sb] = await Promise.all([a.call("account_status"), b.call("account_status")]);
  const spendA = sa.data.session_spend_committed_usd;
  const spendB = sb.data.session_spend_committed_usd;
  const expectA = Number((rentA.price_per_hour * 0.25).toFixed(2));
  const expectB = Number((rentB.price_per_hour * 0.25).toFixed(2));
  check("spend is tracked per user", spendA === expectA && spendB === expectB, `A $${spendA} (expected $${expectA}), B $${spendB} (expected $${expectB})`);

  const [da, db] = await Promise.all([
    a.call("destroy_instance", { instance_id: rentA.instance_id }),
    b.call("destroy_instance", { instance_id: rentB.instance_id }),
  ]);
  check("both destroy their boxes", !da.isError && !db.isError);
  if (!da.isError) owned.delete(rentA.instance_id);
  if (!db.isError) owned.delete(rentB.instance_id);
} catch (err) {
  check("ran to the end", false, err.message);
} finally {
  for (const id of owned) {
    try {
      execFileSync("vastai", ["destroy", "instance", String(id), "-y"], { stdio: "ignore" });
      console.log(`cleanup: destroyed ${id}`);
    } catch {
      console.log(`cleanup: could not destroy ${id}, check the Vast console`);
    }
  }
  await a.client.close();
  await b.client.close();
  server.kill();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
