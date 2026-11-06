import { describe, expect, it } from "vitest";
import { computeDiff, formatDiff } from "../../src/stores/diff.js";
import type { StoreListing } from "../../src/stores/types.js";

const REQUIRED = ["title", "short_description", "full_description"];
const remote: StoreListing[] = [
  { locale: "en-US", fields: { title: "Prayer Times", short_description: "Accurate", full_description: "Long", video: "v" } },
  { locale: "fr-FR", fields: { title: "Heures" } },
];

describe("computeDiff", () => {
  it("finds nothing when values match ignoring trailing newlines", () => {
    const local = [{ locale: "en-US", fields: { title: "Prayer Times\n\n", short_description: "Accurate" } }];
    expect(computeDiff(local, remote, REQUIRED)).toEqual({ diffs: [], problems: [] });
  });

  it("reports changed fields and merges them over the remote listing", () => {
    const local = [{ locale: "en-US", fields: { title: "Prayer Times Pro\n" } }];
    expect(computeDiff(local, remote, REQUIRED)).toEqual({
      problems: [],
      diffs: [
        {
          locale: "en-US",
          isNew: false,
          changes: [{ field: "title", from: "Prayer Times", to: "Prayer Times Pro" }],
          merged: {
            locale: "en-US",
            fields: { title: "Prayer Times Pro", short_description: "Accurate", full_description: "Long", video: "v" },
          },
        },
      ],
    });
  });

  it("creates a new listing when every required field is present", () => {
    const local = [{ locale: "ru-RU", fields: { title: "Т", short_description: "К", full_description: "П" } }];
    const { diffs, problems } = computeDiff(local, remote, REQUIRED);
    expect(problems).toEqual([]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.isNew).toBe(true);
    expect(diffs[0]!.changes.map((c) => [c.field, c.from])).toEqual([
      ["title", undefined],
      ["short_description", undefined],
      ["full_description", undefined],
    ]);
  });

  it("refuses a new listing that lacks required fields", () => {
    const local = [{ locale: "ru-RU", fields: { title: "Т" } }];
    expect(computeDiff(local, remote, REQUIRED)).toEqual({
      diffs: [],
      problems: [{ locale: "ru-RU", message: "a new listing needs short_description, full_description" }],
    });
  });

  it("ignores remote-only locales", () => {
    expect(computeDiff([], remote, REQUIRED)).toEqual({ diffs: [], problems: [] });
  });
});

describe("formatDiff", () => {
  it("prints one line per change with short previews", () => {
    const long = "x".repeat(80);
    const lines = formatDiff([
      {
        locale: "en-US",
        isNew: false,
        changes: [{ field: "title", from: "Prayer Times", to: "Prayer Times Pro" }],
        merged: { locale: "en-US", fields: {} },
      },
      {
        locale: "ru-RU",
        isNew: true,
        changes: [{ field: "full_description", from: undefined, to: long }],
        merged: { locale: "ru-RU", fields: {} },
      },
    ]);
    expect(lines).toEqual([
      "en-US:",
      '  title: "Prayer Times" → "Prayer Times Pro"',
      "ru-RU (new listing):",
      `  full_description: (empty) → "${"x".repeat(57)}..."`,
    ]);
  });
});
