import type { FieldKind } from "../fields/registry.js";
import type { LocaleDef } from "../locales/table.js";
import { countChars } from "../util/chars.js";
import type { TranslateRequest } from "./types.js";

export const SYSTEM_PROMPT = [
  "You localize app store listings (Google Play and the App Store) for native speakers of the target language.",
  "Write the way a native copywriter in the target market would: natural, idiomatic and persuasive, not word-for-word.",
  "Keep the meaning, features and claims of the source. Do not invent features, numbers, awards or prices, and do not add emojis the source does not have.",
  "Preserve line breaks, bullet characters and paragraph structure.",
  "Every field has a maximum length in Unicode characters; stay within it.",
  'Leave every term from the "do not translate" list exactly as written.',
  "Answer with a JSON object only.",
].join("\n");

const KEYWORDS_NOTE =
  "App Store search keywords: choose words people in the target market actually search for, not a literal translation. " +
  "Comma-separated with no spaces after commas, no repeated words, and no words already in the app name or subtitle.";

export function buildTranslatePrompt(req: TranslateRequest): string {
  const storeName = req.store === "play" ? "Google Play" : "App Store";
  const fields = Object.fromEntries(
    req.fields.map((f) => [
      f.key,
      { text: f.text, maxChars: f.maxChars, ...(f.kind === "keywords" ? { note: KEYWORDS_NOTE } : {}) },
    ]),
  );
  const terms = Object.entries(req.terms);
  const keys = req.fields.map((f) => f.key);

  return [
    `Localize these ${storeName} listing fields from ${req.sourceLocale.name} (${req.sourceLocale.code}) into ${req.targetLocale.name} (${req.targetLocale.code}).`,
    req.context ? `App context: ${req.context}` : "",
    req.doNotTranslate.length > 0 ? `Do not translate: ${req.doNotTranslate.join(", ")}` : "",
    terms.length > 0
      ? `Preferred terms in ${req.targetLocale.name}:\n${terms.map(([from, to]) => `- "${from}" → "${to}"`).join("\n")}`
      : "",
    `Fields:\n${JSON.stringify(fields, null, 2)}`,
    `Return a JSON object with exactly these keys: ${keys.join(", ")}. Each value is the localized text as a string.`,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

export function buildShortenPrompt(args: {
  text: string;
  maxChars: number;
  language: LocaleDef;
  kind: FieldKind;
  doNotTranslate: string[];
}): string {
  const format = args.kind === "keywords" ? " and the keyword format: comma-separated with no spaces after commas" : "";
  return [
    `This ${args.language.name} app store text is ${countChars(args.text)} characters, but the limit is ${args.maxChars}.`,
    `Rewrite it in ${args.language.name} to at most ${args.maxChars} characters, keeping the most important meaning${format}.`,
    args.doNotTranslate.length > 0 ? `Do not translate: ${args.doNotTranslate.join(", ")}` : "",
    `Text:\n${args.text}`,
    'Return a JSON object with one key, "text".',
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}
