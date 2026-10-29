import { describe, expect, it } from "vitest";
import { clampLimits, DEFAULT_LIMITS, headerName, parseLimits } from "../src/limits.js";

describe("limits", () => {
  it("maps env names to header names", () => {
    expect(headerName("VAST_MCP_MAX_PRICE_PER_HOUR")).toBe("x-vast-mcp-max-price-per-hour");
  });

  it("parses overrides and rejects bad numbers", () => {
    const env: Record<string, string> = { VAST_MCP_MAX_HOURS: "0.5", VAST_MCP_READ_ONLY: "true" };
    expect(parseLimits((n) => env[n])).toMatchObject({ maxHours: 0.5, readOnly: true, maxPricePerHour: 1 });
    expect(() => parseLimits((n) => (n === "VAST_MCP_MAX_HOURS" ? "-1" : undefined))).toThrow(/positive/);
  });

  it("lets a user lower the operator's limits but never raise them", () => {
    const ceiling = { ...DEFAULT_LIMITS, maxPricePerHour: 2 };
    const out = clampLimits({ ...ceiling, maxPricePerHour: 50, maxHours: 0.5 }, ceiling);
    expect(out.maxPricePerHour).toBe(2);
    expect(out.maxHours).toBe(0.5);
    expect(clampLimits({ ...ceiling, readOnly: false }, { ...ceiling, readOnly: true }).readOnly).toBe(true);
  });
});
