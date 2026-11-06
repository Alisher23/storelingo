import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfigJson, writeInitFiles, type InitAnswers } from "../../src/commands/init.js";
import { parseConfig } from "../../src/config/load.js";
import { makeTmpDir } from "../helpers/tmp.js";

const answers: InitAnswers = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "ky"],
  playPackageName: "com.example.app",
  appstoreAppId: "123",
  provider: "anthropic",
  context: "Prayer times app",
};

describe("buildConfigJson", () => {
  it("produces a valid config", () => {
    const config = parseConfig(buildConfigJson(answers));
    expect(config.stores).toEqual({ play: { packageName: "com.example.app" }, appstore: { appId: "123" } });
    expect(config.translator.provider).toBe("anthropic");
  });
  it("includes baseUrl and model for openai-compatible", () => {
    const json = buildConfigJson({ ...answers, provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen3" });
    expect(json.translator).toEqual({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen3" });
  });
});

describe("writeInitFiles", () => {
  it("writes config, source folders and .gitignore entries", async () => {
    const cwd = await makeTmpDir();
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    const created = await writeInitFiles(cwd, answers);

    expect(created).toEqual([
      "storelingo.config.json",
      "fastlane/metadata/android/en-US",
      "fastlane/metadata/en-US",
      ".gitignore",
    ]);
    const config = JSON.parse(await readFile(join(cwd, "storelingo.config.json"), "utf8"));
    expect(config.$schema).toBe("https://unpkg.com/storelingo/schema.json");
    expect((await stat(join(cwd, "fastlane/metadata/android/en-US"))).isDirectory()).toBe(true);
    const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gitignore).toBe("node_modules/\n*.p8\nplay-service-account*.json\n");
  });

  it("does not duplicate .gitignore entries", async () => {
    const cwd = await makeTmpDir();
    await writeFile(join(cwd, ".gitignore"), "*.p8\nplay-service-account*.json\n");
    const created = await writeInitFiles(cwd, answers);
    expect(created).not.toContain(".gitignore");
  });

  it("refuses to overwrite an existing config without force", async () => {
    const cwd = await makeTmpDir();
    await writeInitFiles(cwd, answers);
    await expect(writeInitFiles(cwd, answers)).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(writeInitFiles(cwd, { ...answers, targetLocales: ["de"] }, { force: true })).resolves.toContain(
      "storelingo.config.json",
    );
  });
});
