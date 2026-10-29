#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer as createNodeServer } from "node:http";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { jsonAuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { Guard } from "./guard.js";
import { createHttpHandler } from "./http.js";
import { parseLimits } from "./limits.js";
import { createServer } from "./server.js";
import { MemoryStore } from "./store.js";
import { DEFAULT_API_URL, VastClient } from "./vast.js";

async function stdio() {
  const config = loadConfig();
  mkdirSync(dirname(config.auditLogPath), { recursive: true });
  const audit = jsonAuditLog((line) => appendFileSync(config.auditLogPath, line + "\n"));
  const client = new VastClient(config.apiKey, fetch, config.apiUrl);
  const guard = new Guard(config.limits, client);
  const server = createServer({ client, guard, audit, apiUrl: config.apiUrl });
  await server.connect(new StdioServerTransport());
}

// Self-hosting under Node. Other hosts (Workers, Vercel) call createHttpHandler directly.
// The in-memory store is fine for one process; run several and they need a shared Store.
function http(port: number, host: string) {
  const handler = createHttpHandler({
    store: new MemoryStore(),
    apiUrl: process.env.VAST_API_URL ?? DEFAULT_API_URL,
    limits: parseLimits((name) => process.env[name]),
    audit: (line) => console.log(line),
  });
  const server = createNodeServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
      const response = await handler(
        new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
          method: req.method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (err) {
      console.error(`vast-mcp: ${err instanceof Error ? err.stack : err}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
  server.listen(port, host, () => console.error(`vast-mcp: listening on http://${host}:${port}/mcp`));
}

const { values } = parseArgs({
  options: {
    http: { type: "boolean", default: false },
    port: { type: "string", default: process.env.PORT ?? "8787" },
    host: { type: "string", default: "127.0.0.1" },
  },
});

try {
  if (values.http) http(Number(values.port), values.host!);
  else await stdio();
} catch (err) {
  console.error(`vast-mcp: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
