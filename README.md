# vast-mcp

An MCP server that lets AI assistants (Claude Code, Claude Desktop, Cursor, Codex) find, rent and manage [Vast.ai](https://vast.ai) GPUs on your account, with spend limits built in.

> "Find the cheapest 4090, run my script on it, and shut it down when it's done."

## Install

You need Node 20+, pnpm and a Vast API key from https://cloud.vast.ai/manage-keys/. It isn't on npm, so build it from this repo:

```bash
git clone https://github.com/Teraflop-Inc/vast-mcp.git && cd vast-mcp
pnpm install && pnpm build
```

**Claude Code**

```bash
claude mcp add vast -e VAST_API_KEY=your-key -- node /path/to/vast-mcp/dist/index.js
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "vast": {
      "command": "node",
      "args": ["/path/to/vast-mcp/dist/index.js"],
      "env": { "VAST_API_KEY": "your-key" }
    }
  }
}
```

If you already ran `vastai set api-key`, you can leave out `VAST_API_KEY`.

## Tools

| Tool | What it does | Spends money |
|------|--------------|--------------|
| `search_gpus` | Find offers by GPU, memory, price, reliability. Cheapest first, verified hosts only unless asked. | No |
| `quote_rental` | Check an offer is still there and fits your limits. Returns the price and the most it can cost. | No |
| `rent_gpu` | Rent from an approved quote. | **Yes** |
| `list_instances` / `get_instance` | Status, price, SSH command, time left. | No |
| `instance_logs` | Read output, including the command you gave at rent time. | No |
| `stop_instance` / `start_instance` | Pause and resume. | Start: yes |
| `destroy_instance` | Delete the instance and stop billing. | No |
| `account_status` | Credit, your limits, what this session has committed. | No |

## Safety limits

The server enforces these itself:

- **Price check before every rental.** Renting is two steps: `quote_rental` shows the cost, and `rent_gpu` only works with a quote. The quote expires after 10 minutes and fails if the price rises more than 5%.
- **Every rental has a time limit and destroys itself.** A timer runs on the GPU box itself, so it still fires if you close your assistant, and stopping and restarting the box doesn't extend it. By default the box also destroys itself after 30 minutes with the GPU idle (`idle_minutes` on `quote_rental`). The timers need `curl` or `python3` on the image, and the idle check needs `nvidia-smi`; if they're missing, the box says so in its log. As a backup, the server destroys any of its boxes that are more than 10 minutes past their limit the next time it's used.
- **Optional spend caps**, off unless you set them by environment variable:

| Variable | Default | Meaning |
|----------|---------|---------|
| `VAST_MCP_MAX_PRICE_PER_HOUR` | none | Most one rental can cost per hour (USD) |
| `VAST_MCP_MAX_TOTAL_PER_HOUR` | none | Most all running rentals can cost per hour together |
| `VAST_MCP_MAX_INSTANCES` | none | Most rentals running at once |
| `VAST_MCP_MAX_HOURS` | none | Longest time limit allowed |
| `VAST_MCP_MAX_SESSION_SPEND` | none | Most one session can commit (price x time limit, summed) |
| `VAST_MCP_READ_ONLY` | off | Set to `1` to allow only searching and reading |

- **Only touches its own instances.** Stop, start and destroy work only on instances this server created (label starts with `vast-mcp:`). Your other instances are safe.
- **Audit log** of every quote, rental, stop, start and destroy in `~/.vast-mcp/audit.jsonl` (`VAST_MCP_AUDIT_LOG` to change).

These limits stop mistakes. They do not stop an assistant that has shell access and your key from calling the Vast API directly. For read-only use, give it a [scoped key](https://docs.vast.ai/api-reference/permissions-and-authorization) with only `instance_read`.

## Hosted mode

The same server also runs over HTTP for many users at once. Each request carries the user's Vast credential, so the server stores no keys.

```bash
node dist/index.js --http --port 8787     # serves http://127.0.0.1:8787/mcp
```

Clients send `Authorization: Bearer <vast key>`. The limits come from the server's environment variables above and apply to every user. In hosted mode, session spend means the last 24 hours, per user. The audit log goes to stdout, tagged with a hash of the credential, never the credential itself.

To run it on another platform, import the request handler. It uses only web-standard APIs and no file system:

```ts
import { createHttpHandler, MemoryStore, parseLimits, DEFAULT_API_URL } from "vast-mcp/hosted"; // via a git dependency

const handler = createHttpHandler({
  store: new MemoryStore(),       // replace with shared storage when running more than one instance
  apiUrl: DEFAULT_API_URL,
  limits: parseLimits((name) => process.env[name]),
  audit: (line) => console.log(line),
});
// handler: (Request) => Promise<Response>
```

- **Storage:** quotes and spend live in the `Store` you pass. `MemoryStore` works for one process. With several instances, or on serverless, implement `Store` (four methods) on Redis, Durable Objects or KV. Rentals for one user are serialized within a process; across processes, the store has to do it.
- **Cloudflare Workers:** pass `jsonSchemaValidator: new CfWorkerJsonSchemaValidator()` from `@modelcontextprotocol/sdk/validation/cfworker`. Workers block the default validator.
- **Sign in with Vast:** the handler sends the bearer token straight to the Vast API. Once Vast issues OAuth tokens that its API accepts, they work here unchanged. What's still needed is the OAuth metadata endpoint that points clients at Vast's sign-in.
- **Rate limits:** when Vast answers 429 (too many requests), the client waits and retries.

A Cloudflare Worker example is in `examples/cloudflare-worker`. It uses `MemoryStore`; a production deployment should use Durable Objects or KV.

## Development

```bash
pnpm install
pnpm build
pnpm test                         # unit tests, no network
node scripts/live-test.mjs        # rents a real GPU for a few cents, then destroys it
node scripts/live-test.mjs --let-ttl-expire   # leaves it for the 6-minute time limit to destroy
node scripts/live-test.mjs --http           # the same run against hosted mode
node scripts/live-matrix.mjs [--http]       # every safety limit on real GPUs: read-only, caps, stop/start, foreign boxes, idle, time limit
VAST_MCP_SECOND_KEY=... node scripts/live-two-users.mjs   # two users on one hosted server at once
sh scripts/pack-check.sh                    # builds the package file and checks an installed copy works (never publishes)
```

## License

MIT
