import { describe, expect, it } from "vitest";
import { countChars } from "../../src/util/chars.js";

describe("countChars", () => {
  it("counts ASCII characters", () => {
    expect(countChars("Hello")).toBe(5);
  });
  it("counts an emoji as one code point", () => {
    expect(countChars("hi 👋")).toBe(4);
  });
  it("counts Arabic letters", () => {
    expect(countChars("مرحبا")).toBe(5);
  });
  it("counts a combining mark as its own code point", () => {
    expect(countChars("é")).toBe(2);
  });
  it("returns 0 for an empty string", () => {
    expect(countChars("")).toBe(0);
  });
});
