import { describe, expect, it, vi } from "vitest";
import { findLocale } from "../../src/locales/table.js";
import { createTranslator } from "../../src/translate/engine.js";
import type { LlmClient, LlmJsonResponse, TranslateRequest } from "../../src/translate/types.js";

const usage = { inputTokens: 10, outputTokens: 2 };
const reply = (data: unknown): LlmJsonResponse => ({ data, usage });

function fakeLlm(...responses: LlmJsonResponse[]) {
  const completeJson = vi.fn();
  for (const r of responses) completeJson.mockResolvedValueOnce(r);
  return { llm: { completeJson } as LlmClient, completeJson };
}

const base: TranslateRequest = {
  store: "appstore",
  sourceLocale: findLocale("en-US")!,
  targetLocale: findLocale("de")!,
  fields: [{ key: "name", text: "Prayer Times", maxChars: 30, kind: "text" }],
  context: "",
  doNotTranslate: [],
  terms: {},
};

describe("createTranslator", () => {
  it("returns trimmed texts and summed usage", async () => {
    const { llm, completeJson } = fakeLlm(reply({ name: "  Gebetszeiten \n" }));
    const result = await createTranslator(llm).translate(base);
    expect(result).toEqual({ texts: { name: "Gebetszeiten" }, errors: {}, usage });
    expect(completeJson.mock.calls[0]![0].keys).toEqual(["name"]);
  });

  it("strips a BOM and normalizes CRLF/CR line breaks in model output", async () => {
    const BOM = String.fromCharCode(0xfeff);
    const { llm } = fakeLlm(reply({ name: `${BOM}Gebet\r\nZeiten\rheute` }));
    const result = await createTranslator(llm).translate({
      ...base,
      fields: [{ key: "name", text: "Prayer\nTimes\ntoday", maxChars: 30, kind: "text" }],
    });
    expect(result.texts.name).toBe("Gebet\nZeiten\nheute");
  });

  it("reports an empty reply for a non-empty source instead of returning it", async () => {
    const { llm } = fakeLlm(reply({ name: " \n " }));
    const result = await createTranslator(llm).translate(base);
    expect(result.texts).toEqual({});
    expect(result.errors.name).toBe("empty translation");
  });

  it("retries once on an invalid response", async () => {
    const { llm, completeJson } = fakeLlm(reply(undefined), reply({ name: "Gebetszeiten" }));
    const result = await createTranslator(llm).translate(base);
    expect(result.texts.name).toBe("Gebetszeiten");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 4 });
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("rejects responses with missing or extra keys, then fails after the retry", async () => {
    const { llm } = fakeLlm(reply({ wrong: "x" }), reply({ name: "x", extra: "y" }));
    await expect(createTranslator(llm).translate(base)).rejects.toMatchObject({ code: "E_TRANSLATOR" });
  });

  it("shortens an over-limit field", async () => {
    const { llm, completeJson } = fakeLlm(
      reply({ name: "Gebetszeiten und Qibla-Kompass für Muslime" }),
      reply({ text: "Gebetszeiten & Qibla" }),
    );
    const result = await createTranslator(llm).translate(base);
    expect(result.texts.name).toBe("Gebetszeiten & Qibla");
    expect(completeJson.mock.calls[1]![0].keys).toEqual(["text"]);
    expect(completeJson.mock.calls[1]![0].user).toContain("at most 30 characters");
  });

  it("reports E_LIMIT-style error after two failed shortenings and never truncates", async () => {
    const long = "x".repeat(40);
    const { llm, completeJson } = fakeLlm(reply({ name: long }), reply({ text: long }), reply({ text: long }));
    const result = await createTranslator(llm).translate(base);
    expect(result.texts).toEqual({});
    expect(result.errors.name).toBe("40 characters, limit is 30");
    expect(completeJson).toHaveBeenCalledTimes(3);
  });

  it("normalizes keywords and removes name/subtitle words", async () => {
    const { llm } = fakeLlm(reply({ name: "Gebet", subtitle: "Koran", keywords: "gebet , koran,qibla, qibla" }));
    const result = await createTranslator(llm).translate({
      ...base,
      fields: [
        { key: "name", text: "Prayer", maxChars: 30, kind: "text" },
        { key: "subtitle", text: "Quran", maxChars: 30, kind: "text" },
        { key: "keywords", text: "prayer,quran,qibla", maxChars: 100, kind: "keywords" },
      ],
    });
    expect(result.texts.keywords).toBe("qibla");
  });

  it("excludes only the final shortened name words from keywords", async () => {
    const { llm, completeJson } = fakeLlm(
      reply({ name: "  Gebetszeiten und Qibla Kompass für alle Muslime  ", keywords: "qibla,kompass,gebetszeiten" }),
      reply({ text: "Gebetszeiten" }),
    );
    const result = await createTranslator(llm).translate({
      ...base,
      fields: [
        { key: "name", text: "Prayer", maxChars: 30, kind: "text" },
        { key: "keywords", text: "qibla,kompass,prayer", maxChars: 100, kind: "keywords" },
      ],
    });
    expect(result.texts.name).toBe("Gebetszeiten");
    expect(result.texts.keywords).toBe("qibla,kompass");
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("does not limit fields without maxChars", async () => {
    const { llm, completeJson } = fakeLlm(reply({ name: "y".repeat(100) }));
    const result = await createTranslator(llm).translate({
      ...base,
      fields: [{ key: "name", text: "x", maxChars: null, kind: "text" }],
    });
    expect(result.texts.name).toHaveLength(100);
    expect(completeJson).toHaveBeenCalledTimes(1);
  });
});
