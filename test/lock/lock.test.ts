import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_FILE, decide, hashText, loadLock, lockKey, saveLock } from "../../src/lock/lock.js";
import { makeTmpDir, trySymlink } from "../helpers/tmp.js";

const src = "Hello";
const out = "Привет";
const entry = { sourceHash: hashText(src), outputHash: hashText(out) };

describe("hashText / lockKey", () => {
  it("produces stable sha256 hashes", () => {
    expect(hashText("a")).toBe(
      "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
  it("builds keys", () => {
    expect(lockKey("play", "ru-RU", "title")).toBe("play/ru-RU/title");
  });
});

describe("decide", () => {
  it("skips an empty or missing source", () => {
    expect(decide({ source: undefined, target: undefined, entry: undefined, force: false })).toBe("skip-empty-source");
    expect(decide({ source: "  \n", target: undefined, entry: undefined, force: true })).toBe("skip-empty-source");
  });
  it("translates when the target does not exist", () => {
    expect(decide({ source: src, target: undefined, entry: undefined, force: false })).toBe("translate");
    expect(decide({ source: src, target: undefined, entry, force: false })).toBe("translate");
  });
  it("treats an empty or whitespace-only target as missing", () => {
    expect(decide({ source: src, target: "", entry: undefined, force: false })).toBe("translate");
    expect(decide({ source: src, target: " \n\t", entry, force: false })).toBe("translate");
  });
  it("skips when nothing changed", () => {
    expect(decide({ source: src, target: out, entry, force: false })).toBe("skip-unchanged");
  });
  it("re-translates when the source changed", () => {
    expect(decide({ source: "Hello!", target: out, entry, force: false })).toBe("translate");
  });
  it("protects a manually edited target", () => {
    expect(decide({ source: "Hello!", target: "Привет!!", entry, force: false })).toBe("skip-manual-edit");
  });
  it("treats an existing target without lock entry as manual", () => {
    expect(decide({ source: src, target: out, entry: undefined, force: false })).toBe("skip-manual-edit");
  });
  it("--force overrides everything except an empty source", () => {
    expect(decide({ source: src, target: "edited", entry, force: true })).toBe("translate");
    expect(decide({ source: src, target: out, entry, force: true })).toBe("translate");
  });
});

describe("loadLock / saveLock", () => {
  it("returns an empty lock when the file is missing", async () => {
    const dir = await makeTmpDir();
    expect(await loadLock(join(dir, LOCK_FILE))).toEqual({ version: 1, entries: {} });
  });

  it("saves with sorted keys and reloads", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, LOCK_FILE);
    await saveLock(file, { version: 1, entries: { "play/ru-RU/title": entry, "appstore/ru/name": entry } });
    const text = await readFile(file, "utf8");
    expect(text.indexOf("appstore/ru/name")).toBeLessThan(text.indexOf("play/ru-RU/title"));
    expect(text.endsWith("\n")).toBe(true);
    expect((await loadLock(file)).entries["play/ru-RU/title"]).toEqual(entry);
  });

  it("leaves no temp file after a successful save", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, LOCK_FILE);
    await saveLock(file, { version: 1, entries: { "play/ru-RU/title": entry } });
    await saveLock(file, { version: 1, entries: { "play/de-DE/title": entry } });
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  it("removes its temp file when the final rename fails", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, LOCK_FILE);
    await mkdir(file); // a directory at the lock path: the temp write succeeds, the rename fails
    await expect(saveLock(file, { version: 1, entries: { "play/de-DE/title": entry } })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  it("refuses to save through a symlinked lock path and leaves its target untouched", async () => {
    const dir = await makeTmpDir();
    const outside = await makeTmpDir();
    await writeFile(join(outside, "keep.txt"), "keep");
    const file = join(dir, LOCK_FILE);
    await trySymlink(outside, file, "junction");
    await expect(saveLock(file, { version: 1, entries: { "play/de-DE/title": entry } })).rejects.toMatchObject({
      code: "E_CONFIG",
    });
    expect(await readdir(outside)).toEqual(["keep.txt"]);
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  it("refuses to overwrite a file the lock path links to", async ({ skip }) => {
    const dir = await makeTmpDir();
    const outside = await makeTmpDir();
    const victim = join(outside, "config");
    await writeFile(victim, "[core]\n");
    const file = join(dir, LOCK_FILE);
    if (!(await trySymlink(victim, file, "file"))) skip("symlinks are not permitted on this host");
    await expect(saveLock(file, { version: 1, entries: {} })).rejects.toMatchObject({ code: "E_CONFIG" });
    await expect(loadLock(file)).rejects.toMatchObject({ code: "E_CONFIG" });
    expect(await readFile(victim, "utf8")).toBe("[core]\n");
  });

  it("refuses to read a symlinked lock path", async () => {
    const dir = await makeTmpDir();
    const outside = await makeTmpDir();
    const file = join(dir, LOCK_FILE);
    await trySymlink(outside, file, "junction");
    await expect(loadLock(file)).rejects.toMatchObject({ code: "E_CONFIG", message: expect.stringContaining("symlink") });
  });

  it("strips a UTF-8 BOM when reading", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, LOCK_FILE);
    await writeFile(
      file,
      `\uFEFF${JSON.stringify({ version: 1, entries: { "play/ru-RU/title": entry } })}`,
      "utf8",
    );
    expect((await loadLock(file)).entries["play/ru-RU/title"]).toEqual(entry);
  });

  it("rejects a corrupt lock file", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, LOCK_FILE);
    await writeFile(file, '{"version": 9}');
    await expect(loadLock(file)).rejects.toMatchObject({ code: "E_CONFIG" });
  });
});
