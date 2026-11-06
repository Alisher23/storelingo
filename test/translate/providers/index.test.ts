import { describe, expect, it } from "vitest";
import { createLlmClient } from "../../../src/translate/providers/index.js";

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
      createLlmClient({ provider: "openai-compatible", baseUrl: "http://x/v1", model: "m", concurrency: 4 }, {}),
    ).toHaveProperty("completeJson");
  });
});
