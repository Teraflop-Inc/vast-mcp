import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Limits, parseLimits } from "./limits.js";

export type { Limits } from "./limits.js";

export interface Config {
  apiKey: string;
  apiUrl: string;
  auditLogPath: string;
  limits: Limits;
}

// Same places the official `vastai` CLI keeps its key, so a user who ran
// `vastai set api-key` needs no extra setup.
export function findApiKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.VAST_API_KEY) return env.VAST_API_KEY.trim();
  const candidates = [
    join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "vastai", "vast_api_key"),
    join(homedir(), ".vast_api_key"),
  ];
  for (const path of candidates) {
    try {
      const key = readFileSync(path, "utf8").trim();
      if (key) return key;
    } catch {
      // not there; try the next location
    }
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = findApiKey(env);
  if (!apiKey) {
    throw new Error(
      "No Vast API key found. Set VAST_API_KEY, or run `vastai set api-key <key>`. Get a key at https://cloud.vast.ai/manage-keys/",
    );
  }
  return {
    apiKey,
    apiUrl: env.VAST_API_URL ?? "https://console.vast.ai",
    auditLogPath: env.VAST_MCP_AUDIT_LOG ?? join(homedir(), ".vast-mcp", "audit.jsonl"),
    limits: parseLimits((name) => env[name]),
  };
}
