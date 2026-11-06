import { z } from "zod";
import { StorelingoError } from "../errors.js";
import { countChars } from "../util/chars.js";
import { normalizeKeywords } from "./keywords.js";
import { SYSTEM_PROMPT, buildShortenPrompt, buildTranslatePrompt } from "./prompt.js";
import {
  ZERO_USAGE,
  addUsage,
  type FieldToTranslate,
  type LlmClient,
  type TranslateRequest,
  type TranslateResult,
  type Translator,
  type Usage,
} from "./types.js";

function responseSchema(keys: string[]) {
  return z.object(Object.fromEntries(keys.map((k) => [k, z.string()]))).strict();
}

function parseTexts(data: unknown, keys: string[]): Record<string, string> | undefined {
  const parsed = responseSchema(keys).safeParse(data);
  return parsed.success ? (parsed.data as Record<string, string>) : undefined;
}

export function createTranslator(llm: LlmClient, opts: { maxShortenAttempts?: number } = {}): Translator {
  const maxShorten = opts.maxShortenAttempts ?? 2;

  return {
    async translate(req: TranslateRequest): Promise<TranslateResult> {
      let usage: Usage = ZERO_USAGE;
      const keys = req.fields.map((f) => f.key);
      const user = buildTranslatePrompt(req);

      let raw: Record<string, string> | undefined;
      for (let attempt = 0; attempt < 2 && raw === undefined; attempt++) {
        const res = await llm.completeJson({ system: SYSTEM_PROMPT, user, keys });
        usage = addUsage(usage, res.usage);
        raw = parseTexts(res.data, keys);
      }
      if (raw === undefined) {
        throw new StorelingoError(
          "E_TRANSLATOR",
          `The model returned an invalid response twice for ${req.store}/${req.targetLocale.code}`,
          "Run translate again, or try a different model.",
        );
      }

      const nameWords = [raw.name, raw.subtitle].filter((s): s is string => s !== undefined);
      const clean = (field: FieldToTranslate, text: string): string =>
        field.kind === "keywords" ? normalizeKeywords(text.trim(), nameWords) : text.trim();

      const texts: Record<string, string> = {};
      const errors: Record<string, string> = {};

      for (const field of req.fields) {
        let text = clean(field, raw[field.key] ?? "");
        if (field.maxChars !== null) {
          for (let i = 0; i < maxShorten && countChars(text) > field.maxChars; i++) {
            const res = await llm.completeJson({
              system: SYSTEM_PROMPT,
              user: buildShortenPrompt({ text, maxChars: field.maxChars, language: req.targetLocale, kind: field.kind }),
              keys: ["text"],
            });
            usage = addUsage(usage, res.usage);
            const shorter = parseTexts(res.data, ["text"]);
            if (shorter?.text !== undefined) text = clean(field, shorter.text);
          }
          if (countChars(text) > field.maxChars) {
            errors[field.key] = `${countChars(text)} characters, limit is ${field.maxChars}`;
            continue;
          }
        }
        texts[field.key] = text;
      }

      return { texts, errors, usage };
    },
  };
}
