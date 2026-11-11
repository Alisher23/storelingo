import { StorelingoError } from "../errors.js";
import type { Config } from "../config/schema.js";
import { getField, type StoreId } from "../fields/registry.js";
import { toStoreLocale } from "../locales/table.js";
import type { Logger } from "../log.js";
import { resolveFieldPath, storeRoot } from "../metadata/fastlane.js";
import { computeDiff, formatDiff, type ListingDiff } from "../stores/diff.js";
import { readLocalListings } from "../stores/local.js";
import type { StoreClient, StoreSession } from "../stores/types.js";
import { STORE_NAMES, runCheck } from "./check.js";

export const REQUIRED_FOR_NEW: Record<StoreId, readonly string[]> = {
  play: ["title", "short_description", "full_description"],
  appstore: ["name", "description", "keywords"],
};

export interface PushReport {
  status: "pushed" | "nothing" | "dry-run" | "cancelled" | "blocked";
  locales: string[];
  problems: string[];
  skipped: string[];
}

export async function runPush(opts: {
  config: Config;
  cwd: string;
  client: StoreClient;
  log: Logger;
  dryRun?: boolean;
  confirm: (summary: string[]) => Promise<boolean>;
}): Promise<PushReport> {
  const { config, cwd, client, log } = opts;
  const store = client.store;

  const checkErrors = (await runCheck(config, cwd)).filter((i) => i.store === store && i.level === "error");
  if (checkErrors.length > 0) {
    return {
      status: "blocked",
      locales: [],
      problems: checkErrors.map((i) => `${i.locale}${i.field ? `/${i.field}` : ""}: ${i.message}`),
      skipped: [],
    };
  }

  if (store === "play") {
    const sourceStoreLocale = toStoreLocale(store, config.sourceLocale);
    const changelog =
      sourceStoreLocale &&
      (await resolveFieldPath(storeRoot(config, cwd, store), sourceStoreLocale, getField(store, "changelog")));
    if (changelog) log.info("Changelogs (release notes) are not uploaded by storelingo yet; use `fastlane supply` for them.");
  }

  const local = await readLocalListings(config, cwd, store);
  const session = await client.open();
  try {
    const remote = await session.listings();
    for (const note of session.notes ?? []) log.info(note);
    const computed = computeDiff(local, remote, REQUIRED_FOR_NEW[store]);
    const problems = computed.problems.map((p) => `${p.locale}: ${p.message}`);
    const { diffs, skipped } = applyWritability(computed.diffs, session, store, problems);
    if (problems.length > 0) {
      await session.abort();
      return { status: "blocked", locales: [], problems, skipped: [] };
    }
    if (diffs.length === 0 && skipped.length > 0) {
      await session.abort();
      throw new StorelingoError(
        "E_NO_EDITABLE_VERSION",
        "Nothing can be pushed: every change needs an editable version in App Store Connect",
        "Create a new version in App Store Connect, then push again.",
      );
    }
    if (diffs.length === 0) {
      await session.abort();
      log.info(`Nothing to push: ${STORE_NAMES[store]} already matches your files.`);
      return { status: "nothing", locales: [], problems: [], skipped: [] };
    }

    const summary = [...formatDiff(diffs), ...skipped];
    for (const line of summary) log.info(line);
    const locales = diffs.map((d) => d.locale);
    if (opts.dryRun) {
      await session.abort();
      return { status: "dry-run", locales, problems: [], skipped };
    }
    if (!(await opts.confirm(summary))) {
      await session.abort();
      return { status: "cancelled", locales, problems: [], skipped };
    }

    const applied: string[] = [];
    for (const diff of diffs) {
      try {
        await session.update(diff.merged);
        applied.push(diff.locale);
      } catch (err) {
        if (session.atomic === false && applied.length > 0) {
          const rest = locales.filter((l) => !applied.includes(l));
          const message = err instanceof Error ? err.message : String(err);
          throw new StorelingoError(
            err instanceof StorelingoError ? err.code : "E_STORE",
            `${message} — already applied: ${applied.join(", ")}; not applied: ${rest.join(", ")}`,
            "Re-run `storelingo push`: it only sends what still differs.",
          );
        }
        throw err;
      }
    }
    await session.commit();
    return { status: "pushed", locales, problems: [], skipped };
  } catch (err) {
    await session.abort();
    throw err;
  }
}

/** Moves changes the session cannot write into `skipped`; a new listing missing a writable required field becomes a problem. */
function applyWritability(
  diffs: ListingDiff[],
  session: StoreSession,
  store: StoreId,
  problems: string[],
): { diffs: ListingDiff[]; skipped: string[] } {
  const writable = (field: string) => session.isWritable?.(field) !== false;
  const reason = store === "appstore" ? "no editable version in App Store Connect" : "the store can't take this field";
  const kept: ListingDiff[] = [];
  const skipped: string[] = [];
  for (const diff of diffs) {
    if (diff.isNew && REQUIRED_FOR_NEW[store].some((f) => !writable(f))) {
      problems.push(`${diff.locale}: a new listing needs an editable app info and version in App Store Connect`);
      continue;
    }
    const fields = { ...diff.merged.fields };
    const changes = diff.changes.filter((c) => {
      if (writable(c.field)) return true;
      skipped.push(`${diff.locale}/${c.field}: skipped (${reason})`);
      if (c.from === undefined) delete fields[c.field];
      else fields[c.field] = c.from;
      return false;
    });
    if (changes.length > 0) kept.push({ ...diff, changes, merged: { locale: diff.locale, fields } });
  }
  return { diffs: kept, skipped };
}
