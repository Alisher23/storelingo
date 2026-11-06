import { describe, expect, it } from "vitest";
import { runPool } from "../../src/util/pool.js";

describe("runPool", () => {
  it("keeps result order and limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const results = await runPool([30, 10, 20, 5, 15], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([]);
  });
});
