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
 * Picks the API key for an OpenAI-compatible baseUrl so an untrusted config file cannot
 * redirect a credential to a third-party host:
 * - api.openai.com: OPENAI_API_KEY (and only there).
 * - any other host: no key unless STORELINGO_TRANSLATOR_API_KEY is set. When it is set,
 *   it is sent only if the baseUrl hostname equals STORELINGO_TRANSLATOR_API_HOST
 *   (compared lowercased and trimmed); otherwise this throws E_CONFIG.
 * OPENAI_API_KEY and STORELINGO_TRANSLATOR_API_KEY never fall back to one another.
 */
export function resolveOpenAiKey(baseUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  const host = parseBaseUrl(baseUrl).hostname;
  if (host === "api.openai.com") return env.OPENAI_API_KEY;

  const key = env.STORELINGO_TRANSLATOR_API_KEY;
  if (!key) return undefined;
  if (env.STORELINGO_TRANSLATOR_API_HOST?.trim().toLowerCase() === host) return key;
  throw new StorelingoError(
    "E_CONFIG",
    "STORELINGO_TRANSLATOR_API_KEY is only sent to the host named in STORELINGO_TRANSLATOR_API_HOST",
    `Set STORELINGO_TRANSLATOR_API_HOST=${host} to allow it (current baseUrl host: ${host}).`,
  );
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
