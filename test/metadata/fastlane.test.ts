import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { getField } from "../../src/fields/registry.js";
import {
  listLocales,
  readField,
  resolveFieldPath,
  storeRoot,
  writeField,
} from "../../src/metadata/fastlane.js";
import { makeTmpDir } from "../helpers/tmp.js";

const config = parseConfig({
  sourceLocale: "en-US",
  targetLocales: ["ru"],
  stores: { play: { packageName: "a.b" }, appstore: { appId: "1" } },
  translator: { provider: "anthropic" },
});

describe("storeRoot", () => {
  it("uses fastlane defaults and config overrides", () => {
    expect(storeRoot(config, "/p", "play")).toBe(resolve("/p", "fastlane/metadata/android"));
    expect(storeRoot(config, "/p", "appstore")).toBe(resolve("/p", "fastlane/metadata"));
    const custom = { ...config, paths: { play: "meta/play" } };
    expect(storeRoot(custom, "/p", "play")).toBe(resolve("/p", "meta/play"));
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
    const root = await makeTmpDir();
    await writeField(root, "ru-RU", "changelogs/12.txt", "Новое\n");
    expect(await readFile(join(root, "ru-RU", "changelogs", "12.txt"), "utf8")).toBe("Новое\n");
    expect(await readField(root, "ru-RU", "changelogs/12.txt")).toBe("Новое\n");
  });

  it("strips BOM and normalizes CRLF on read", async () => {
    const root = await makeTmpDir();
    await mkdir(join(root, "en-US"));
    await writeFile(join(root, "en-US", "title.txt"), "\uFEFFLine1\r\nLine2");
    expect(await readField(root, "en-US", "title.txt")).toBe("Line1\nLine2");
  });

  it("returns undefined for a missing file", async () => {
    const root = await makeTmpDir();
    expect(await readField(root, "en-US", "title.txt")).toBeUndefined();
  });
});

describe("resolveFieldPath", () => {
  it("returns the plain file for normal fields", async () => {
    const root = await makeTmpDir();
    expect(await resolveFieldPath(root, "en-US", getField("play", "title"))).toBe("title.txt");
  });

  it("picks the highest numeric changelog of the source locale", async () => {
    const root = await makeTmpDir();
    await mkdir(join(root, "en-US", "changelogs"), { recursive: true });
    for (const f of ["9.txt", "12.txt", "default.txt", "3.txt"]) {
      await writeFile(join(root, "en-US", "changelogs", f), "x");
    }
    expect(await resolveFieldPath(root, "en-US", getField("play", "changelog"))).toBe("changelogs/12.txt");
  });

  it("returns undefined when there are no changelogs", async () => {
    const root = await makeTmpDir();
    expect(await resolveFieldPath(root, "en-US", getField("play", "changelog"))).toBeUndefined();
  });
});
