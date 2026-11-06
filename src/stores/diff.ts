import type { StoreListing } from "./types.js";

export interface FieldChange {
  field: string;
  from: string | undefined;
  to: string;
}

export interface ListingDiff {
  locale: string;
  isNew: boolean;
  changes: FieldChange[];
  /** The complete listing to send: remote fields overlaid with the changed local ones. */
  merged: StoreListing;
}

export interface DiffProblem {
  locale: string;
  message: string;
}

const trimTrailingNewlines = (s: string) => s.replace(/\n+$/, "");

export function computeDiff(
  local: StoreListing[],
  remote: StoreListing[],
  requiredForNew: readonly string[],
): { diffs: ListingDiff[]; problems: DiffProblem[] } {
  const remoteByLocale = new Map(remote.map((r) => [r.locale, r]));
  const diffs: ListingDiff[] = [];
  const problems: DiffProblem[] = [];

  for (const listing of local) {
    const current = remoteByLocale.get(listing.locale);
    const isNew = current === undefined;
    if (isNew) {
      const missing = requiredForNew.filter((key) => !listing.fields[key]?.trim());
      if (missing.length > 0) {
        problems.push({ locale: listing.locale, message: `a new listing needs ${missing.join(", ")}` });
        continue;
      }
    }
    const merged: StoreListing = { locale: listing.locale, fields: { ...(current?.fields ?? {}) } };
    const changes: FieldChange[] = [];
    for (const [field, value] of Object.entries(listing.fields)) {
      const to = trimTrailingNewlines(value);
      const from = current?.fields[field];
      if (from !== undefined && trimTrailingNewlines(from) === to) continue;
      merged.fields[field] = to;
      changes.push({ field, from, to });
    }
    if (changes.length > 0) diffs.push({ locale: listing.locale, isNew, changes, merged });
  }
  return { diffs, problems };
}

const WINDOW_CHARS = 60;
const CONTEXT_BEFORE = 20;

function firstDifference(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** Shows the value in full when short, else a window starting `start` code points in. */
function show(chars: string[] | undefined, start: number): string {
  if (chars === undefined) return "(empty)";
  if (chars.length <= WINDOW_CHARS) return JSON.stringify(chars.join(""));
  const end = Math.min(chars.length, start + WINDOW_CHARS);
  const body = chars.slice(start, end).join("");
  return JSON.stringify(`${start > 0 ? "..." : ""}${body}${end < chars.length ? "..." : ""}`);
}

function describeChange(change: FieldChange): string {
  const from = change.from === undefined ? undefined : [...change.from];
  const to = [...change.to];
  const start = Math.max(0, (from === undefined ? 0 : firstDifference(from, to)) - CONTEXT_BEFORE);
  let label = change.field;
  if (to.length > WINDOW_CHARS || (from?.length ?? 0) > WINDOW_CHARS) {
    label += from === undefined ? ` (${to.length} chars)` : ` (${from.length} → ${to.length} chars)`;
  }
  return `  ${label}: ${show(from, start)} → ${show(to, start)}`;
}

export function formatDiff(diffs: ListingDiff[]): string[] {
  const lines: string[] = [];
  for (const diff of diffs) {
    lines.push(`${diff.locale}${diff.isNew ? " (new listing)" : ""}:`);
    for (const change of diff.changes) lines.push(describeChange(change));
  }
  return lines;
}
