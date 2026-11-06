import type { Config } from "../config/schema.js";
import { getField } from "../fields/registry.js";
import { fromStoreLocale } from "../locales/table.js";
import type { Logger } from "../log.js";
import { readField, storeRoot, writeField } from "../metadata/fastlane.js";
import type { StoreClient, StoreListing } from "../stores/types.js";
import { STORE_NAMES } from "./check.js";

export interface PullReport {
  written: number;
  unchanged: number;
  /** "<locale>/<file>" kept because the local file differs (use --force to overwrite). */
  skipped: string[];
  /** Store codes that are not in storelingo's language table. */
  unknownLocales: string[];
}

const SAFE_LOCALE = /^[A-Za-z0-9-]{2,20}$/;
const trimTrailingNewlines = (s: string) => s.replace(/\n+$/, "");

export async function runPull(opts: {
  config: Config;
  cwd: string;
  client: StoreClient;
  log: Logger;
  force?: boolean;
}): Promise<PullReport> {
  const { config, cwd, client, log } = opts;
  const root = storeRoot(config, cwd, client.store);
  const report: PullReport = { written: 0, unchanged: 0, skipped: [], unknownLocales: [] };

  const session = await client.open();
  let listings: StoreListing[];
  try {
    listings = await session.listings();
  } finally {
    await session.abort(); // pull never changes the store
  }

  for (const listing of listings) {
    if (!SAFE_LOCALE.test(listing.locale)) {
      log.warn(`skipped a listing with an unexpected language code ${JSON.stringify(listing.locale)}`);
      continue;
    }
    if (!fromStoreLocale(client.store, listing.locale)) report.unknownLocales.push(listing.locale);
    for (const [key, value] of Object.entries(listing.fields)) {
      const field = getField(client.store, key);
      const existing = await readField(root, listing.locale, field.file);
      if (existing !== undefined && trimTrailingNewlines(existing) === trimTrailingNewlines(value)) {
        report.unchanged++;
        continue;
      }
      if (existing !== undefined && existing.trim() !== "" && !opts.force) {
        report.skipped.push(`${listing.locale}/${field.file}`);
        continue;
      }
      await writeField(root, listing.locale, field.file, value);
      report.written++;
    }
  }

  if (report.unknownLocales.length > 0) {
    log.warn(
      `${STORE_NAMES[client.store]} languages not in storelingo's table (pulled, but cannot be translation targets): ${report.unknownLocales.join(", ")}`,
    );
  }
  return report;
}
