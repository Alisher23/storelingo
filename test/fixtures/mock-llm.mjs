// Tiny OpenAI-compatible mock server for the GitHub Action self-test.
// Usage: node test/fixtures/mock-llm.mjs [port]   (default 8787, 127.0.0.1 only)
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8787);

function valueFor(key) {
  if (key === "keywords") return "mock,test";
  return `Mock ${key}`.slice(0, 20);
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let content = "{}";
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = [...messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      const match = /Respond with a JSON object with keys: ([^\n]*?)\.\s*$/.exec(text);
      const keys = match ? match[1].split(",").map((k) => k.trim()).filter(Boolean) : [];
      content = JSON.stringify(Object.fromEntries(keys.map((k) => [k, valueFor(k)])));
    } catch {
      // fall through with an empty object
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock llm listening on http://127.0.0.1:${port}`);
});
