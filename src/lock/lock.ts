import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { StorelingoError } from "../errors.js";
import type { StoreId } from "../fields/registry.js";

export const LOCK_FILE = "storelingo.lock.json";

export interface LockEntry {
  sourceHash: string;
  outputHash: string;
}

export interface Lock {
  version: 1;
  entries: Record<string, LockEntry>;
}

const LockSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({ sourceHash: z.string(), outputHash: z.string() })),
});

export function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function lockKey(store: StoreId, storeLocale: string, fieldKey: string): string {
  return `${store}/${storeLocale}/${fieldKey}`;
}

/** The lock file may come from someone else's repository: never read or write through a symlink. */
async function assertNotSymlink(file: string): Promise<void> {
  let isLink: boolean;
  try {
    isLink = (await lstat(file)).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (isLink) {
    throw new StorelingoError(
      "E_CONFIG",
      `refusing to follow symlink: ${LOCK_FILE}`,
      `Replace ${LOCK_FILE} with a regular file.`,
    );
  }
}

export async function loadLock(file: string): Promise<Lock> {
  await assertNotSymlink(file);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    raw = undefined;
  }
  const parsed = LockSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StorelingoError(
      "E_CONFIG",
      `Lock file is corrupt: ${file}`,
      "Delete it and run `npx storelingo translate --force` to rebuild.",
    );
  }
  return parsed.data;
}

export async function saveLock(file: string, lock: Lock): Promise<void> {
  const entries = Object.fromEntries(
    Object.keys(lock.entries)
      .sort()
      .map((k) => [k, lock.entries[k]]),
  );
  await assertNotSymlink(file);
  // Unpredictable name + exclusive create: a file or symlink planted at the temp path is never written through.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export type Decision = "translate" | "skip-empty-source" | "skip-unchanged" | "skip-manual-edit";

export function decide(args: {
  source: string | undefined;
  target: string | undefined;
  entry: LockEntry | undefined;
  force: boolean;
}): Decision {
  const { source, target, entry, force } = args;
  if (source === undefined || source.trim() === "") return "skip-empty-source";
  // An empty or whitespace-only target counts as missing, never as a manual edit.
  if (force || target === undefined || target.trim() === "") return "translate";
  if (!entry || hashText(target) !== entry.outputHash) return "skip-manual-edit";
  if (entry.sourceHash === hashText(source)) return "skip-unchanged";
  return "translate";
}
