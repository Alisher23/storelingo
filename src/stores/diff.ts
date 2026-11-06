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

const PREVIEW_CHARS = 60;

function preview(value: string | undefined): string {
  if (value === undefined) return "(empty)";
  const chars = [...value];
  const shown = chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 3).join("")}...` : value;
  return JSON.stringify(shown);
}

export function formatDiff(diffs: ListingDiff[]): string[] {
  const lines: string[] = [];
  for (const diff of diffs) {
    lines.push(`${diff.locale}${diff.isNew ? " (new listing)" : ""}:`);
    for (const change of diff.changes) {
      lines.push(`  ${change.field}: ${preview(change.from)} → ${preview(change.to)}`);
    }
  }
  return lines;
}
