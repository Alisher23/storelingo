import type { Config } from "../config/schema.js";
import { fieldsFor, type StoreId } from "../fields/registry.js";
import { toStoreLocale } from "../locales/table.js";
import { readField, storeRoot } from "../metadata/fastlane.js";
import type { StoreListing } from "./types.js";

/** Listings as they exist in the local fastlane folders, for the configured source and target locales. */
export async function readLocalListings(config: Config, cwd: string, store: StoreId): Promise<StoreListing[]> {
  const root = storeRoot(config, cwd, store);
  const fields = fieldsFor(store).filter((f) => f.kind !== "changelog");
  const listings: StoreListing[] = [];

  for (const code of [config.sourceLocale, ...config.targetLocales]) {
    const storeLocale = toStoreLocale(store, code);
    if (!storeLocale) continue;
    const values: Record<string, string> = {};
    for (const field of fields) {
      const text = await readField(root, storeLocale, field.file);
      if (text !== undefined && text.trim() !== "") values[field.key] = text.replace(/\n+$/, "");
    }
    if (Object.keys(values).length > 0) listings.push({ locale: storeLocale, fields: values });
  }
  return listings;
}
