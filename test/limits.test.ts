import { describe, expect, it } from "vitest";
import { parseLimits } from "../src/limits.js";

describe("limits", () => {
  it("parses overrides and rejects bad numbers", () => {
    const env: Record<string, string> = { VAST_MCP_MAX_HOURS: "0.5", VAST_MCP_READ_ONLY: "true" };
    // Caps left unset stay off.
    expect(parseLimits((n) => env[n])).toMatchObject({ maxHours: 0.5, readOnly: true, maxPricePerHour: Infinity });
    expect(() => parseLimits((n) => (n === "VAST_MCP_MAX_HOURS" ? "-1" : undefined))).toThrow(/positive/);
  });
});
