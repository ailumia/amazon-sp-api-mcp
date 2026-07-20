import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitManager } from "../src/execution/rate-limit-manager.js";
import { operation } from "./helpers.js";

afterEach(() => vi.useRealTimers());

describe("RateLimitManager", () => {
  it("paces each account, region, and operation bucket independently", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimitManager();
    const target = operation({ description: "Usage Plan: | Rate | Burst | | 2 | 1 |" });

    await limiter.acquire("one:na:orders", target);
    const queued = limiter.acquire("one:na:orders", target);
    const independent = limiter.acquire("two:na:orders", target);

    await expect(independent).resolves.toBeUndefined();
    let completed = false;
    void queued.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(queued).resolves.toBeUndefined();
  });

  it("observes dynamic rates and Retry-After throttling", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimitManager();
    const target = operation();
    limiter.observe(
      "one:na:orders",
      target,
      new Response(null, {
        status: 429,
        headers: { "retry-after": "1", "x-amzn-ratelimit-limit": "10" },
      }),
    );
    const queued = limiter.acquire("one:na:orders", target);
    await vi.advanceTimersByTimeAsync(999);
    let completed = false;
    void queued.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(queued).resolves.toBeUndefined();
  });
});
