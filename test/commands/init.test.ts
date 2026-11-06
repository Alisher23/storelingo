import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfigJson, writeInitFiles, type InitAnswers } from "../../src/commands/init.js";
import { parseConfig } from "../../src/config/load.js";
import { makeTmpDir, trySymlink } from "../helpers/tmp.js";

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
  it("does not write a $schema URL (no schema is published)", () => {
    expect(buildConfigJson(answers)).not.toHaveProperty("$schema");
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
      { action: "created", path: "storelingo.config.json" },
      { action: "created", path: "fastlane/metadata/android/en-US" },
      { action: "created", path: "fastlane/metadata/en-US" },
      { action: "updated", path: ".gitignore" },
    ]);
    const config = JSON.parse(await readFile(join(cwd, "storelingo.config.json"), "utf8"));
    expect(config).not.toHaveProperty("$schema");
    expect((await stat(join(cwd, "fastlane/metadata/android/en-US"))).isDirectory()).toBe(true);
    const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gitignore).toBe("node_modules/\n*.p8\nplay-service-account*.json\n");
  });

  it("refuses a symlinked .gitignore and leaves its target and the project untouched", async ({ skip }) => {
    const cwd = await makeTmpDir();
    const outside = await makeTmpDir();
    const target = join(outside, "victim.txt");
    await writeFile(target, "keep me\n");
    if (!(await trySymlink(target, join(cwd, ".gitignore"), "file"))) skip("symlinks are not permitted on this host");

    await expect(writeInitFiles(cwd, answers)).rejects.toMatchObject({ code: "E_CONFIG" });
    expect(await readFile(target, "utf8")).toBe("keep me\n");
    await expect(stat(join(cwd, "storelingo.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked storelingo.config.json and leaves its target untouched", async ({ skip }) => {
    const cwd = await makeTmpDir();
    const outside = await makeTmpDir();
    const target = join(outside, "victim.json");
    await writeFile(target, "{}\n");
    if (!(await trySymlink(target, join(cwd, "storelingo.config.json"), "file"))) skip("symlinks are not permitted on this host");

    await expect(writeInitFiles(cwd, answers, { force: true })).rejects.toMatchObject({ code: "E_CONFIG" });
    expect(await readFile(target, "utf8")).toBe("{}\n");
  });

  it("does not duplicate .gitignore entries", async () => {
    const cwd = await makeTmpDir();
    await writeFile(join(cwd, ".gitignore"), "*.p8\nplay-service-account*.json\n");
    const created = await writeInitFiles(cwd, answers);
    expect(created.map((c) => c.path)).not.toContain(".gitignore");
  });

  it("reports a new .gitignore as created", async () => {
    const cwd = await makeTmpDir();
    const created = await writeInitFiles(cwd, answers);
    expect(created).toContainEqual({ action: "created", path: ".gitignore" });
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe("*.p8\nplay-service-account*.json\n");
  });

  it("refuses to overwrite an existing config without force", async () => {
    const cwd = await makeTmpDir();
    await writeInitFiles(cwd, answers);
    await expect(writeInitFiles(cwd, answers)).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(writeInitFiles(cwd, { ...answers, targetLocales: ["de"] }, { force: true })).resolves.toContainEqual({
      action: "created",
      path: "storelingo.config.json",
    });
  });
});
