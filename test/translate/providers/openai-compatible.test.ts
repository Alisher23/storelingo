import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleLlm } from "../../../src/translate/providers/openai-compatible.js";

const body = {
  choices: [{ message: { content: '{"title":"Hallo"}' } }],
  usage: { prompt_tokens: 50, completion_tokens: 5 },
};
const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });

describe("createOpenAiCompatibleLlm", () => {
  it("posts a chat completion with JSON mode and auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, body));
    const llm = createOpenAiCompatibleLlm({ apiKey: "sk-x", baseUrl: "https://api.example.com/v1/", model: "gpt-x", fetchImpl });
    const res = await llm.completeJson({ system: "SYS", user: "USER", keys: ["title"] });
    expect(res).toEqual({ data: { title: "Hallo" }, usage: { inputTokens: 50, outputTokens: 5 } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-x");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("gpt-x");
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[0]).toEqual({ role: "system", content: "SYS" });
  });

  it("omits auth when no key (e.g. Ollama)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, body));
    const llm = createOpenAiCompatibleLlm({ baseUrl: "http://localhost:11434/v1", model: "qwen3", fetchImpl });
    await llm.completeJson({ system: "", user: "", keys: ["title"] });
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });

  it("retries 429 using retry-after seconds", async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: "slow down" }, { "retry-after": "2" }))
      .mockResolvedValue(json(200, body));
    const llm = createOpenAiCompatibleLlm({
      baseUrl: "http://x/v1",
      model: "m",
      fetchImpl,
      sleep: async (ms) => void delays.push(ms),
    });
    await llm.completeJson({ system: "", user: "", keys: ["title"] });
    expect(delays).toEqual([2000]);
  });

  it("fails fast on 401 with E_TRANSLATOR and no key in the message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401, { error: "bad key" }));
    const llm = createOpenAiCompatibleLlm({ apiKey: "sk-secret-123", baseUrl: "http://x/v1", model: "m", fetchImpl });
    const err = await llm.completeJson({ system: "", user: "", keys: ["t"] }).catch((e) => e);
    expect(err.code).toBe("E_TRANSLATOR");
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("sk-secret-123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns data undefined when content is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { choices: [{ message: { content: "nope" } }] }));
    const llm = createOpenAiCompatibleLlm({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const res = await llm.completeJson({ system: "", user: "", keys: ["t"] });
    expect(res).toEqual({ data: undefined, usage: { inputTokens: 0, outputTokens: 0 } });
  });
});
