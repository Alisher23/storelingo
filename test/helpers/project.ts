import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseConfig } from "../../src/config/load.js";
import type { Config } from "../../src/config/schema.js";
import { makeTmpDir } from "./tmp.js";

export const DEFAULT_TEST_CONFIG = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "ky"],
  stores: { play: { packageName: "com.example" }, appstore: { appId: "1" } },
  translator: { provider: "anthropic" },
};

/** Creates a temp project; `files` keys are paths relative to the project root. */
export async function makeProject(
  files: Record<string, string>,
  config: object = DEFAULT_TEST_CONFIG,
): Promise<{ cwd: string; config: Config }> {
  const cwd = await makeTmpDir();
  for (const [rel, content] of Object.entries(files)) {
    const full = join(cwd, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { cwd, config: parseConfig(config) };
}
