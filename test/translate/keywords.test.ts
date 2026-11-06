import { describe, expect, it } from "vitest";
import { normalizeKeywords } from "../../src/translate/keywords.js";

describe("normalizeKeywords", () => {
  it("removes spaces around commas and collapses inner spaces", () => {
    expect(normalizeKeywords(" prayer ,  quran,azan   time ")).toBe("prayer,quran,azan time");
  });
  it("drops empty items and case-insensitive duplicates", () => {
    expect(normalizeKeywords("Quran,,quran,QURAN,dua")).toBe("Quran,dua");
  });
  it("splits on full-width and ideographic commas", () => {
    expect(normalizeKeywords("祈祷，古兰经、礼拜")).toBe("祈祷,古兰经,礼拜");
  });
  it("drops single words already present in name or subtitle", () => {
    expect(normalizeKeywords("prayer,times,qibla,prayer times", ["Prayer Times", "Qibla finder"])).toBe(
      "prayer times",
    );
  });
});
