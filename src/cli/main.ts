import { confirm as promptConfirm } from "@inquirer/prompts";
import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { STORE_NAMES, runCheck } from "../commands/check.js";
import { promptInitAnswers, writeInitFiles, type InitAnswers } from "../commands/init.js";
import { runPull } from "../commands/pull.js";
import { runPush } from "../commands/push.js";
import { runTranslate } from "../commands/translate.js";
import { CONFIG_FILE, loadConfig } from "../config/load.js";
import type { Config } from "../config/schema.js";
import { ExitCode, StorelingoError, exitCodeFor } from "../errors.js";
import type { StoreId } from "../fields/registry.js";
import { createLogger, type Logger } from "../log.js";
import { createTranslator } from "../translate/engine.js";
import { createTokenProvider, loadServiceAccount } from "../stores/google-play/auth.js";
import { createPlayApi } from "../stores/google-play/client.js";
import { createPlayStore } from "../stores/google-play/store.js";
import type { StoreClient } from "../stores/types.js";
import { createLlmClient } from "../translate/providers/index.js";
import type { Translator } from "../translate/types.js";

export interface CliDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  makeTranslator?: (config: Config, env: NodeJS.ProcessEnv) => Translator;
  promptInit?: () => Promise<InitAnswers>;
  makeStore?: (store: StoreId, config: Config, env: NodeJS.ProcessEnv) => Promise<StoreClient>;
  confirm?: (message: string) => Promise<boolean>;
  isTTY?: boolean;
}

const defaultDeps = (): CliDeps => ({
  cwd: process.cwd(),
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
});

const defaultTranslator = (config: Config, env: NodeJS.ProcessEnv): Translator =>
  createTranslator(createLlmClient(config.translator, env));

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

const defaultMakeStore = async (store: StoreId, config: Config, env: NodeJS.ProcessEnv): Promise<StoreClient> => {
  if (store !== "play" || !config.stores.play) {
    throw new StorelingoError("E_USAGE", `store ${store} is not supported yet`);
  }
  const account = await loadServiceAccount(env);
  const tokens = createTokenProvider({ account });
  const api = createPlayApi({ packageName: config.stores.play.packageName, getToken: () => tokens.getToken() });
  return createPlayStore(api);
};

/** v0.2 supports Google Play only; validated before any network call. */
function selectStore(option: string | undefined, config: Config, log: Logger): StoreId {
  if (option === "appstore") {
    throw new StorelingoError("E_USAGE", "App Store pull/push arrives in v0.3", "Use --store play (the default).");
  }
  if (option !== undefined && option !== "play") {
    throw new StorelingoError("E_USAGE", `--store must be play or appstore, got ${JSON.stringify(option)}`);
  }
  if (!config.stores.play) {
    throw new StorelingoError(
      "E_CONFIG",
      "stores.play is not configured",
      "Add stores.play.packageName to storelingo.config.json.",
    );
  }
  if (option === undefined && config.stores.appstore) {
    log.info("App Store pull/push is not supported yet (planned for v0.3); using Google Play only.");
  }
  return "play";
}

interface GlobalOpts {
  config?: string;
  verbose?: boolean;
}

export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let exitCode: number = ExitCode.OK;
  const program = new Command();

  const secrets = [
    deps.env.ANTHROPIC_API_KEY,
    deps.env.OPENAI_API_KEY,
    deps.env.STORELINGO_TRANSLATOR_API_KEY,
  ];
  const logger = (): Logger =>
    createLogger({
      verbose: program.opts<GlobalOpts>().verbose ?? false,
      secrets,
      out: deps.out,
      err: deps.err,
    });
  // Raw (unprefixed) stderr line with secrets masked: the logger masks info() and sends it to `out`.
  const maskedErr = createLogger({ verbose: false, secrets, out: deps.err, err: deps.err }).info;
  const configPath = () => resolve(deps.cwd, program.opts<GlobalOpts>().config ?? CONFIG_FILE);

  program
    .name("storelingo")
    .description("AI localization for Google Play and App Store listings (fastlane metadata).")
    .version(pkg.version)
    .option("--config <path>", `path to the config file (default: ${CONFIG_FILE})`)
    .option("--verbose", "print debug output")
    .option("--no-color", "disable colors")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.out(s.trimEnd()),
      writeErr: (s) => deps.err(s.trimEnd()),
    });

  program
    .command("init")
    .description("create storelingo.config.json and fastlane folders")
    .option("--force", "overwrite an existing config")
    .action(async (opts: { force?: boolean }) => {
      const log = logger();
      const answers = await (deps.promptInit ?? promptInitAnswers)();
      const created = await writeInitFiles(deps.cwd, answers, { force: opts.force });
      for (const change of created) log.info(`${change.action} ${change.path}`);
      log.info(
        "Set ANTHROPIC_API_KEY (Claude), or for OpenAI-compatible: OPENAI_API_KEY for api.openai.com, " +
          "otherwise STORELINGO_TRANSLATOR_API_KEY + STORELINGO_TRANSLATOR_API_HOST.",
      );
      log.info("Next: put your source texts into the folders above, then run `npx storelingo translate`.");
    });

  program
    .command("check")
    .description("validate limits, missing fields and keyword format (offline)")
    .action(async () => {
      const log = logger();
      const config = await loadConfig(configPath());
      const issues = await runCheck(config, deps.cwd);
      for (const i of issues) {
        const where = `${i.store}/${i.locale}${i.field ? `/${i.field}` : ""}`;
        deps.err(`${i.level} ${where}: ${i.message}`);
      }
      const errors = issues.filter((i) => i.level === "error").length;
      const warnings = issues.length - errors;
      log.info(`check: ${errors} error(s), ${warnings} warning(s)`);
      if (errors > 0) exitCode = ExitCode.FAILED;
    });

  program
    .command("translate")
    .description("translate changed fields into the target locales")
    .option("--locale <code...>", "only these target locales")
    .option("--force", "re-translate everything, including manual edits")
    .action(async (opts: { locale?: string[]; force?: boolean }) => {
      const log = logger();
      const config = await loadConfig(configPath());
      const translator = (deps.makeTranslator ?? defaultTranslator)(config, deps.env);
      const report = await runTranslate({
        config,
        cwd: deps.cwd,
        translator,
        log,
        locales: opts.locale,
        force: opts.force,
      });
      for (const f of report.failed) {
        log.error(`${f.store}/${f.locale}${f.field ? `/${f.field}` : ""}: ${f.message}`);
      }
      log.info(
        `Translated ${report.translated} fields; unchanged ${report.unchanged}; ` +
          `edited manually ${report.manual}; unsupported locales ${report.unsupported}; failed ${report.failed.length}. ` +
          `Tokens: ${report.usage.inputTokens} in / ${report.usage.outputTokens} out.`,
      );
      if (report.failed.length > 0) exitCode = ExitCode.FAILED;
    });

  program
    .command("pull")
    .description("download the current store listings into the fastlane folders")
    .option("--store <store>", "store to pull from (play)")
    .option("--force", "overwrite local files that differ from the store")
    .action(async (opts: { store?: string; force?: boolean }) => {
      const log = logger();
      const config = await loadConfig(configPath());
      const store = selectStore(opts.store, config, log);
      const client = await (deps.makeStore ?? defaultMakeStore)(store, config, deps.env);
      const report = await runPull({ config, cwd: deps.cwd, client, log, force: opts.force });
      log.info(
        `Pulled from ${STORE_NAMES[store]}: wrote ${report.written}, unchanged ${report.unchanged}, ` +
          `kept ${report.skipped.length} different local file(s) (use --force to overwrite).`,
      );
      for (const path of report.skipped) log.info(`  kept ${path}`);
    });

  program
    .command("push")
    .description("show the diff with the live listing and upload after confirmation")
    .option("--store <store>", "store to push to (play)")
    .option("--dry-run", "only show the diff")
    .option("--yes", "do not ask for confirmation (required outside a terminal)")
    .action(async (opts: { store?: string; dryRun?: boolean; yes?: boolean }) => {
      const log = logger();
      const config = await loadConfig(configPath());
      const store = selectStore(opts.store, config, log);
      const message = `Upload these changes to ${STORE_NAMES[store]}?`;
      const isTTY = deps.isTTY ?? process.stdin.isTTY === true;
      let ask: (summary: string[]) => Promise<boolean>;
      if (opts.yes) {
        ask = async () => true;
      } else if (deps.confirm) {
        const confirmFn = deps.confirm;
        ask = async () => confirmFn(message);
      } else if (isTTY) {
        ask = async () => promptConfirm({ message, default: false });
      } else if (opts.dryRun) {
        ask = async () => false;
      } else {
        throw new StorelingoError(
          "E_USAGE",
          "push needs --yes when not running in an interactive terminal (or use --dry-run)",
        );
      }
      const client = await (deps.makeStore ?? defaultMakeStore)(store, config, deps.env);
      const report = await runPush({ config, cwd: deps.cwd, client, log, dryRun: opts.dryRun, confirm: ask });
      switch (report.status) {
        case "pushed":
          log.info(
            `Pushed ${report.locales.length} listing(s) to ${STORE_NAMES[store]}: ${report.locales.join(", ")}. ` +
              "Google reviews listing changes before they go live.",
          );
          break;
        case "dry-run":
          log.info("Dry run: nothing was changed.");
          break;
        case "cancelled":
          log.info("Cancelled: nothing was changed.");
          break;
        case "blocked":
          for (const p of report.problems) log.error(p);
          log.error("Push blocked: fix the problems above (nothing was changed).");
          exitCode = ExitCode.FAILED;
          break;
        case "nothing":
          break;
      }
    });

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
    }
    if (err instanceof StorelingoError) {
      maskedErr(`error [${err.code}]: ${err.message}`);
      if (err.hint) maskedErr(`hint: ${err.hint}`);
    } else {
      maskedErr(`error: ${(err as Error).message}`);
    }
    return exitCodeFor(err);
  }
}
