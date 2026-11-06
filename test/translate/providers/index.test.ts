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
  it("sends STORELINGO_TRANSLATOR_API_KEY when the host var matches", () => {
    const withHost = { ...env, STORELINGO_TRANSLATOR_API_HOST: "openrouter.ai" };
    expect(resolveOpenAiKey("https://openrouter.ai/api/v1", withHost)).toBe("sk-other");
  });
  it("compares the host var case-insensitively and trimmed", () => {
    const withHost = { ...env, STORELINGO_TRANSLATOR_API_HOST: " OpenRouter.ai " };
    expect(resolveOpenAiKey("https://openrouter.ai/api/v1", withHost)).toBe("sk-other");
  });
  it("throws E_CONFIG, without leaking the key, when the host var names another host", () => {
    const withHost = { ...env, STORELINGO_TRANSLATOR_API_HOST: "good.example" };
    let err: unknown;
    try {
      resolveOpenAiKey("https://evil.example/v1", withHost);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "E_CONFIG" });
    expect(JSON.stringify(err)).not.toContain("sk-other");
    expect((err as Error).message).not.toContain("sk-other");
  });
  it("throws E_CONFIG when the key is set but no host var", () => {
    expect(() => resolveOpenAiKey("https://openrouter.ai/api/v1", env)).toThrowError(
      expect.objectContaining({ code: "E_CONFIG" }),
    );
  });
  it("returns undefined with no key and no host var on localhost", () => {
    expect(resolveOpenAiKey("http://localhost:11434/v1", {})).toBeUndefined();
  });
});
