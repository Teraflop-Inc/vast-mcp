export interface Limits {
  maxPricePerHour: number;
  maxTotalPerHour: number;
  maxInstances: number;
  maxHours: number;
  maxSessionSpend: number;
  readOnly: boolean;
}

// No caps unless the operator sets them: the user approves every price before
// renting, and the time limit and idle check stop forgotten boxes.
export const DEFAULT_LIMITS: Limits = {
  maxPricePerHour: Infinity,
  maxTotalPerHour: Infinity,
  maxInstances: Infinity,
  maxHours: Infinity,
  maxSessionSpend: Infinity,
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

function truthy(raw: string | undefined): boolean {
  return ["1", "true", "yes"].includes((raw ?? "").toLowerCase());
}

// Reads limits by env var name, falling back to `base`.
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
