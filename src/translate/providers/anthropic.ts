import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../../config/schema.js";
import { StorelingoError } from "../../errors.js";
import type { LlmClient } from "../types.js";

export function jsonSchemaFor(keys: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
    required: keys,
    additionalProperties: false,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createAnthropicLlm(opts: {
  apiKey: string;
  model: string;
  effort: Effort;
  client?: Anthropic;
}): LlmClient {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 4 });

  return {
    async completeJson({ system, user, keys }) {
      let response;
      try {
        response = await client.beta.messages.create({
          model: opts.model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system,
          messages: [{ role: "user", content: user }],
          output_config: {
            effort: opts.effort,
            format: { type: "json_schema", schema: jsonSchemaFor(keys) },
          },
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) {
          throw new StorelingoError(
            "E_TRANSLATOR",
            "Claude API rejected the API key",
            "Check ANTHROPIC_API_KEY (create keys in the Claude Console).",
          );
        }
        if (err instanceof Anthropic.APIError) {
          throw new StorelingoError("E_TRANSLATOR", `Claude API error ${err.status}: ${err.message}`);
        }
        throw err;
      }

      if (response.stop_reason === "refusal") {
        throw new StorelingoError(
          "E_TRANSLATOR",
          "The model declined to translate this listing",
          "Review the source text, or set another model in storelingo.config.json.",
        );
      }
      if (response.stop_reason === "max_tokens") {
        throw new StorelingoError("E_TRANSLATOR", "The model response was cut off (max_tokens)");
      }

      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      return {
        data: parseJson(text),
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    },
  };
}
