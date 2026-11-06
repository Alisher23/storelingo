import { readFile } from "node:fs/promises";
import { StorelingoError } from "../errors.js";
import { LOCALES, findLocale } from "../locales/table.js";
import { ConfigSchema, type Config } from "./schema.js";

export const CONFIG_FILE = "storelingo.config.json";

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new StorelingoError("E_CONFIG", `Invalid config: ${details}`);
  }
  const config = result.data;

  const unknown = [config.sourceLocale, ...config.targetLocales].filter((c) => !findLocale(c));
  if (unknown.length > 0) {
    throw new StorelingoError(
      "E_CONFIG",
      `Unknown locale code(s): ${unknown.join(", ")}`,
      `Supported codes: ${LOCALES.map((l) => l.code).join(", ")} (see Supported languages in the README).`,
    );
  }
  if (config.targetLocales.includes(config.sourceLocale)) {
    throw new StorelingoError("E_CONFIG", "targetLocales must not include the source locale");
  }
  return config;
}

export async function loadConfig(file: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StorelingoError(
        "E_CONFIG",
        `Config file not found: ${file}`,
        "Run `npx storelingo init` to create one.",
      );
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new StorelingoError("E_CONFIG", `Config file is not valid JSON: ${file}`);
  }
  return parseConfig(raw);
}
