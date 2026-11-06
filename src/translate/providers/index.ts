import type { TranslatorConfig } from "../../config/schema.js";
import { StorelingoError } from "../../errors.js";
import type { LlmClient } from "../types.js";
import { createAnthropicLlm } from "./anthropic.js";
import { createOpenAiCompatibleLlm } from "./openai-compatible.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseBaseUrl(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    throw new StorelingoError("E_CONFIG", `translator.baseUrl is not a valid URL: ${baseUrl}`);
  }
}

/**
 * The global OPENAI_API_KEY is only ever sent to api.openai.com. Any other host gets
 * STORELINGO_TRANSLATOR_API_KEY (or no key), so a config file cannot redirect a
 * credential to a third-party host.
 */
export function resolveOpenAiKey(baseUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  return parseBaseUrl(baseUrl).hostname === "api.openai.com"
    ? env.OPENAI_API_KEY
    : env.STORELINGO_TRANSLATOR_API_KEY;
}

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
  const url = parseBaseUrl(t.baseUrl);
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new StorelingoError(
      "E_CONFIG",
      "translator.baseUrl must use https for non-local hosts",
      "Use an https:// URL (plain http is only allowed for localhost, 127.0.0.1 and [::1]).",
    );
  }
  return createOpenAiCompatibleLlm({
    apiKey: resolveOpenAiKey(t.baseUrl, env),
    baseUrl: t.baseUrl,
    model: t.model,
  });
}
