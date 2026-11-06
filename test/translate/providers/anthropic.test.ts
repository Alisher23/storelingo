import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicLlm, jsonSchemaFor } from "../../../src/translate/providers/anthropic.js";

function fakeClient(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, create };
}

const ok = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: '{"title":"Привет"}' }],
  usage: { input_tokens: 120, output_tokens: 15 },
};

describe("jsonSchemaFor", () => {
  it("builds a strict object schema of strings", () => {
    expect(jsonSchemaFor(["a", "b"])).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
      additionalProperties: false,
    });
  });
});

describe("createAnthropicLlm", () => {
  it("sends model, effort, JSON schema and fallback opt-in", async () => {
    const { client, create } = fakeClient(ok);
    const llm = createAnthropicLlm({ apiKey: "k", model: "claude-opus-5-5", effort: "medium", client });
    await llm.completeJson({ system: "SYS", user: "USER", keys: ["title"] });
    const params = create.mock.calls[0]![0];
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: "SYS",
      messages: [{ role: "user", content: "USER" }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: jsonSchemaFor(["title"]) } },
    });
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("temperature");
  });

  it("parses JSON text and usage", async () => {
    const { client } = fakeClient(ok);
    const llm = createAnthropicLlm({ apiKey: "k", model: "m", effort: "low", client });
    await expect(llm.completeJson({ system: "", user: "", keys: ["title"] })).resolves.toEqual({
      data: { title: "Привет" },
      usage: { inputTokens: 120, outputTokens: 15 },
    });
  });

  it("returns data undefined for non-JSON text", async () => {
    const { client } = fakeClient({ ...ok, content: [{ type: "text", text: "sorry" }] });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m", effort: "low", client });
    expect((await llm.completeJson({ system: "", user: "", keys: ["title"] })).data).toBeUndefined();
  });

  it("turns a refusal into E_TRANSLATOR", async () => {
    const { client } = fakeClient({ ...ok, stop_reason: "refusal", content: [] });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m", effort: "low", client });
    await expect(llm.completeJson({ system: "", user: "", keys: ["title"] })).rejects.toMatchObject({
      code: "E_TRANSLATOR",
    });
  });

  it("turns max_tokens into E_TRANSLATOR", async () => {
    const { client } = fakeClient({ ...ok, stop_reason: "max_tokens" });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m", effort: "low", client });
    await expect(llm.completeJson({ system: "", user: "", keys: ["title"] })).rejects.toMatchObject({
      code: "E_TRANSLATOR",
    });
  });
});
