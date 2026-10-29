import { describe, expect, it } from "vitest";
import { VastApiError, VastClient } from "../src/vast.js";

describe("VastClient", () => {
  it("waits and retries when Vast rate-limits the key", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls < 3
        ? new Response(JSON.stringify({ error: "HTTPTooManyRequests", retry_after: 0.01 }), { status: 429 })
        : new Response(JSON.stringify({ credit: 5 }), { status: 200 });
    }) as typeof fetch;
    expect((await new VastClient("k", fetchImpl).getUser()).credit).toBe(5);
    expect(calls).toBe(3);
  });

  it("gives up after its retries", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 })) as typeof fetch;
    await expect(new VastClient("k", fetchImpl, "https://x", 2).getUser()).rejects.toThrow(VastApiError);
  });
});
