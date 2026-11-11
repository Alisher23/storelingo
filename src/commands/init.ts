import { checkbox, input, select } from "@inquirer/prompts";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG_FILE, parseConfig } from "../config/load.js";
import { StorelingoError } from "../errors.js";
import type { StoreId } from "../fields/registry.js";
import { LOCALES, toStoreLocale } from "../locales/table.js";
import { DEFAULT_ROOTS, assertSafePath } from "../metadata/fastlane.js";

export interface InitAnswers {
  sourceLocale: string;
  targetLocales: string[];
  playPackageName?: string;
  appstoreAppId?: string;
  provider: "anthropic" | "openai-compatible";
  baseUrl?: string;
  model?: string;
  context: string;
}

export interface InitChange {
  action: "created" | "updated";
  path: string;
}

const GITIGNORE_LINES = ["*.p8", "play-service-account*.json"];

export function buildConfigJson(a: InitAnswers): Record<string, unknown> {
  const stores: Record<string, unknown> = {};
  if (a.playPackageName) stores.play = { packageName: a.playPackageName };
  if (a.appstoreAppId) stores.appstore = { appId: a.appstoreAppId };
  const translator =
    a.provider === "anthropic"
      ? { provider: "anthropic", ...(a.model ? { model: a.model } : {}) }
      : { provider: "openai-compatible", baseUrl: a.baseUrl, model: a.model };
  return {
    sourceLocale: a.sourceLocale,
    targetLocales: a.targetLocales,
    stores,
    translator,
    context: a.context,
    glossary: { doNotTranslate: [], terms: {} },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function writeInitFiles(
  cwd: string,
  answers: InitAnswers,
  opts: { force?: boolean } = {},
): Promise<InitChange[]> {
  const json = buildConfigJson(answers);
  const config = parseConfig(json); // validate before touching disk
  const configPath = join(cwd, CONFIG_FILE);
  const gitignorePath = join(cwd, ".gitignore");
  // A planted symlink must not redirect our writes outside the project.
  await assertSafePath(resolve(cwd), configPath);
  await assertSafePath(resolve(cwd), gitignorePath);
  if (!opts.force && (await exists(configPath))) {
    throw new StorelingoError("E_USAGE", `${CONFIG_FILE} already exists`, "Use `storelingo init --force` to overwrite it.");
  }

  const created: InitChange[] = [];
  await writeFile(configPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  created.push({ action: "created", path: CONFIG_FILE });

  for (const store of ["play", "appstore"] as StoreId[]) {
    if (!config.stores[store]) continue;
    const storeLocale = toStoreLocale(store, config.sourceLocale);
    if (!storeLocale) continue;
    const rel = `${DEFAULT_ROOTS[store]}/${storeLocale}`;
    await mkdir(join(cwd, ...rel.split("/")), { recursive: true });
    created.push({ action: "created", path: rel });
  }

  const hadGitignore = await exists(gitignorePath);
  const current = hadGitignore ? await readFile(gitignorePath, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length > 0) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
    created.push({ action: hadGitignore ? "updated" : "created", path: ".gitignore" });
  }
  return created;
}

export async function promptInitAnswers(): Promise<InitAnswers> {
  const localeChoices = LOCALES.map((l) => ({ name: `${l.name} (${l.code})`, value: l.code }));
  const sourceLocale = await select({ message: "Source language of your listing", choices: localeChoices, default: "en-US" });
  const targetLocales = await checkbox({
    message: "Languages to translate into",
    choices: localeChoices.filter((c) => c.value !== sourceLocale),
    required: true,
  });
  const stores = await checkbox({
    message: "Stores",
    choices: [
      { name: "Google Play", value: "play", checked: true },
      { name: "App Store", value: "appstore", checked: true },
    ],
    required: true,
  });
  const playPackageName = stores.includes("play")
    ? await input({ message: "Google Play package name (e.g. com.example.app)", required: true })
    : undefined;
  const appstoreAppId = stores.includes("appstore")
    ? (
        await input({
          message: "App Store app ID (numbers from App Store Connect)",
          required: true,
          validate: (v) =>
            /^[0-9]+$/.test(v.trim()) || "Enter the numeric Apple ID from App Store Connect (App Information)",
        })
      ).trim()
    : undefined;
  const provider = await select({
    message: "Translator",
    choices: [
      { name: "Claude API (ANTHROPIC_API_KEY)", value: "anthropic" as const },
      { name: "OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama…)", value: "openai-compatible" as const },
    ],
  });
  const baseUrl =
    provider === "openai-compatible"
      ? await input({ message: "Base URL (e.g. https://api.openai.com/v1)", required: true })
      : undefined;
  const model = provider === "openai-compatible" ? await input({ message: "Model name", required: true }) : undefined;
  const context = await input({ message: "One sentence about your app (helps the translator)", default: "" });
  return { sourceLocale, targetLocales, playPackageName, appstoreAppId, provider, baseUrl, model, context };
}
