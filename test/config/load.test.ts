import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE, loadConfig, parseConfig } from "../../src/config/load.js";
import { StorelingoError } from "../../src/errors.js";
import { makeTmpDir } from "../helpers/tmp.js";

const minimal = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "de"],
  stores: { play: { packageName: "com.example.app" } },
  translator: { provider: "anthropic" },
};

describe("parseConfig", () => {
  it("applies defaults", () => {
    const config = parseConfig(minimal);
    expect(config.translator).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "medium",
      concurrency: 4,
    });
    expect(config.context).toBe("");
    expect(config.glossary).toEqual({ doNotTranslate: [], terms: {} });
    expect(config.paths).toEqual({});
  });

  it("accepts an openai-compatible translator", () => {
    const config = parseConfig({
      ...minimal,
      translator: { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
    });
    expect(config.translator.provider).toBe("openai-compatible");
  });

  it("requires at least one store", () => {
    expect(() => parseConfig({ ...minimal, stores: {} })).toThrow(StorelingoError);
  });

  it("rejects unknown locales with the list of bad codes", () => {
    try {
      parseConfig({ ...minimal, targetLocales: ["ru", "xx-YY"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StorelingoError);
      expect((err as StorelingoError).code).toBe("E_CONFIG");
      expect((err as StorelingoError).message).toContain("xx-YY");
    }
  });

  it("rejects a target equal to the source", () => {
    expect(() => parseConfig({ ...minimal, targetLocales: ["en-US"] })).toThrow("source locale");
  });

  it("reports the path of an invalid field", () => {
    expect(() => parseConfig({ ...minimal, translator: { provider: "anthropic", concurrency: 0 } })).toThrow(
      "translator.concurrency",
    );
  });
});

describe("loadConfig", () => {
  it("reads a config file", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, CONFIG_FILE);
    await writeFile(file, JSON.stringify(minimal));
    const config = await loadConfig(file);
    expect(config.targetLocales).toEqual(["ru", "de"]);
  });

  it("explains a missing file", async () => {
    const dir = await makeTmpDir();
    await expect(loadConfig(join(dir, CONFIG_FILE))).rejects.toMatchObject({
      code: "E_CONFIG",
      hint: "Run `npx storelingo init` to create one.",
    });
  });

  it("explains invalid JSON", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, CONFIG_FILE);
    await writeFile(file, "{ not json");
    await expect(loadConfig(file)).rejects.toMatchObject({ code: "E_CONFIG" });
  });
});
