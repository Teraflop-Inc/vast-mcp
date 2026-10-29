import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { jsonAuditLog } from "./audit.js";
import { Guard } from "./guard.js";
import type { Limits } from "./limits.js";
import { createServer } from "./server.js";
import type { Store } from "./store.js";
import { type Fetch, VastClient } from "./vast.js";

// Hosted mode as a plain (Request) => Response function, using only web-standard
// APIs, so the same code runs under Node, Cloudflare Workers, Vercel or Deno.
// Each request is stateless: the user's Vast credential arrives as a bearer token
// on every call, and quotes and spend live in `store`, keyed by a hash of it.

export interface HttpHandlerOptions {
  store: Store;
  apiUrl: string;
  // The operator's limits, applied to every user.
  limits: Limits;
  // Receives one JSON line per action, tagged with the user's hashed id. Never the credential.
  audit: (line: string) => void;
  path?: string;
  fetch?: Fetch;
  now?: () => number;
  // See ServerDeps.jsonSchemaValidator; needed on Cloudflare Workers.
  jsonSchemaValidator?: jsonSchemaValidator;
}

const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

async function ownerId(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function createHttpHandler(opts: HttpHandlerOptions): (req: Request) => Promise<Response> {
  const path = opts.path ?? "/mcp";
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));

  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json(200, { ok: true });
    if (url.pathname !== path) return json(404, { error: "not found" });

    const credential = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
    if (!credential) {
      return json(
        401,
        { error: "Missing Vast credential. Send your Vast API key as 'Authorization: Bearer <key>'." },
        { "www-authenticate": 'Bearer realm="vast-mcp"' },
      );
    }

    const owner = await ownerId(credential);
    const client = new VastClient(credential, fetchImpl, opts.apiUrl);
    const guard = new Guard(opts.limits, client, { store: opts.store, owner, spendWindowMs: SPEND_WINDOW_MS, now: opts.now });
    const audit = jsonAuditLog(opts.audit, { owner });
    const server = createServer({ client, guard, audit, apiUrl: opts.apiUrl, now: opts.now, jsonSchemaValidator: opts.jsonSchemaValidator });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close();
    }
  };
}
