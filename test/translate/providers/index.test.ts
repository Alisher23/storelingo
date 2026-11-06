import { describe, expect, it } from "vitest";
import { createLlmClient, resolveOpenAiKey } from "../../../src/translate/providers/index.js";

describe("createLlmClient", () => {
  it("requires ANTHROPIC_API_KEY for the anthropic provider", () => {
    expect(() =>
      createLlmClient({ provider: "anthropic", model: "claude-opus-5-5", effort: "medium", concurrency: 4 }, {}),
    ).toThrow("ANTHROPIC_API_KEY");
  });
  it("creates clients when configured", () => {
    expect(
      createLlmClient(
        { provider: "anthropic", model: "claude-opus-5-5", effort: "medium", concurrency: 4 },
        { ANTHROPIC_API_KEY: "sk-ant-test" },
      ),
    ).toHaveProperty("completeJson");
    expect(
      createLlmClient(
        { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "m", concurrency: 4 },
        {},
      ),
    ).toHaveProperty("completeJson");
  });

  it("rejects plain http for non-local hosts", () => {
    expect(() =>
      createLlmClient({ provider: "openai-compatible", baseUrl: "http://evil.example/v1", model: "m", concurrency: 4 }, {}),
    ).toThrowError(expect.objectContaining({ code: "E_CONFIG" }));
  });

  it("allows http for loopback hosts", () => {
    for (const baseUrl of ["http://127.0.0.1:1234/v1", "http://[::1]:1234/v1"]) {
      expect(
        createLlmClient({ provider: "openai-compatible", baseUrl, model: "m", concurrency: 4 }, {}),
      ).toHaveProperty("completeJson");
    }
  });
});

describe("resolveOpenAiKey", () => {
  const env = { OPENAI_API_KEY: "sk-openai", STORELINGO_TRANSLATOR_API_KEY: "sk-other" };
  it("uses OPENAI_API_KEY only for api.openai.com", () => {
    expect(resolveOpenAiKey("https://api.openai.com/v1", env)).toBe("sk-openai");
  });
  it("never sends OPENAI_API_KEY to other hosts", () => {
    expect(resolveOpenAiKey("https://openrouter.ai/api/v1", { OPENAI_API_KEY: "sk-openai" })).toBeUndefined();
  });
  it("uses STORELINGO_TRANSLATOR_API_KEY for other hosts", () => {
    expect(resolveOpenAiKey("https://openrouter.ai/api/v1", env)).toBe("sk-other");
  });
});
