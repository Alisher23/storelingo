import { describe, expect, it } from "vitest";
import { findLocale } from "../../src/locales/table.js";
import { SYSTEM_PROMPT, buildShortenPrompt, buildTranslatePrompt } from "../../src/translate/prompt.js";
import type { TranslateRequest } from "../../src/translate/types.js";

const req: TranslateRequest = {
  store: "appstore",
  sourceLocale: findLocale("en-US")!,
  targetLocale: findLocale("ru")!,
  fields: [
    { key: "name", text: "Quran Widgets", maxChars: 30, kind: "text" },
    { key: "keywords", text: "quran,prayer", maxChars: 100, kind: "keywords" },
  ],
  context: "Prayer times app",
  doNotTranslate: ["Quran Widgets"],
  terms: { prayer: "намаз" },
};

describe("buildTranslatePrompt", () => {
  const prompt = buildTranslatePrompt(req);

  it("names store, languages and context", () => {
    expect(prompt).toContain("App Store");
    expect(prompt).toContain("English (United States) (en-US)");
    expect(prompt).toContain("Russian (ru)");
    expect(prompt).toContain("App context: Prayer times app");
  });
  it("includes glossary", () => {
    expect(prompt).toContain("Do not translate: Quran Widgets");
    expect(prompt).toContain('"prayer" → "намаз"');
  });
  it("embeds fields as JSON with limits and a keywords note", () => {
    expect(prompt).toContain('"maxChars": 30');
    expect(prompt).toContain("App Store search keywords");
    expect(prompt).toContain("exactly these keys: name, keywords");
  });
  it("omits empty sections", () => {
    const bare = buildTranslatePrompt({ ...req, context: "", doNotTranslate: [], terms: {} });
    expect(bare).not.toContain("App context:");
    expect(bare).not.toContain("Do not translate:");
    expect(bare).not.toContain("Preferred terms");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("forbids invented facts and asks for JSON", () => {
    expect(SYSTEM_PROMPT).toContain("Do not invent");
    expect(SYSTEM_PROMPT).toContain("JSON");
  });
});

describe("buildShortenPrompt", () => {
  it("states the current length and the limit", () => {
    const p = buildShortenPrompt({
      text: "Очень длинный текст",
      maxChars: 10,
      language: findLocale("ru")!,
      kind: "text",
      doNotTranslate: [],
    });
    expect(p).toContain("19 characters");
    expect(p).toContain("at most 10 characters");
    expect(p).toContain('one key, "text"');
  });
  it("mentions the keyword format for keywords", () => {
    const p = buildShortenPrompt({
      text: "a,b",
      maxChars: 2,
      language: findLocale("ru")!,
      kind: "keywords",
      doNotTranslate: [],
    });
    expect(p).toContain("comma-separated with no spaces after commas");
  });
  it("repeats the do-not-translate list", () => {
    const args = { text: "Quran Widgets x", maxChars: 5, language: findLocale("ru")!, kind: "text" as const };
    expect(buildShortenPrompt({ ...args, doNotTranslate: ["Quran Widgets"] })).toContain(
      "Do not translate: Quran Widgets",
    );
    expect(buildShortenPrompt({ ...args, doNotTranslate: [] })).not.toContain("Do not translate");
  });
});
