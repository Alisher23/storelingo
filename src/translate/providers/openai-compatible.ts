import { StorelingoError } from "../../errors.js";
import { RetryableError, withRetry } from "../../util/retry.js";
import type { LlmClient } from "../types.js";

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_TIMEOUT_MS = 120_000;

function retryAfterMs(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export function createOpenAiCompatibleLlm(opts: {
  apiKey?: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout, including reading the body. */
  timeoutMs?: number;
}): LlmClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async completeJson({ system, user, keys }) {
      const body = JSON.stringify({
        model: opts.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${user}\n\nRespond with a JSON object with keys: ${keys.join(", ")}.` },
        ],
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

      const completion = await withRetry(
        async () => {
          const signal = AbortSignal.timeout(timeoutMs);
          const timedOut = () => new RetryableError(`request timed out after ${timeoutMs / 1000}s`);
          let res: Response;
          try {
            res = await fetchImpl(url, { method: "POST", headers, body, signal });
          } catch (err) {
            if (signal.aborted) throw timedOut();
            throw new RetryableError(`Network error: ${(err as Error).message}`);
          }
          if (res.status === 429 || res.status >= 500) {
            throw new RetryableError(`HTTP ${res.status}`, retryAfterMs(res));
          }
          // The timeout also covers reading the body.
          const readBody = async <T>(read: () => Promise<T>): Promise<T> => {
            try {
              return await read();
            } catch (err) {
              if (signal.aborted) throw timedOut();
              throw err;
            }
          };
          if (!res.ok) {
            let raw = await readBody(() => res.text());
            // Some servers echo the credential back in error bodies; never surface it.
            if (opts.apiKey) raw = raw.split(opts.apiKey).join("***");
            const text = raw.slice(0, 500);
            throw new StorelingoError("E_TRANSLATOR", `Translator API error ${res.status}: ${text}`);
          }
          return (await readBody(() => res.json())) as ChatCompletion;
        },
        { sleep: opts.sleep },
      ).catch((err: unknown) => {
        if (err instanceof RetryableError) {
          throw new StorelingoError("E_TRANSLATOR", `Translator API kept failing: ${err.message}`);
        }
        throw err;
      });

      const content = completion.choices?.[0]?.message?.content ?? "";
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch {
        data = undefined;
      }
      return {
        data,
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
