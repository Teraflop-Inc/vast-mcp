export interface Limits {
  maxPricePerHour: number;
  maxTotalPerHour: number;
  maxInstances: number;
  maxHours: number;
  maxSessionSpend: number;
  readOnly: boolean;
}

export const DEFAULT_LIMITS: Limits = {
  maxPricePerHour: 1.0,
  maxTotalPerHour: 3.0,
  maxInstances: 2,
  maxHours: 2,
  maxSessionSpend: 10,
  readOnly: false,
};

const NAMES: Record<Exclude<keyof Limits, "readOnly">, string> = {
  maxPricePerHour: "VAST_MCP_MAX_PRICE_PER_HOUR",
  maxTotalPerHour: "VAST_MCP_MAX_TOTAL_PER_HOUR",
  maxInstances: "VAST_MCP_MAX_INSTANCES",
  maxHours: "VAST_MCP_MAX_HOURS",
  maxSessionSpend: "VAST_MCP_MAX_SESSION_SPEND",
};
const READ_ONLY = "VAST_MCP_READ_ONLY";

// The HTTP header for a setting is its env name, lowercased, dashed, with an
// "x-" prefix: VAST_MCP_MAX_HOURS -> x-vast-mcp-max-hours.
export function headerName(envName: string): string {
  return "x-" + envName.toLowerCase().replace(/_/g, "-");
}

function truthy(raw: string | undefined): boolean {
  return ["1", "true", "yes"].includes((raw ?? "").toLowerCase());
}

// Reads limits by setting name (env var or header lookup), falling back to `base`.
export function parseLimits(get: (envName: string) => string | undefined, base: Limits = DEFAULT_LIMITS): Limits {
  const out: Limits = { ...base, readOnly: base.readOnly || truthy(get(READ_ONLY)) };
  for (const [key, name] of Object.entries(NAMES) as [keyof typeof NAMES, string][]) {
    const raw = get(name);
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
    out[key] = n;
  }
  return out;
}

// A hosted server's own limits are the ceiling: a user can lower them, never raise them.
export function clampLimits(requested: Limits, ceiling: Limits): Limits {
  return {
    maxPricePerHour: Math.min(requested.maxPricePerHour, ceiling.maxPricePerHour),
    maxTotalPerHour: Math.min(requested.maxTotalPerHour, ceiling.maxTotalPerHour),
    maxInstances: Math.min(requested.maxInstances, ceiling.maxInstances),
    maxHours: Math.min(requested.maxHours, ceiling.maxHours),
    maxSessionSpend: Math.min(requested.maxSessionSpend, ceiling.maxSessionSpend),
    readOnly: requested.readOnly || ceiling.readOnly,
  };
}
