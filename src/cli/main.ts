import { Command, CommanderError } from "commander";
import { resolve } from "node:path";
import { runCheck } from "../commands/check.js";
import { promptInitAnswers, writeInitFiles, type InitAnswers } from "../commands/init.js";
import { runTranslate } from "../commands/translate.js";
import { CONFIG_FILE, loadConfig } from "../config/load.js";
import type { Config } from "../config/schema.js";
import { ExitCode, StorelingoError, exitCodeFor } from "../errors.js";
import { createLogger, type Logger } from "../log.js";
import { createTranslator } from "../translate/engine.js";
import { createLlmClient } from "../translate/providers/index.js";
import type { Translator } from "../translate/types.js";

export interface CliDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  makeTranslator?: (config: Config, env: NodeJS.ProcessEnv) => Translator;
  promptInit?: () => Promise<InitAnswers>;
}

const defaultDeps = (): CliDeps => ({
  cwd: process.cwd(),
  env: process.env,
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
});

const defaultTranslator = (config: Config, env: NodeJS.ProcessEnv): Translator =>
  createTranslator(createLlmClient(config.translator, env));

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
    .version("0.1.0")
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
