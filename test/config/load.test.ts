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

  it("rejects metadata paths that leave the project", () => {
    for (const p of ["../x", "a/../../x", "/x", "C:\\x", "C:x", "\\\\server\\share"]) {
      expect(() => parseConfig({ ...minimal, paths: { play: p } }), p).toThrowError(
        expect.objectContaining({ code: "E_CONFIG", message: expect.stringContaining("paths.play") }),
      );
    }
    expect(() => parseConfig({ ...minimal, paths: { appstore: "..\\x" } })).toThrow("paths.appstore");
  });

  it("accepts metadata paths inside the project", () => {
    const config = parseConfig({ ...minimal, paths: { play: "meta/play", appstore: "./ios/../meta" } });
    expect(config.paths).toEqual({ play: "meta/play", appstore: "./ios/../meta" });
  });

  it("rejects duplicate targetLocales, listing the duplicates", () => {
    expect(() => parseConfig({ ...minimal, targetLocales: ["ru", "de", "ru", "de", "tr"] })).toThrowError(
      expect.objectContaining({ code: "E_CONFIG", message: expect.stringMatching(/targetLocales: .*duplicate.*ru, de/) }),
    );
  });

  it("rejects unknown (misspelled) keys, naming the key", () => {
    expect(() => parseConfig({ ...minimal, glossary: { doNotTranslte: ["X"] } })).toThrowError(
      expect.objectContaining({ code: "E_CONFIG", message: expect.stringContaining("doNotTranslte") }),
    );
    expect(() => parseConfig({ ...minimal, targetLocale: ["ru"] })).toThrow("targetLocale");
    expect(() => parseConfig({ ...minimal, translator: { provider: "anthropic", modle: "x" } })).toThrow("modle");
    expect(() => parseConfig({ ...minimal, stores: { play: { packageName: "a", appId: "1" } } })).toThrow("appId");
    expect(() => parseConfig({ ...minimal, paths: { android: "x" } })).toThrow("android");
  });

  it("still accepts $schema", () => {
    expect(parseConfig({ $schema: "https://example.com/schema.json", ...minimal }).sourceLocale).toBe("en-US");
  });

  it("hints at the supported locale codes instead of a source file", () => {
    try {
      parseConfig({ ...minimal, targetLocales: ["xx"] });
      expect.unreachable();
    } catch (err) {
      const hint = (err as StorelingoError).hint ?? "";
      expect(hint).toContain("en-US");
      expect(hint).toContain("zh-Hant");
      expect(hint).not.toContain("src/");
    }
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

  it("reads a config file that starts with a UTF-8 BOM", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, CONFIG_FILE);
    await writeFile(file, `${String.fromCharCode(0xfeff)}${JSON.stringify(minimal)}`, "utf8");
    expect((await loadConfig(file)).sourceLocale).toBe("en-US");
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

  it("defaults the App Store platform to IOS and requires a numeric appId", () => {
    const cfg = parseConfig({ ...minimal, stores: { appstore: { appId: "1234567890" } } });
    expect(cfg.stores.appstore).toEqual({ appId: "1234567890", platform: "IOS" });
    expect(() => parseConfig({ ...minimal, stores: { appstore: { appId: "com.example" } } })).toThrow(
      "stores.appstore.appId",
    );
  });
});
