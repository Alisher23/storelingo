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
 * Decides whether an OpenAI-compatible baseUrl may be used and which API key it gets, so an
 * untrusted config file can neither redirect a credential nor send texts to an arbitrary server:
 * - api.openai.com: OPENAI_API_KEY (and only there).
 * - loopback (localhost, 127.0.0.1, [::1]): allowed; no key unless STORELINGO_TRANSLATOR_API_KEY
 *   is set and STORELINGO_TRANSLATOR_API_HOST names that host.
 * - any other host: STORELINGO_TRANSLATOR_API_HOST must equal the baseUrl hostname (compared
 *   lowercased and trimmed) even when no key is set; STORELINGO_TRANSLATOR_API_KEY is sent there.
 * Anything else throws E_CONFIG. OPENAI_API_KEY and STORELINGO_TRANSLATOR_API_KEY never fall back
 * to one another.
 */
export function resolveOpenAiKey(baseUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  const host = parseBaseUrl(baseUrl).hostname;
  if (host === "api.openai.com") return env.OPENAI_API_KEY;

  const allowedHost = env.STORELINGO_TRANSLATOR_API_HOST?.trim().toLowerCase();
  const hostAllowed = host !== "" && allowedHost === host;
  const hint = host
    ? `Set STORELINGO_TRANSLATOR_API_HOST=${host} to allow it (current baseUrl host: ${host}).`
    : "translator.baseUrl must name a host.";
  if (!hostAllowed && !LOOPBACK_HOSTS.has(host)) {
    throw new StorelingoError(
      "E_CONFIG",
      "translator.baseUrl points to a host that STORELINGO_TRANSLATOR_API_HOST does not allow",
      hint,
    );
  }

  const key = env.STORELINGO_TRANSLATOR_API_KEY;
  if (!key) return undefined;
  if (hostAllowed) return key;
  throw new StorelingoError(
    "E_CONFIG",
    "STORELINGO_TRANSLATOR_API_KEY is only sent to the host named in STORELINGO_TRANSLATOR_API_HOST",
    hint,
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
  const httpOk = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !httpOk) {
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
