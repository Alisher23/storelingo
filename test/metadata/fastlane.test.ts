import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { getField } from "../../src/fields/registry.js";
import {
  assertSafePath,
  isInsideProject,
  listLocales,
  readField,
  resolveFieldPath,
  storeRoot,
  writeField,
  type StoreRoot,
} from "../../src/metadata/fastlane.js";
import { makeTmpDir, trySymlink } from "../helpers/tmp.js";

const config = parseConfig({
  sourceLocale: "en-US",
  targetLocales: ["ru"],
  stores: { play: { packageName: "a.b" }, appstore: { appId: "1" } },
  translator: { provider: "anthropic" },
});

/** A temp project with its metadata root in <project>/meta. */
async function makeRoot(): Promise<StoreRoot> {
  const projectRoot = await makeTmpDir();
  const root = join(projectRoot, "meta");
  await mkdir(root);
  return { projectRoot, root };
}

describe("storeRoot", () => {
  it("uses fastlane defaults and config overrides", () => {
    expect(storeRoot(config, "/p", "play")).toEqual({
      projectRoot: resolve("/p"),
      root: resolve("/p", "fastlane/metadata/android"),
    });
    expect(storeRoot(config, "/p", "appstore").root).toBe(resolve("/p", "fastlane/metadata"));
    const custom = { ...config, paths: { play: "meta/play" } };
    expect(storeRoot(custom, "/p", "play").root).toBe(resolve("/p", "meta/play"));
  });

  it("rejects a root outside the project even if the schema was bypassed", () => {
    for (const play of ["../x", resolve("/elsewhere")]) {
      const custom = { ...config, paths: { play } };
      expect(() => storeRoot(custom, "/p", "play"), play).toThrowError(expect.objectContaining({ code: "E_CONFIG" }));
    }
  });
});

describe("listLocales", () => {
  it("lists App Store locale folders, skipping fastlane special folders", async () => {
    const root = await makeTmpDir();
    for (const d of ["en-US", "ru", "android", "default", "review_information"]) {
      await mkdir(join(root, d));
    }
    await writeFile(join(root, "copyright.txt"), "x");
    expect(await listLocales(root, "appstore")).toEqual(["en-US", "ru"]);
  });

  it("returns [] when the root does not exist", async () => {
    const root = await makeTmpDir();
    expect(await listLocales(join(root, "missing"), "play")).toEqual([]);
  });
});

describe("readField / writeField", () => {
  it("round-trips text and creates folders", async () => {
    const r = await makeRoot();
    await writeField(r, "ru-RU", "changelogs/12.txt", "Новое\n");
    expect(await readFile(join(r.root, "ru-RU", "changelogs", "12.txt"), "utf8")).toBe("Новое\n");
    expect(await readField(r, "ru-RU", "changelogs/12.txt")).toBe("Новое\n");
  });

  it("strips BOM and normalizes CRLF on read", async () => {
    const r = await makeRoot();
    await mkdir(join(r.root, "en-US"));
    await writeFile(join(r.root, "en-US", "title.txt"), "\uFEFFLine1\r\nLine2");
    expect(await readField(r, "en-US", "title.txt")).toBe("Line1\nLine2");
  });

  it("writes LF-only text without BOM and returns exactly what it wrote", async () => {
    const r = await makeRoot();
    const BOM = String.fromCharCode(0xfeff);
    expect(await writeField(r, "ru", "description.txt", `${BOM}a\r\nb\rc\n`)).toBe("a\nb\nc\n");
    expect(await readFile(join(r.root, "ru", "description.txt"), "utf8")).toBe("a\nb\nc\n");
  });

  it("returns undefined for a missing file", async () => {
    const r = await makeRoot();
    expect(await readField(r, "en-US", "title.txt")).toBeUndefined();
  });
});

describe("resolveFieldPath", () => {
  it("returns the plain file for normal fields", async () => {
    const r = await makeRoot();
    expect(await resolveFieldPath(r, "en-US", getField("play", "title"))).toBe("title.txt");
  });

  it("picks the highest numeric changelog of the source locale", async () => {
    const r = await makeRoot();
    await mkdir(join(r.root, "en-US", "changelogs"), { recursive: true });
    for (const f of ["9.txt", "12.txt", "default.txt", "3.txt"]) {
      await writeFile(join(r.root, "en-US", "changelogs", f), "x");
    }
    expect(await resolveFieldPath(r, "en-US", getField("play", "changelog"))).toBe("changelogs/12.txt");
  });

  it("returns the original file name of the highest changelog (zero-padded names)", async () => {
    const r = await makeRoot();
    await mkdir(join(r.root, "en-US", "changelogs"), { recursive: true });
    for (const f of ["5.txt", "007.txt"]) await writeFile(join(r.root, "en-US", "changelogs", f), "x");
    expect(await resolveFieldPath(r, "en-US", getField("play", "changelog"))).toBe("changelogs/007.txt");
  });

  it("returns undefined when there are no changelogs", async () => {
    const r = await makeRoot();
    expect(await resolveFieldPath(r, "en-US", getField("play", "changelog"))).toBeUndefined();
  });
});

describe("isInsideProject", () => {
  const p = resolve("/project");
  it("accepts the project itself and paths below it", () => {
    expect(isInsideProject(p, p)).toBe(true);
    expect(isInsideProject(p, join(p, "fastlane", "metadata"))).toBe(true);
    expect(isInsideProject(p, join(p, "..foo"))).toBe(true);
  });
  it("rejects parents, siblings and other roots", () => {
    expect(isInsideProject(p, resolve("/"))).toBe(false);
    expect(isInsideProject(p, resolve("/project-other/x"))).toBe(false);
    expect(isInsideProject(p, join(p, "..", "x"))).toBe(false);
  });
});

describe("symlink protection", () => {
  it("assertSafePath rejects a target outside the project", async () => {
    const r = await makeRoot();
    await expect(assertSafePath(r.projectRoot, join(r.projectRoot, "..", "x"))).rejects.toMatchObject({
      code: "E_CONFIG",
    });
  });

  it("assertSafePath accepts a path whose tail does not exist yet", async () => {
    const r = await makeRoot();
    await expect(assertSafePath(r.projectRoot, join(r.root, "ru", "deep", "x.txt"))).resolves.toBeUndefined();
  });

  it("refuses to write through a symlinked locale folder", async () => {
    const r = await makeRoot();
    const outside = await makeTmpDir();
    await trySymlink(outside, join(r.root, "ru-RU"), "junction");
    await expect(writeField(r, "ru-RU", "title.txt", "x")).rejects.toMatchObject({
      code: "E_CONFIG",
      message: "refusing to follow symlink: meta/ru-RU",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses to read through a symlinked locale folder", async () => {
    const r = await makeRoot();
    const outside = await makeTmpDir();
    await writeFile(join(outside, "title.txt"), "secret");
    await trySymlink(outside, join(r.root, "en-US"), "junction");
    await expect(readField(r, "en-US", "title.txt")).rejects.toMatchObject({ code: "E_CONFIG" });
  });

  it("refuses to list changelogs through a symlinked folder", async () => {
    const r = await makeRoot();
    const outside = await makeTmpDir();
    await writeFile(join(outside, "5.txt"), "x");
    await mkdir(join(r.root, "en-US"));
    await trySymlink(outside, join(r.root, "en-US", "changelogs"), "junction");
    await expect(resolveFieldPath(r, "en-US", getField("play", "changelog"))).rejects.toMatchObject({
      code: "E_CONFIG",
    });
  });

  it("refuses to read a source file that is a symlink (e.g. to /proc/self/environ)", async ({ skip }) => {
    const r = await makeRoot();
    const outside = await makeTmpDir();
    await writeFile(join(outside, "secret.txt"), "OPENAI_API_KEY=sk-x");
    await mkdir(join(r.root, "en-US"));
    if (!(await trySymlink(join(outside, "secret.txt"), join(r.root, "en-US", "title.txt"), "file"))) {
      skip("symlinks are not permitted on this host");
    }
    await expect(readField(r, "en-US", "title.txt")).rejects.toMatchObject({
      code: "E_CONFIG",
      message: "refusing to follow symlink: meta/en-US/title.txt",
    });
  });

  it("refuses to write through a dangling symlink", async ({ skip }) => {
    const r = await makeRoot();
    const outside = await makeTmpDir();
    await mkdir(join(r.root, "ru-RU"));
    if (!(await trySymlink(join(outside, "planted.txt"), join(r.root, "ru-RU", "title.txt"), "file"))) {
      skip("symlinks are not permitted on this host");
    }
    await expect(writeField(r, "ru-RU", "title.txt", "x")).rejects.toMatchObject({ code: "E_CONFIG" });
    await expect(stat(join(outside, "planted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
