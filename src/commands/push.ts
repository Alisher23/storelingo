import type { Config } from "../config/schema.js";
import { getField, type StoreId } from "../fields/registry.js";
import { toStoreLocale } from "../locales/table.js";
import type { Logger } from "../log.js";
import { resolveFieldPath, storeRoot } from "../metadata/fastlane.js";
import { computeDiff, formatDiff } from "../stores/diff.js";
import { readLocalListings } from "../stores/local.js";
import type { StoreClient } from "../stores/types.js";
import { STORE_NAMES, runCheck } from "./check.js";

export const REQUIRED_FOR_NEW: Record<StoreId, readonly string[]> = {
  play: ["title", "short_description", "full_description"],
  appstore: ["name", "description", "keywords"],
};

export interface PushReport {
  status: "pushed" | "nothing" | "dry-run" | "cancelled" | "blocked";
  locales: string[];
  problems: string[];
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
    const { diffs, problems } = computeDiff(local, remote, REQUIRED_FOR_NEW[store]);
    if (problems.length > 0) {
      await session.abort();
      return { status: "blocked", locales: [], problems: problems.map((p) => `${p.locale}: ${p.message}`) };
    }
    if (diffs.length === 0) {
      await session.abort();
      log.info(`Nothing to push: ${STORE_NAMES[store]} already matches your files.`);
      return { status: "nothing", locales: [], problems: [] };
    }

    const summary = formatDiff(diffs);
    for (const line of summary) log.info(line);
    const locales = diffs.map((d) => d.locale);
    if (opts.dryRun) {
      await session.abort();
      return { status: "dry-run", locales, problems: [] };
    }
    if (!(await opts.confirm(summary))) {
      await session.abort();
      return { status: "cancelled", locales, problems: [] };
    }

    for (const diff of diffs) await session.update(diff.merged);
    await session.commit();
    return { status: "pushed", locales, problems: [] };
  } catch (err) {
    await session.abort();
    throw err;
  }
}
