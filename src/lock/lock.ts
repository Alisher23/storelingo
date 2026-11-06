import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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

export async function loadLock(file: string): Promise<Lock> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
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
  await writeFile(file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
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
  if (force || target === undefined) return "translate";
  if (!entry || hashText(target) !== entry.outputHash) return "skip-manual-edit";
  if (entry.sourceHash === hashText(source)) return "skip-unchanged";
  return "translate";
}
