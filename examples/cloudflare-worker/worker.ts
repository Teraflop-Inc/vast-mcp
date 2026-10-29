// vast-mcp hosted on Cloudflare Workers. Run locally with `npx wrangler dev`
// from this folder after `pnpm build` at the repo root.
//
// MemoryStore lives only as long as one Worker isolate, so a quote can miss on
// another isolate. A real deployment implements Store on Durable Objects or KV.
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { createHttpHandler, DEFAULT_API_URL, MemoryStore, parseLimits } from "../../dist/hosted.js";

type Env = Record<string, string | undefined>;

let handler: ((req: Request) => Promise<Response>) | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    handler ??= createHttpHandler({
      store: new MemoryStore(),
      apiUrl: env.VAST_API_URL ?? DEFAULT_API_URL,
      ceiling: parseLimits((name) => env[name]),
      audit: (line) => console.log(line),
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    });
    return handler(req);
  },
};
