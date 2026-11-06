import type { FieldKind, StoreId } from "../fields/registry.js";
import type { LocaleDef } from "../locales/table.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export interface FieldToTranslate {
  key: string;
  text: string;
  maxChars: number | null;
  kind: FieldKind;
}

export interface TranslateRequest {
  store: StoreId;
  sourceLocale: LocaleDef;
  targetLocale: LocaleDef;
  fields: FieldToTranslate[];
  context: string;
  doNotTranslate: string[];
  /** Preferred translations for this target locale: source term → target term. */
  terms: Record<string, string>;
}

export interface TranslateResult {
  /** Field key → final text (within limits). */
  texts: Record<string, string>;
  /** Field key → reason it could not be produced. */
  errors: Record<string, string>;
  usage: Usage;
}

export interface Translator {
  translate(req: TranslateRequest): Promise<TranslateResult>;
}

export interface LlmJsonRequest {
  system: string;
  user: string;
  /** Exact keys the JSON object must have; every value is a string. */
  keys: string[];
}

export interface LlmJsonResponse {
  /** Parsed JSON, or undefined when the model returned non-JSON. */
  data: unknown;
  usage: Usage;
}

export interface LlmClient {
  completeJson(req: LlmJsonRequest): Promise<LlmJsonResponse>;
}
