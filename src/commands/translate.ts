import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { StorelingoError } from "../errors.js";
import { fieldsFor, type StoreId } from "../fields/registry.js";
import { findLocale, toStoreLocale, type LocaleDef } from "../locales/table.js";
import { LOCK_FILE, decide, hashText, loadLock, lockKey, saveLock } from "../lock/lock.js";
import type { Logger } from "../log.js";
import { readField, resolveFieldPath, storeRoot, writeField, type StoreRoot } from "../metadata/fastlane.js";
import { ZERO_USAGE, addUsage, type FieldToTranslate, type Translator, type Usage } from "../translate/types.js";
import { runPool } from "../util/pool.js";
import { STORE_NAMES, configuredStores } from "./check.js";

export interface TranslateOptions {
  config: Config;
  cwd: string;
  translator: Translator;
  log: Logger;
  locales?: string[];
  force?: boolean;
}

export interface TranslateFailure {
  store: StoreId;
  locale: string;
  field?: string;
  message: string;
}

export interface TranslateReport {
  translated: number;
  unchanged: number;
  manual: number;
  unsupported: number;
  failed: TranslateFailure[];
  usage: Usage;
}

interface PendingField extends FieldToTranslate {
  rel: string;
  source: string;
  trailing: string;
}

interface Job {
  store: StoreId;
  root: StoreRoot;
  storeLocale: string;
  target: LocaleDef;
  fields: PendingField[];
}

export async function runTranslate(opts: TranslateOptions): Promise<TranslateReport> {
  const { config, cwd, translator, log } = opts;
  const targets = opts.locales ?? config.targetLocales;
  const outside = targets.filter((l) => !config.targetLocales.includes(l));
  if (outside.length > 0) {
    throw new StorelingoError(
      "E_USAGE",
      `--locale ${outside.join(", ")} is not in targetLocales`,
      `Configured targets: ${config.targetLocales.join(", ")}`,
    );
  }

  const lockFile = join(cwd, LOCK_FILE);
  const lock = await loadLock(lockFile);
  const sourceLocale = findLocale(config.sourceLocale) as LocaleDef;
  const report: TranslateReport = { translated: 0, unchanged: 0, manual: 0, unsupported: 0, failed: [], usage: ZERO_USAGE };
  const jobs: Job[] = [];

  for (const store of configuredStores(config)) {
    const root = storeRoot(config, cwd, store);
    const sourceStoreLocale = toStoreLocale(store, config.sourceLocale);
    if (!sourceStoreLocale) {
      throw new StorelingoError(
        "E_LOCALE_UNSUPPORTED",
        `${STORE_NAMES[store]} does not support the source locale ${config.sourceLocale}`,
      );
    }
    for (const code of targets) {
      const storeLocale = toStoreLocale(store, code);
      if (!storeLocale) {
        report.unsupported++;
        log.warn(`${STORE_NAMES[store]} does not support ${code}; skipped`);
        continue;
      }
      const fields: PendingField[] = [];
      for (const field of fieldsFor(store).filter((f) => f.translatable)) {
        const rel = await resolveFieldPath(root, sourceStoreLocale, field);
        if (!rel) continue;
        const source = await readField(root, sourceStoreLocale, rel);
        const target = await readField(root, storeLocale, rel);
        const decision = decide({
          source,
          target,
          entry: lock.entries[lockKey(store, storeLocale, field.key)],
          force: opts.force ?? false,
        });
        if (decision === "skip-unchanged") report.unchanged++;
        if (decision === "skip-manual-edit") {
          report.manual++;
          log.info(`skipped ${store}/${storeLocale}/${field.key}: edited manually (use --force to overwrite)`);
        }
        if (decision !== "translate" || source === undefined) continue;
        const body = source.replace(/\n+$/, "");
        fields.push({
          key: field.key,
          kind: field.kind,
          maxChars: field.maxChars,
          text: body,
          rel,
          source,
          trailing: source.slice(body.length),
        });
      }
      if (fields.length > 0) {
        jobs.push({ store, root, storeLocale, target: findLocale(code) as LocaleDef, fields });
      }
    }
  }

  const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let saving: Promise<void> = Promise.resolve();
  let saveFailureReported = false;
  const persistLock = (job: Job) => {
    saving = saving.then(() => saveLock(lockFile, lock)).catch((err: unknown) => {
      if (saveFailureReported) return;
      saveFailureReported = true;
      report.failed.push({
        store: job.store,
        locale: job.storeLocale,
        message: `could not save ${LOCK_FILE}: ${errMsg(err)}`,
      });
    });
    return saving;
  };

  await runPool(jobs, config.translator.concurrency, async (job) => {
    log.debug(`translating ${job.store}/${job.storeLocale} (${job.fields.length} fields)`);
    let result;
    try {
      result = await translator.translate({
        store: job.store,
        sourceLocale,
        targetLocale: job.target,
        fields: job.fields.map(({ key, text, maxChars, kind }) => ({ key, text, maxChars, kind })),
        context: config.context,
        doNotTranslate: config.glossary.doNotTranslate,
        terms: config.glossary.terms[job.target.code] ?? {},
      });
    } catch (err) {
      report.failed.push({ store: job.store, locale: job.storeLocale, message: errMsg(err) });
      return;
    }
    report.usage = addUsage(report.usage, result.usage);

    for (const field of job.fields) {
      const text = result.texts[field.key];
      if (text === undefined) {
        report.failed.push({
          store: job.store,
          locale: job.storeLocale,
          field: field.key,
          message: result.errors[field.key] ?? "no translation returned",
        });
        continue;
      }
      const output = `${text}${field.trailing}`;
      try {
        await writeField(job.root, job.storeLocale, field.rel, output);
      } catch (err) {
        report.failed.push({ store: job.store, locale: job.storeLocale, field: field.key, message: errMsg(err) });
        continue;
      }
      lock.entries[lockKey(job.store, job.storeLocale, field.key)] = {
        sourceHash: hashText(field.source),
        outputHash: hashText(output),
      };
      report.translated++;
      await persistLock(job);
    }
  });

  await saving;
  return report;
}
