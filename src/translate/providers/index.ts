import type { TranslatorConfig } from "../../config/schema.js";
import { StorelingoError } from "../../errors.js";
import type { LlmClient } from "../types.js";
import { createAnthropicLlm } from "./anthropic.js";
import { createOpenAiCompatibleLlm } from "./openai-compatible.js";

export function createLlmClient(t: TranslatorConfig, env: NodeJS.ProcessEnv): LlmClient {
  if (t.provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new StorelingoError(
        "E_CONFIG",
        "ANTHROPIC_API_KEY is not set",
        "Create an API key in the Claude Console and export it as ANTHROPIC_API_KEY.",
      );
    }
    return createAnthropicLlm({ apiKey, model: t.model, effort: t.effort });
  }
  return createOpenAiCompatibleLlm({ apiKey: env.OPENAI_API_KEY, baseUrl: t.baseUrl, model: t.model });
}
