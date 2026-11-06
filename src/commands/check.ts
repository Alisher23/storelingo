import type { Config } from "../config/schema.js";
import { STORES, fieldsFor, type StoreId } from "../fields/registry.js";
import { toStoreLocale } from "../locales/table.js";
import { readField, resolveFieldPath, storeRoot } from "../metadata/fastlane.js";
import { normalizeKeywords } from "../translate/keywords.js";
import { countChars } from "../util/chars.js";

export interface CheckIssue {
  level: "error" | "warning";
  store: StoreId;
  locale: string;
  field?: string;
  code: string;
  message: string;
}

export const STORE_NAMES: Record<StoreId, string> = { play: "Google Play", appstore: "App Store" };

export function configuredStores(config: Config): StoreId[] {
  return STORES.filter((s) => config.stores[s] !== undefined);
}

export async function runCheck(config: Config, cwd: string): Promise<CheckIssue[]> {
  const issues: CheckIssue[] = [];

  for (const store of configuredStores(config)) {
    const root = storeRoot(config, cwd, store);
    const sourceStoreLocale = toStoreLocale(store, config.sourceLocale);
    if (!sourceStoreLocale) {
      issues.push({
        level: "error",
        store,
        locale: config.sourceLocale,
        code: "E_LOCALE_UNSUPPORTED",
        message: `${STORE_NAMES[store]} does not support the source locale ${config.sourceLocale}`,
      });
      continue;
    }

    for (const locale of [config.sourceLocale, ...config.targetLocales]) {
      const storeLocale = toStoreLocale(store, locale);
      if (!storeLocale) {
        issues.push({
          level: "warning",
          store,
          locale,
          code: "E_LOCALE_UNSUPPORTED",
          message: `${STORE_NAMES[store]} does not support ${locale}; skipped`,
        });
        continue;
      }
      const isSource = locale === config.sourceLocale;

      for (const field of fieldsFor(store)) {
        const rel = await resolveFieldPath(root, sourceStoreLocale, field);
        if (!rel) continue;
        const text = await readField(root, storeLocale, rel);
        const at = { store, locale: storeLocale, field: field.key };

        if (text === undefined || text.trim() === "") {
          if (isSource && field.required) {
            issues.push({ ...at, level: "error", code: "E_MISSING", message: `missing ${rel}` });
          } else if (!isSource && field.translatable) {
            const source = await readField(root, sourceStoreLocale, rel);
            if (source !== undefined && source.trim() !== "") {
              issues.push({ ...at, level: "warning", code: "W_MISSING", message: "not translated yet" });
            }
          }
          continue;
        }

        const body = text.replace(/\n+$/, "");
        if (field.maxChars !== null && countChars(body) > field.maxChars) {
          issues.push({
            ...at,
            level: "error",
            code: "E_LIMIT",
            message: `${countChars(body)} characters, limit is ${field.maxChars}`,
          });
        }
        if (field.kind === "keywords" && normalizeKeywords(body) !== body) {
          issues.push({
            ...at,
            level: "error",
            code: "E_FORMAT",
            message: 'keywords must be comma-separated without spaces or duplicates, e.g. "quran,qibla,prayer"',
          });
        }
      }
    }
  }
  return issues;
}
