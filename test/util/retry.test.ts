import { describe, expect, it, vi } from "vitest";
import { RetryableError, withRetry } from "../../src/util/retry.js";

describe("withRetry", () => {
  it("returns the first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withRetry(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries RetryableError with exponential backoff", async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("429"))
      .mockRejectedValueOnce(new RetryableError("503"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, {
      baseMs: 100,
      random: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result).toBe("ok");
    expect(delays).toEqual([100, 200]);
  });

  it("honours retryAfterMs", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(new RetryableError("429", 3000)).mockResolvedValue("ok");
    await withRetry(fn, { sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([3000]);
  });

  it("gives up after the attempt limit", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("503"));
    await expect(withRetry(fn, { attempts: 3, sleep: async () => {} })).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("400"));
    await expect(withRetry(fn, { sleep: async () => {} })).rejects.toThrow("400");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
