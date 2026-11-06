import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runTranslate } from "../../src/commands/translate.js";
import { createLogger } from "../../src/log.js";
import { LOCK_FILE, loadLock } from "../../src/lock/lock.js";
import { StorelingoError } from "../../src/errors.js";
import type { TranslateRequest, Translator } from "../../src/translate/types.js";
import { makeProject } from "../helpers/project.js";
import { makeTmpDir, trySymlink } from "../helpers/tmp.js";

const P = "fastlane/metadata/android";
const config = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "de"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic", concurrency: 2 },
  glossary: { doNotTranslate: ["Qibla"], terms: { ru: { prayer: "намаз" } } },
};
const files = {
  [`${P}/en-US/title.txt`]: "Prayer Times\n",
  [`${P}/en-US/short_description.txt`]: "Accurate times",
};

const silent = createLogger({ verbose: false, secrets: [], out: () => {}, err: () => {} });

function fakeTranslator(fn?: (req: TranslateRequest) => Promise<void>) {
  const calls: TranslateRequest[] = [];
  const translator: Translator = {
    translate: vi.fn(async (req: TranslateRequest) => {
      calls.push(req);
      await fn?.(req);
      return {
        texts: Object.fromEntries(req.fields.map((f) => [f.key, `[${req.targetLocale.code}] ${f.text}`])),
        errors: {},
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    }),
  };
  return { translator, calls };
}

describe("runTranslate", () => {
  it("translates all fields, restores trailing newline and writes the lock", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    const { translator, calls } = fakeTranslator();
    const report = await runTranslate({ config: cfg, cwd, translator, log: silent });

    expect(report).toMatchObject({ translated: 4, unchanged: 0, manual: 0, unsupported: 0, failed: [] });
    expect(report.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(await readFile(join(cwd, P, "ru-RU", "title.txt"), "utf8")).toBe("[ru] Prayer Times\n");
    expect(await readFile(join(cwd, P, "de-DE", "short_description.txt"), "utf8")).toBe("[de] Accurate times");

    const ru = calls.find((c) => c.targetLocale.code === "ru")!;
    expect(ru.fields.map((f) => f.text)).toEqual(["Prayer Times", "Accurate times"]);
    expect(ru.terms).toEqual({ prayer: "намаз" });
    expect(ru.doNotTranslate).toEqual(["Qibla"]);

    const lock = await loadLock(join(cwd, LOCK_FILE));
    expect(Object.keys(lock.entries).sort()).toEqual([
      "play/de-DE/short_description",
      "play/de-DE/title",
      "play/ru-RU/short_description",
      "play/ru-RU/title",
    ]);
  });

  it("skips unchanged fields on the second run", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    await runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent });
    const second = fakeTranslator();
    const report = await runTranslate({ config: cfg, cwd, translator: second.translator, log: silent });
    expect(report).toMatchObject({ translated: 0, unchanged: 4 });
    expect(second.calls).toHaveLength(0);
  });

  it("protects manual edits unless --force", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    await runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent });
    await writeFile(join(cwd, P, "ru-RU", "title.txt"), "Время намаза");
    await writeFile(join(cwd, P, "en-US", "title.txt"), "Prayer Times Pro\n");

    const report = await runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent });
    expect(report).toMatchObject({ translated: 1, manual: 1 });
    expect(await readFile(join(cwd, P, "ru-RU", "title.txt"), "utf8")).toBe("Время намаза");

    const forced = await runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent, force: true });
    expect(forced.translated).toBe(4);
    expect(await readFile(join(cwd, P, "ru-RU", "title.txt"), "utf8")).toBe("[ru] Prayer Times Pro\n");
  });

  it("limits to --locale and rejects locales outside targetLocales", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    const { translator, calls } = fakeTranslator();
    await runTranslate({ config: cfg, cwd, translator, log: silent, locales: ["de"] });
    expect(calls.map((c) => c.targetLocale.code)).toEqual(["de"]);
    await expect(runTranslate({ config: cfg, cwd, translator, log: silent, locales: ["fr-FR"] })).rejects.toMatchObject({
      code: "E_USAGE",
    });
  });

  it("counts unsupported locales and keeps going after a failed job", async () => {
    const { cwd, config: cfg } = await makeProject(files, {
      ...config,
      targetLocales: ["ru", "de", "ky"],
      stores: { play: { packageName: "x" }, appstore: { appId: "1" } },
    });
    const { translator } = fakeTranslator(async (req) => {
      if (req.targetLocale.code === "de") throw new StorelingoError("E_TRANSLATOR", "boom");
    });
    const report = await runTranslate({ config: cfg, cwd, translator, log: silent });
    expect(report.unsupported).toBe(1); // ky on App Store
    expect(report.failed).toEqual([{ store: "play", locale: "de-DE", message: "boom" }]);
    expect(report.translated).toBe(4); // ru + ky on Play
  });

  it("records per-field errors from the translator", async () => {
    const { cwd, config: cfg } = await makeProject(files, { ...config, targetLocales: ["ru"] });
    const translator: Translator = {
      translate: async () => ({
        texts: { short_description: "Точно" },
        errors: { title: "40 characters, limit is 30" },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const report = await runTranslate({ config: cfg, cwd, translator, log: silent });
    expect(report.translated).toBe(1);
    expect(report.failed).toEqual([
      { store: "play", locale: "ru-RU", field: "title", message: "40 characters, limit is 30" },
    ]);
  });

  it("refuses a symlinked target locale folder planted in the repository", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    const outside = await makeTmpDir();
    await trySymlink(outside, join(cwd, P, "ru-RU"), "junction");
    await expect(runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent })).rejects.toMatchObject({
      code: "E_CONFIG",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("survives a write failure: records it, keeps other fields and persists their lock entries", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    // Turn the target path into a directory once planning is done, so writeFile fails with EISDIR.
    const { translator } = fakeTranslator(async (req) => {
      if (req.targetLocale.code === "de") await mkdir(join(cwd, P, "de-DE", "title.txt"), { recursive: true });
    });
    const report = await runTranslate({ config: cfg, cwd, translator, log: silent });

    expect(report.translated).toBe(3);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ store: "play", locale: "de-DE", field: "title" });
    expect(await readFile(join(cwd, P, "de-DE", "short_description.txt"), "utf8")).toBe("[de] Accurate times");

    const lock = await loadLock(join(cwd, LOCK_FILE));
    expect(Object.keys(lock.entries).sort()).toEqual([
      "play/de-DE/short_description",
      "play/ru-RU/short_description",
      "play/ru-RU/title",
    ]);
  });
});
