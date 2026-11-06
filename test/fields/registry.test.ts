import { describe, expect, it } from "vitest";
import { FIELDS, fieldsFor, getField } from "../../src/fields/registry.js";

describe("field registry", () => {
  it("has the Google Play limits from the spec", () => {
    expect(getField("play", "title").maxChars).toBe(30);
    expect(getField("play", "short_description").maxChars).toBe(80);
    expect(getField("play", "full_description").maxChars).toBe(4000);
    expect(getField("play", "changelog").maxChars).toBe(500);
    expect(getField("play", "video").translatable).toBe(false);
  });

  it("has the App Store limits from the spec", () => {
    expect(getField("appstore", "name").maxChars).toBe(30);
    expect(getField("appstore", "subtitle").maxChars).toBe(30);
    expect(getField("appstore", "keywords").maxChars).toBe(100);
    expect(getField("appstore", "keywords").kind).toBe("keywords");
    expect(getField("appstore", "promotional_text").maxChars).toBe(170);
    expect(getField("appstore", "description").maxChars).toBe(4000);
    expect(getField("appstore", "release_notes").maxChars).toBe(4000);
  });

  it("never translates URL fields", () => {
    for (const f of FIELDS.filter((x) => x.kind === "url")) {
      expect(f.translatable).toBe(false);
      expect(f.maxChars).toBeNull();
    }
  });

  it("marks the core listing fields as required", () => {
    const required = FIELDS.filter((f) => f.required).map((f) => `${f.store}/${f.key}`);
    expect(required.sort()).toEqual(
      [
        "appstore/description",
        "appstore/keywords",
        "appstore/name",
        "play/full_description",
        "play/short_description",
        "play/title",
      ].sort(),
    );
  });

  it("filters by store and has unique keys per store", () => {
    const play = fieldsFor("play");
    expect(play.every((f) => f.store === "play")).toBe(true);
    expect(new Set(play.map((f) => f.key)).size).toBe(play.length);
  });

  it("throws on unknown field", () => {
    expect(() => getField("play", "nope")).toThrow("Unknown field play/nope");
  });
});
