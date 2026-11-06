import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config/schema.js";
import type { FieldDef, StoreId } from "../fields/registry.js";

export const DEFAULT_ROOTS: Record<StoreId, string> = {
  play: "fastlane/metadata/android",
  appstore: "fastlane/metadata",
};

/** Folders inside fastlane/metadata that are not App Store locales. */
const APPSTORE_NON_LOCALE_DIRS = new Set([
  "android",
  "default",
  "review_information",
  "trade_representative_contact_information",
]);

export function storeRoot(config: Config, cwd: string, store: StoreId): string {
  return resolve(cwd, config.paths[store] ?? DEFAULT_ROOTS[store]);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

export async function listLocales(root: string, store: StoreId): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => store !== "appstore" || !APPSTORE_NON_LOCALE_DIRS.has(name))
    .sort();
}

function filePath(root: string, storeLocale: string, relPath: string): string {
  return join(root, storeLocale, ...relPath.split("/"));
}

export async function resolveFieldPath(
  root: string,
  sourceStoreLocale: string,
  field: FieldDef,
): Promise<string | undefined> {
  if (field.kind !== "changelog") return field.file;
  let names: string[];
  try {
    names = await readdir(join(root, sourceStoreLocale, field.file));
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  const versions = names
    .map((n) => /^(\d+)\.txt$/.exec(n)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  if (versions.length === 0) return undefined;
  return `${field.file}/${Math.max(...versions)}.txt`;
}

export async function readField(
  root: string,
  storeLocale: string,
  relPath: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath(root, storeLocale, relPath), "utf8");
    return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export async function writeField(
  root: string,
  storeLocale: string,
  relPath: string,
  text: string,
): Promise<void> {
  const target = filePath(root, storeLocale, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}
