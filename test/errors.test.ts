import { describe, expect, it } from "vitest";
import { ExitCode, StorelingoError, exitCodeFor } from "../src/errors.js";

describe("StorelingoError", () => {
  it("keeps code, message and hint", () => {
    const err = new StorelingoError("E_LIMIT", "too long", "shorten it");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("E_LIMIT");
    expect(err.message).toBe("too long");
    expect(err.hint).toBe("shorten it");
    expect(err.name).toBe("StorelingoError");
  });
});

describe("exitCodeFor", () => {
  it("maps config and usage errors to 2", () => {
    expect(exitCodeFor(new StorelingoError("E_CONFIG", "x"))).toBe(ExitCode.USAGE);
    expect(exitCodeFor(new StorelingoError("E_USAGE", "x"))).toBe(ExitCode.USAGE);
  });
  it("maps other storelingo errors and unknown errors to 1", () => {
    expect(exitCodeFor(new StorelingoError("E_TRANSLATOR", "x"))).toBe(ExitCode.FAILED);
    expect(exitCodeFor(new Error("boom"))).toBe(ExitCode.FAILED);
  });
});
