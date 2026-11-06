import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config/schema.js";
import { StorelingoError } from "../errors.js";
import type { FieldDef, StoreId } from "../fields/registry.js";
import { normalizeText } from "../util/text.js";

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

/** A store's metadata folder plus the project it must stay inside. */
export interface StoreRoot {
  projectRoot: string;
  root: string;
}

export function storeRoot(config: Config, cwd: string, store: StoreId): StoreRoot {
  const projectRoot = resolve(cwd);
  const root = resolve(projectRoot, config.paths[store] ?? DEFAULT_ROOTS[store]);
  if (!isInsideProject(projectRoot, root)) {
    throw new StorelingoError(
      "E_CONFIG",
      `paths.${store} points outside the project: ${config.paths[store]}`,
      "Use a path relative to the current directory, without \"..\".",
    );
  }
  return { projectRoot, root };
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** True when `target` is `projectRoot` or below it (pure path check, no I/O). */
export function isInsideProject(projectRoot: string, target: string): boolean {
  const rel = relative(projectRoot, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Refuses paths outside the project and any existing symlink between the project root and `target`. */
export async function assertSafePath(projectRoot: string, target: string): Promise<void> {
  const display = (p: string) => relative(projectRoot, p).split(sep).join("/");
  if (!isInsideProject(projectRoot, target)) {
    throw new StorelingoError(
      "E_CONFIG",
      `refusing to access a path outside the project: ${target}`,
      "Metadata paths must stay inside the current directory.",
    );
  }
  let current = projectRoot;
  for (const part of relative(projectRoot, target).split(sep).filter((p) => p.length > 0)) {
    current = join(current, part);
    let stats;
    try {
      stats = await lstat(current);
    } catch (err) {
      if (isNotFound(err)) return; // nothing below a missing component can be a symlink
      throw err;
    }
    if (stats.isSymbolicLink()) {
      throw new StorelingoError(
        "E_CONFIG",
        `refusing to follow symlink: ${display(current)}`,
        "storelingo does not follow symbolic links in metadata folders; replace the link with a real folder or file.",
      );
    }
  }
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

function filePath(r: StoreRoot, storeLocale: string, relPath: string): string {
  return join(r.root, storeLocale, ...relPath.split("/"));
}

export async function resolveFieldPath(
  r: StoreRoot,
  sourceStoreLocale: string,
  field: FieldDef,
): Promise<string | undefined> {
  if (field.kind !== "changelog") return field.file;
  const dir = join(r.root, sourceStoreLocale, field.file);
  await assertSafePath(r.projectRoot, dir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  // Highest version code wins; keep the file's own name (e.g. "007.txt"), not the parsed number.
  let best: { name: string; version: number } | undefined;
  for (const name of [...names].sort()) {
    const digits = /^(\d+)\.txt$/.exec(name)?.[1];
    if (digits === undefined) continue;
    const version = Number(digits);
    if (!best || version > best.version) best = { name, version };
  }
  return best ? `${field.file}/${best.name}` : undefined;
}

export async function readField(r: StoreRoot, storeLocale: string, relPath: string): Promise<string | undefined> {
  const file = filePath(r, storeLocale, relPath);
  await assertSafePath(r.projectRoot, file);
  try {
    return normalizeText(await readFile(file, "utf8"));
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/** Writes `text` normalized (no BOM, LF only) and returns exactly what was written, for hashing. */
export async function writeField(r: StoreRoot, storeLocale: string, relPath: string, text: string): Promise<string> {
  const target = filePath(r, storeLocale, relPath);
  await assertSafePath(r.projectRoot, target);
  const output = normalizeText(text);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, output, "utf8");
  return output;
}
