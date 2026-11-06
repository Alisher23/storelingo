# storelingo v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `storelingo` v0.1 — an npm CLI with `init`, `translate` and `check` that localizes fastlane store-listing metadata with an LLM while respecting store character limits (no store uploads yet).

**Architecture:** Small single-purpose modules: data registries (`fields/`, `locales/`), pure logic (`lock/`, `translate/engine`, `commands/check`), I/O adapters (`metadata/`, `translate/providers/`), and a thin `cli/` layer. Every network or filesystem dependency is injected so logic is unit-tested without real keys.

**Tech Stack:** Node ≥ 22.13 (ESM), TypeScript strict, `commander`, `zod`, `@anthropic-ai/sdk`, `@inquirer/prompts`, vitest, eslint (typescript-eslint).

**Spec:** `docs/superpowers/specs/2026-11-06-storelingo-design.md` (v0.1 = milestone 1 in §11: `init`, `translate`, `check`; `pull`/`push` are later plans).

## Global Constraints

- Node `>=22.13` (Node 20 is end-of-life; commander 15, vitest 5 and @inquirer/prompts 8 need >=22.12/22.13), `"type": "module"`, `module`/`moduleResolution` `NodeNext`; relative imports end in `.js`.
- TypeScript `strict: true`. No `any` in `src/`.
- Runtime deps limited to: `commander`, `zod`, `@anthropic-ai/sdk`, `@inquirer/prompts`.
- Files are written UTF-8 without BOM with `\n` line endings; on read, strip BOM and convert `\r\n` → `\n`.
- Character limits count Unicode code points (`[...str].length`).
- Text is never truncated mechanically; an over-limit translation is an error.
- Secrets come only from env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `STORELINGO_TRANSLATOR_API_KEY`); never written to config, lock, logs or error messages. `OPENAI_API_KEY` is sent only to host `api.openai.com`; any other OpenAI-compatible host uses only `STORELINGO_TRANSLATOR_API_KEY`, and only when the baseUrl hostname equals `STORELINGO_TRANSLATOR_API_HOST` (else E_CONFIG). Non-loopback `baseUrl` must be https (http only for localhost, 127.0.0.1, [::1]).
- Exit codes: `0` success, `1` validation errors / partial failure, `2` bad usage or config.
- Default translator: `provider: "anthropic"`, `model: "claude-opus-5-5"`, `effort: "medium"`, `concurrency: 4`.
- Config file `storelingo.config.json`; lock file `storelingo.lock.json`; both in the project root (cwd).
- Default metadata roots: Play `fastlane/metadata/android`, App Store `fastlane/metadata`.
- All commits end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Map

```
package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, eslint.config.js
.gitignore, .gitattributes, LICENSE, .github/workflows/ci.yml
README.md, README.ru.md, CONTRIBUTING.md
src/
  bin.ts                         entry point (shebang)
  cli/main.ts                    commander program, output, exit codes
  errors.ts                      StorelingoError, exit codes
  log.ts                         logger with secret masking
  util/chars.ts                  countChars
  util/retry.ts                  withRetry, RetryableError
  util/pool.ts                   runPool
  fields/registry.ts             store field definitions (data)
  locales/table.ts               locale table + store code mapping (data)
  config/schema.ts               zod schema, Config type
  config/load.ts                 loadConfig, CONFIG_FILE
  metadata/fastlane.ts           read/write fastlane folders
  lock/lock.ts                   lock file + decide()
  translate/types.ts             Translator / LlmClient interfaces
  translate/keywords.ts          normalizeKeywords
  translate/prompt.ts            prompts
  translate/engine.ts            createTranslator (validation, limits)
  translate/providers/anthropic.ts
  translate/providers/openai-compatible.ts
  translate/providers/index.ts   createLlmClient
  commands/check.ts              runCheck
  commands/translate.ts          runTranslate
  commands/init.ts               writeInitFiles, promptInitAnswers
test/ mirrors src/ (one *.test.ts per module) + test/helpers/tmp.ts
```

---

### Task 1: Project scaffold and `countChars`

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `.gitattributes`, `LICENSE`, `.github/workflows/ci.yml`
- Create: `src/util/chars.ts`
- Test: `test/util/chars.test.ts`

**Interfaces:**
- Produces: `countChars(text: string): number`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "storelingo",
  "version": "0.1.0",
  "description": "AI localization for Google Play and App Store listings. Reads and writes fastlane metadata.",
  "type": "module",
  "bin": { "storelingo": "dist/bin.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "keywords": ["fastlane", "localization", "app-store", "google-play", "aso", "i18n", "llm", "claude"],
  "repository": { "type": "git", "url": "git+https://github.com/Alisher23/storelingo.git" },
  "license": "MIT"
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install commander zod @anthropic-ai/sdk @inquirer/prompts
npm install -D typescript vitest @types/node eslint typescript-eslint
```
Expected: `package.json` gains `dependencies` and `devDependencies`, `package-lock.json` created.

- [ ] **Step 3: Write TypeScript, vitest and eslint configs**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

`eslint.config.js`:
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 4: Write `.gitignore`, `.gitattributes`, `LICENSE`**

`.gitignore`:
```
node_modules/
dist/
*.tgz
.env
*.p8
play-service-account*.json
```

`.gitattributes`:
```
* text=auto eol=lf
```

`LICENSE`: the standard MIT License text with the line `Copyright (c) 2026 Alisher23`.

- [ ] **Step 5: Write the CI workflow `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 6: Write the failing test `test/util/chars.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { countChars } from "../../src/util/chars.js";

describe("countChars", () => {
  it("counts ASCII characters", () => {
    expect(countChars("Hello")).toBe(5);
  });
  it("counts an emoji as one code point", () => {
    expect(countChars("hi 👋")).toBe(4);
  });
  it("counts Arabic letters", () => {
    expect(countChars("مرحبا")).toBe(5);
  });
  it("counts a combining mark as its own code point", () => {
    expect(countChars("é")).toBe(2);
  });
  it("returns 0 for an empty string", () => {
    expect(countChars("")).toBe(0);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run test/util/chars.test.ts`
Expected: FAIL — cannot resolve `../../src/util/chars.js`.

- [ ] **Step 8: Implement `src/util/chars.ts`**

```ts
/** Number of Unicode code points — the unit Google Play and App Store limits use. */
export function countChars(text: string): number {
  return [...text].length;
}
```

- [ ] **Step 9: Run tests, typecheck and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 5 tests pass; tsc and eslint report no errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project with CI and countChars

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Errors and logger

**Files:**
- Create: `src/errors.ts`, `src/log.ts`
- Test: `test/errors.test.ts`, `test/log.test.ts`

**Interfaces:**
- Produces:
  - `type ErrorCode = "E_CONFIG" | "E_USAGE" | "E_AUTH_PLAY" | "E_AUTH_ASC" | "E_NO_EDITABLE_VERSION" | "E_LOCALE_UNSUPPORTED" | "E_LIMIT" | "E_MISSING" | "E_FORMAT" | "E_TRANSLATOR"`
  - `class StorelingoError extends Error { code: ErrorCode; hint?: string }` — `new StorelingoError(code, message, hint?)`
  - `const ExitCode = { OK: 0, FAILED: 1, USAGE: 2 }`
  - `exitCodeFor(err: unknown): number`
  - `interface Logger { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug(msg: string): void }`
  - `createLogger(opts: { verbose: boolean; secrets: (string | undefined)[]; out: (line: string) => void; err: (line: string) => void }): Logger`

- [ ] **Step 1: Write the failing tests**

`test/errors.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ExitCode, StorelingoError, exitCodeFor } from "../src/errors.js";

describe("StorelingoError", () => {
  it("keeps code, message and hint", () => {
    const err = new StorelingoError("E_LIMIT", "too long", "shorten it");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("E_LIMIT");
    expect(err.message).toBe("too long");
    expect(err.hint).toBe("shorten it");
    expect(err.name).toBe("StorelingoError");
  });
});

describe("exitCodeFor", () => {
  it("maps config and usage errors to 2", () => {
    expect(exitCodeFor(new StorelingoError("E_CONFIG", "x"))).toBe(ExitCode.USAGE);
    expect(exitCodeFor(new StorelingoError("E_USAGE", "x"))).toBe(ExitCode.USAGE);
  });
  it("maps other storelingo errors and unknown errors to 1", () => {
    expect(exitCodeFor(new StorelingoError("E_TRANSLATOR", "x"))).toBe(ExitCode.FAILED);
    expect(exitCodeFor(new Error("boom"))).toBe(ExitCode.FAILED);
  });
});
```

`test/log.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";

function capture(verbose: boolean, secrets: (string | undefined)[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const log = createLogger({ verbose, secrets, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { log, out, err };
}

describe("createLogger", () => {
  it("writes info to out and warn/error to err", () => {
    const { log, out, err } = capture(false);
    log.info("hello");
    log.warn("careful");
    log.error("bad");
    expect(out).toEqual(["hello"]);
    expect(err).toEqual(["warning: careful", "error: bad"]);
  });
  it("prints debug only when verbose", () => {
    const quiet = capture(false);
    quiet.log.debug("detail");
    expect(quiet.out).toEqual([]);
    const loud = capture(true);
    loud.log.debug("detail");
    expect(loud.out).toEqual(["debug: detail"]);
  });
  it("masks secrets of 6+ characters and ignores undefined", () => {
    const { log, out } = capture(false, ["sk-ant-123456", undefined, "abc"]);
    log.info("key sk-ant-123456 and abc");
    expect(out).toEqual(["key *** and abc"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/errors.test.ts test/log.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/errors.ts`**

```ts
export type ErrorCode =
  | "E_CONFIG"
  | "E_USAGE"
  | "E_AUTH_PLAY"
  | "E_AUTH_ASC"
  | "E_NO_EDITABLE_VERSION"
  | "E_LOCALE_UNSUPPORTED"
  | "E_LIMIT"
  | "E_MISSING"
  | "E_FORMAT"
  | "E_TRANSLATOR";

export class StorelingoError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "StorelingoError";
  }
}

export const ExitCode = { OK: 0, FAILED: 1, USAGE: 2 } as const;

export function exitCodeFor(err: unknown): number {
  if (err instanceof StorelingoError && (err.code === "E_CONFIG" || err.code === "E_USAGE")) {
    return ExitCode.USAGE;
  }
  return ExitCode.FAILED;
}
```

- [ ] **Step 4: Implement `src/log.ts`**

```ts
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface LoggerOptions {
  verbose: boolean;
  secrets: (string | undefined)[];
  out: (line: string) => void;
  err: (line: string) => void;
}

const MIN_SECRET_LENGTH = 6;

export function createLogger(opts: LoggerOptions): Logger {
  const secrets = opts.secrets.filter(
    (s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH,
  );
  const mask = (msg: string): string =>
    secrets.reduce((acc, secret) => acc.split(secret).join("***"), msg);

  return {
    info: (msg) => opts.out(mask(msg)),
    warn: (msg) => opts.err(mask(`warning: ${msg}`)),
    error: (msg) => opts.err(mask(`error: ${msg}`)),
    debug: (msg) => {
      if (opts.verbose) opts.out(mask(`debug: ${msg}`));
    },
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/errors.test.ts test/log.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/log.ts test/errors.test.ts test/log.test.ts
git commit -m "feat: add error codes and secret-masking logger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Store field registry

**Files:**
- Create: `src/fields/registry.ts`
- Test: `test/fields/registry.test.ts`

**Interfaces:**
- Produces:
  - `type StoreId = "play" | "appstore"`; `const STORES: readonly StoreId[]`
  - `type FieldKind = "text" | "keywords" | "url" | "changelog"`
  - `interface FieldDef { store: StoreId; key: string; file: string; maxChars: number | null; translatable: boolean; required: boolean; kind: FieldKind }`
  - `const FIELDS: readonly FieldDef[]`
  - `fieldsFor(store: StoreId): FieldDef[]`
  - `getField(store: StoreId, key: string): FieldDef` (throws `Error` on unknown key)

For `kind: "changelog"`, `file` is the directory name `changelogs`; the concrete file is resolved by `metadata` (Task 6).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { FIELDS, fieldsFor, getField } from "../../src/fields/registry.js";

describe("field registry", () => {
  it("has the Google Play limits from the spec", () => {
    expect(getField("play", "title").maxChars).toBe(30);
    expect(getField("play", "short_description").maxChars).toBe(80);
    expect(getField("play", "full_description").maxChars).toBe(4000);
    expect(getField("play", "changelog").maxChars).toBe(500);
    expect(getField("play", "video").translatable).toBe(false);
  });

  it("has the App Store limits from the spec", () => {
    expect(getField("appstore", "name").maxChars).toBe(30);
    expect(getField("appstore", "subtitle").maxChars).toBe(30);
    expect(getField("appstore", "keywords").maxChars).toBe(100);
    expect(getField("appstore", "keywords").kind).toBe("keywords");
    expect(getField("appstore", "promotional_text").maxChars).toBe(170);
    expect(getField("appstore", "description").maxChars).toBe(4000);
    expect(getField("appstore", "release_notes").maxChars).toBe(4000);
  });

  it("never translates URL fields", () => {
    for (const f of FIELDS.filter((x) => x.kind === "url")) {
      expect(f.translatable).toBe(false);
      expect(f.maxChars).toBeNull();
    }
  });

  it("marks the core listing fields as required", () => {
    const required = FIELDS.filter((f) => f.required).map((f) => `${f.store}/${f.key}`);
    expect(required.sort()).toEqual(
      [
        "appstore/description",
        "appstore/keywords",
        "appstore/name",
        "play/full_description",
        "play/short_description",
        "play/title",
      ].sort(),
    );
  });

  it("filters by store and has unique keys per store", () => {
    const play = fieldsFor("play");
    expect(play.every((f) => f.store === "play")).toBe(true);
    expect(new Set(play.map((f) => f.key)).size).toBe(play.length);
  });

  it("throws on unknown field", () => {
    expect(() => getField("play", "nope")).toThrow("Unknown field play/nope");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fields/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fields/registry.ts`**

```ts
export type StoreId = "play" | "appstore";
export const STORES: readonly StoreId[] = ["play", "appstore"];

export type FieldKind = "text" | "keywords" | "url" | "changelog";

export interface FieldDef {
  store: StoreId;
  key: string;
  /** Path inside the locale folder. For `changelog` it is the directory name. */
  file: string;
  maxChars: number | null;
  translatable: boolean;
  required: boolean;
  kind: FieldKind;
}

const text = (store: StoreId, key: string, maxChars: number, required: boolean): FieldDef => ({
  store,
  key,
  file: `${key}.txt`,
  maxChars,
  translatable: true,
  required,
  kind: "text",
});

const url = (store: StoreId, key: string): FieldDef => ({
  store,
  key,
  file: `${key}.txt`,
  maxChars: null,
  translatable: false,
  required: false,
  kind: "url",
});

/**
 * Store listing fields. Limits are data so contributors can update them
 * without touching logic. Sources: Play Console Help, App Store Connect Help.
 */
export const FIELDS: readonly FieldDef[] = [
  text("play", "title", 30, true),
  text("play", "short_description", 80, true),
  text("play", "full_description", 4000, true),
  {
    store: "play",
    key: "changelog",
    file: "changelogs",
    maxChars: 500,
    translatable: true,
    required: false,
    kind: "changelog",
  },
  url("play", "video"),

  text("appstore", "name", 30, true),
  text("appstore", "subtitle", 30, false),
  {
    store: "appstore",
    key: "keywords",
    file: "keywords.txt",
    maxChars: 100,
    translatable: true,
    required: true,
    kind: "keywords",
  },
  text("appstore", "promotional_text", 170, false),
  text("appstore", "description", 4000, true),
  text("appstore", "release_notes", 4000, false),
  url("appstore", "marketing_url"),
  url("appstore", "support_url"),
  url("appstore", "privacy_url"),
];

export function fieldsFor(store: StoreId): FieldDef[] {
  return FIELDS.filter((f) => f.store === store);
}

export function getField(store: StoreId, key: string): FieldDef {
  const field = FIELDS.find((f) => f.store === store && f.key === key);
  if (!field) throw new Error(`Unknown field ${store}/${key}`);
  return field;
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/fields/registry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fields test/fields
git commit -m "feat: add store field registry with character limits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Locale table

**Files:**
- Create: `src/locales/table.ts`
- Test: `test/locales/table.test.ts`

**Interfaces:**
- Consumes: `StoreId` from `src/fields/registry.ts`
- Produces:
  - `interface LocaleDef { code: string; name: string; play?: string; appstore?: string }`
  - `const LOCALES: readonly LocaleDef[]`
  - `findLocale(code: string): LocaleDef | undefined`
  - `toStoreLocale(store: StoreId, code: string): string | undefined`
  - `fromStoreLocale(store: StoreId, storeCode: string): string | undefined`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { LOCALES, findLocale, fromStoreLocale, toStoreLocale } from "../../src/locales/table.js";

describe("locale table", () => {
  it("maps common codes to store codes", () => {
    expect(toStoreLocale("play", "ru")).toBe("ru-RU");
    expect(toStoreLocale("appstore", "ru")).toBe("ru");
    expect(toStoreLocale("play", "he")).toBe("iw-IL");
    expect(toStoreLocale("appstore", "he")).toBe("he");
    expect(toStoreLocale("play", "zh-Hans")).toBe("zh-CN");
    expect(toStoreLocale("appstore", "zh-Hans")).toBe("zh-Hans");
  });

  it("returns undefined where a store lacks the language", () => {
    expect(toStoreLocale("play", "ky")).toBe("ky-KG");
    expect(toStoreLocale("appstore", "ky")).toBeUndefined();
    expect(toStoreLocale("play", "xx")).toBeUndefined();
  });

  it("maps store codes back to common codes", () => {
    expect(fromStoreLocale("play", "de-DE")).toBe("de");
    expect(fromStoreLocale("appstore", "es-MX")).toBe("es-419");
    expect(fromStoreLocale("appstore", "nope")).toBeUndefined();
  });

  it("has unique common codes and unique store codes", () => {
    const codes = LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const store of ["play", "appstore"] as const) {
      const storeCodes = LOCALES.map((l) => l[store]).filter(Boolean);
      expect(new Set(storeCodes).size).toBe(storeCodes.length);
    }
  });

  it("gives every locale a human-readable name", () => {
    expect(findLocale("uz")?.name).toBe("Uzbek");
    expect(LOCALES.every((l) => l.name.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/locales/table.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/locales/table.ts`**

```ts
import type { StoreId } from "../fields/registry.js";

export interface LocaleDef {
  /** storelingo's own code, used in config. */
  code: string;
  /** English name, used in prompts. */
  name: string;
  /** Google Play listing language code, if supported. */
  play?: string;
  /** App Store Connect locale code, if supported. */
  appstore?: string;
}

/**
 * Languages supported by at least one store. Data only — add a row to
 * support a new language. Sources: Play Console "Add translations" list,
 * App Store Connect "Localizations" list.
 */
export const LOCALES: readonly LocaleDef[] = [
  { code: "ar", name: "Arabic", play: "ar", appstore: "ar-SA" },
  { code: "az", name: "Azerbaijani", play: "az-AZ" },
  { code: "ca", name: "Catalan", play: "ca", appstore: "ca" },
  { code: "cs", name: "Czech", play: "cs-CZ", appstore: "cs" },
  { code: "da", name: "Danish", play: "da-DK", appstore: "da" },
  { code: "de", name: "German", play: "de-DE", appstore: "de-DE" },
  { code: "el", name: "Greek", play: "el-GR", appstore: "el" },
  { code: "en-AU", name: "English (Australia)", play: "en-AU", appstore: "en-AU" },
  { code: "en-CA", name: "English (Canada)", play: "en-CA", appstore: "en-CA" },
  { code: "en-GB", name: "English (United Kingdom)", play: "en-GB", appstore: "en-GB" },
  { code: "en-US", name: "English (United States)", play: "en-US", appstore: "en-US" },
  { code: "es-ES", name: "Spanish (Spain)", play: "es-ES", appstore: "es-ES" },
  { code: "es-419", name: "Spanish (Latin America)", play: "es-419", appstore: "es-MX" },
  { code: "fa", name: "Persian", play: "fa" },
  { code: "fi", name: "Finnish", play: "fi-FI", appstore: "fi" },
  { code: "fr-CA", name: "French (Canada)", play: "fr-CA", appstore: "fr-CA" },
  { code: "fr-FR", name: "French (France)", play: "fr-FR", appstore: "fr-FR" },
  { code: "he", name: "Hebrew", play: "iw-IL", appstore: "he" },
  { code: "hi", name: "Hindi", play: "hi-IN", appstore: "hi" },
  { code: "hr", name: "Croatian", play: "hr", appstore: "hr" },
  { code: "hu", name: "Hungarian", play: "hu-HU", appstore: "hu" },
  { code: "id", name: "Indonesian", play: "id", appstore: "id" },
  { code: "it", name: "Italian", play: "it-IT", appstore: "it" },
  { code: "ja", name: "Japanese", play: "ja-JP", appstore: "ja" },
  { code: "kk", name: "Kazakh", play: "kk" },
  { code: "ko", name: "Korean", play: "ko-KR", appstore: "ko" },
  { code: "ky", name: "Kyrgyz", play: "ky-KG" },
  { code: "ms", name: "Malay", play: "ms", appstore: "ms" },
  { code: "nl", name: "Dutch", play: "nl-NL", appstore: "nl-NL" },
  { code: "no", name: "Norwegian", play: "no-NO", appstore: "no" },
  { code: "pl", name: "Polish", play: "pl-PL", appstore: "pl" },
  { code: "pt-BR", name: "Portuguese (Brazil)", play: "pt-BR", appstore: "pt-BR" },
  { code: "pt-PT", name: "Portuguese (Portugal)", play: "pt-PT", appstore: "pt-PT" },
  { code: "ro", name: "Romanian", play: "ro", appstore: "ro" },
  { code: "ru", name: "Russian", play: "ru-RU", appstore: "ru" },
  { code: "sk", name: "Slovak", play: "sk", appstore: "sk" },
  { code: "sv", name: "Swedish", play: "sv-SE", appstore: "sv" },
  { code: "th", name: "Thai", play: "th", appstore: "th" },
  { code: "tr", name: "Turkish", play: "tr-TR", appstore: "tr" },
  { code: "uk", name: "Ukrainian", play: "uk", appstore: "uk" },
  { code: "uz", name: "Uzbek", play: "uz" },
  { code: "vi", name: "Vietnamese", play: "vi", appstore: "vi" },
  { code: "zh-Hans", name: "Chinese (Simplified)", play: "zh-CN", appstore: "zh-Hans" },
  { code: "zh-Hant", name: "Chinese (Traditional)", play: "zh-TW", appstore: "zh-Hant" },
];

export function findLocale(code: string): LocaleDef | undefined {
  return LOCALES.find((l) => l.code === code);
}

export function toStoreLocale(store: StoreId, code: string): string | undefined {
  return findLocale(code)?.[store];
}

export function fromStoreLocale(store: StoreId, storeCode: string): string | undefined {
  return LOCALES.find((l) => l[store] === storeCode)?.code;
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/locales/table.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/locales test/locales
git commit -m "feat: add locale table with store code mapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Config schema and loader

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`, `test/helpers/tmp.ts`
- Test: `test/config/load.test.ts`

**Interfaces:**
- Consumes: `StorelingoError` (Task 2), `findLocale` (Task 4)
- Produces:
  - `ConfigSchema` (zod), `type Config = z.output<typeof ConfigSchema>`, `type TranslatorConfig = Config["translator"]`, `type Effort = "low" | "medium" | "high" | "xhigh" | "max"`
  - `const CONFIG_FILE = "storelingo.config.json"`
  - `parseConfig(raw: unknown): Config` (throws `StorelingoError("E_CONFIG")`)
  - `loadConfig(file: string): Promise<Config>`
  - test helper `makeTmpDir(): Promise<string>`

- [ ] **Step 1: Write the test helper `test/helpers/tmp.ts`**

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "storelingo-"));
}
```

- [ ] **Step 2: Write the failing test `test/config/load.test.ts`**

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE, loadConfig, parseConfig } from "../../src/config/load.js";
import { StorelingoError } from "../../src/errors.js";
import { makeTmpDir } from "../helpers/tmp.js";

const minimal = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "de"],
  stores: { play: { packageName: "com.example.app" } },
  translator: { provider: "anthropic" },
};

describe("parseConfig", () => {
  it("applies defaults", () => {
    const config = parseConfig(minimal);
    expect(config.translator).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "medium",
      concurrency: 4,
    });
    expect(config.context).toBe("");
    expect(config.glossary).toEqual({ doNotTranslate: [], terms: {} });
    expect(config.paths).toEqual({});
  });

  it("accepts an openai-compatible translator", () => {
    const config = parseConfig({
      ...minimal,
      translator: { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
    });
    expect(config.translator.provider).toBe("openai-compatible");
  });

  it("requires at least one store", () => {
    expect(() => parseConfig({ ...minimal, stores: {} })).toThrow(StorelingoError);
  });

  it("rejects unknown locales with the list of bad codes", () => {
    try {
      parseConfig({ ...minimal, targetLocales: ["ru", "xx-YY"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StorelingoError);
      expect((err as StorelingoError).code).toBe("E_CONFIG");
      expect((err as StorelingoError).message).toContain("xx-YY");
    }
  });

  it("rejects a target equal to the source", () => {
    expect(() => parseConfig({ ...minimal, targetLocales: ["en-US"] })).toThrow("source locale");
  });

  it("reports the path of an invalid field", () => {
    expect(() => parseConfig({ ...minimal, translator: { provider: "anthropic", concurrency: 0 } })).toThrow(
      "translator.concurrency",
    );
  });
});

describe("loadConfig", () => {
  it("reads a config file", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, CONFIG_FILE);
    await writeFile(file, JSON.stringify(minimal));
    const config = await loadConfig(file);
    expect(config.targetLocales).toEqual(["ru", "de"]);
  });

  it("explains a missing file", async () => {
    const dir = await makeTmpDir();
    await expect(loadConfig(join(dir, CONFIG_FILE))).rejects.toMatchObject({
      code: "E_CONFIG",
      hint: "Run `npx storelingo init` to create one.",
    });
  });

  it("explains invalid JSON", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, CONFIG_FILE);
    await writeFile(file, "{ not json");
    await expect(loadConfig(file)).rejects.toMatchObject({ code: "E_CONFIG" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/config/load.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/config/schema.ts`**

```ts
import { z } from "zod";

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const concurrency = z.number().int().min(1).max(16).default(4);

export const ConfigSchema = z.object({
  $schema: z.string().optional(),
  sourceLocale: z.string().min(1),
  targetLocales: z.array(z.string().min(1)).min(1),
  stores: z
    .object({
      play: z.object({ packageName: z.string().min(1) }).optional(),
      appstore: z.object({ appId: z.string().min(1) }).optional(),
    })
    .refine((s) => s.play !== undefined || s.appstore !== undefined, {
      message: "configure at least one store (play or appstore)",
    }),
  translator: z.discriminatedUnion("provider", [
    z.object({
      provider: z.literal("anthropic"),
      model: z.string().min(1).default("claude-opus-5-5"),
      effort: effort.default("medium"),
      concurrency,
    }),
    z.object({
      provider: z.literal("openai-compatible"),
      baseUrl: z.string().url(),
      model: z.string().min(1),
      concurrency,
    }),
  ]),
  context: z.string().default(""),
  glossary: z
    .object({
      doNotTranslate: z.array(z.string()).default([]),
      terms: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    })
    .default({ doNotTranslate: [], terms: {} }),
  paths: z
    .object({
      play: z.string().optional(),
      appstore: z.string().optional(),
    })
    .default({}),
});

export type Config = z.output<typeof ConfigSchema>;
export type TranslatorConfig = Config["translator"];
export type Effort = z.output<typeof effort>;
```

- [ ] **Step 5: Implement `src/config/load.ts`**

```ts
import { readFile } from "node:fs/promises";
import { StorelingoError } from "../errors.js";
import { findLocale } from "../locales/table.js";
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
      "See the locale table in src/locales/table.ts for supported codes.",
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
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new StorelingoError("E_CONFIG", `Config file is not valid JSON: ${file}`);
  }
  return parseConfig(raw);
}
```

- [ ] **Step 6: Run test**

Run: `npx vitest run test/config/load.test.ts`
Expected: PASS (9 tests). If zod reports the concurrency issue path differently, keep the assertion on `translator.concurrency` and adjust only the message join, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/config test/config test/helpers
git commit -m "feat: add config schema with defaults and locale validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: fastlane metadata read/write

**Files:**
- Create: `src/metadata/fastlane.ts`
- Test: `test/metadata/fastlane.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 5), `FieldDef`, `StoreId` (Task 3)
- Produces:
  - `const DEFAULT_ROOTS: Record<StoreId, string>`
  - `storeRoot(config: Config, cwd: string, store: StoreId): string`
  - `listLocales(root: string, store: StoreId): Promise<string[]>`
  - `resolveFieldPath(root: string, sourceStoreLocale: string, field: FieldDef): Promise<string | undefined>` — relative path with `/` separators
  - `readField(root: string, storeLocale: string, relPath: string): Promise<string | undefined>`
  - `writeField(root: string, storeLocale: string, relPath: string, text: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { getField } from "../../src/fields/registry.js";
import {
  listLocales,
  readField,
  resolveFieldPath,
  storeRoot,
  writeField,
} from "../../src/metadata/fastlane.js";
import { makeTmpDir } from "../helpers/tmp.js";

const config = parseConfig({
  sourceLocale: "en-US",
  targetLocales: ["ru"],
  stores: { play: { packageName: "a.b" }, appstore: { appId: "1" } },
  translator: { provider: "anthropic" },
});

describe("storeRoot", () => {
  it("uses fastlane defaults and config overrides", () => {
    expect(storeRoot(config, "/p", "play")).toBe(resolve("/p", "fastlane/metadata/android"));
    expect(storeRoot(config, "/p", "appstore")).toBe(resolve("/p", "fastlane/metadata"));
    const custom = { ...config, paths: { play: "meta/play" } };
    expect(storeRoot(custom, "/p", "play")).toBe(resolve("/p", "meta/play"));
  });
});

describe("listLocales", () => {
  it("lists App Store locale folders, skipping fastlane special folders", async () => {
    const root = await makeTmpDir();
    for (const d of ["en-US", "ru", "android", "default", "review_information"]) {
      await mkdir(join(root, d));
    }
    await writeFile(join(root, "copyright.txt"), "x");
    expect(await listLocales(root, "appstore")).toEqual(["en-US", "ru"]);
  });

  it("returns [] when the root does not exist", async () => {
    const root = await makeTmpDir();
    expect(await listLocales(join(root, "missing"), "play")).toEqual([]);
  });
});

describe("readField / writeField", () => {
  it("round-trips text and creates folders", async () => {
    const root = await makeTmpDir();
    await writeField(root, "ru-RU", "changelogs/12.txt", "Новое\n");
    expect(await readFile(join(root, "ru-RU", "changelogs", "12.txt"), "utf8")).toBe("Новое\n");
    expect(await readField(root, "ru-RU", "changelogs/12.txt")).toBe("Новое\n");
  });

  it("strips BOM and normalizes CRLF on read", async () => {
    const root = await makeTmpDir();
    await mkdir(join(root, "en-US"));
    await writeFile(join(root, "en-US", "title.txt"), "﻿Line1\r\nLine2");
    expect(await readField(root, "en-US", "title.txt")).toBe("Line1\nLine2");
  });

  it("returns undefined for a missing file", async () => {
    const root = await makeTmpDir();
    expect(await readField(root, "en-US", "title.txt")).toBeUndefined();
  });
});

describe("resolveFieldPath", () => {
  it("returns the plain file for normal fields", async () => {
    const root = await makeTmpDir();
    expect(await resolveFieldPath(root, "en-US", getField("play", "title"))).toBe("title.txt");
  });

  it("picks the highest numeric changelog of the source locale", async () => {
    const root = await makeTmpDir();
    await mkdir(join(root, "en-US", "changelogs"), { recursive: true });
    for (const f of ["9.txt", "12.txt", "default.txt", "3.txt"]) {
      await writeFile(join(root, "en-US", "changelogs", f), "x");
    }
    expect(await resolveFieldPath(root, "en-US", getField("play", "changelog"))).toBe("changelogs/12.txt");
  });

  it("returns undefined when there are no changelogs", async () => {
    const root = await makeTmpDir();
    expect(await resolveFieldPath(root, "en-US", getField("play", "changelog"))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/metadata/fastlane.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/metadata/fastlane.ts`**

```ts
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config/schema.js";
import type { FieldDef, StoreId } from "../fields/registry.js";

export const DEFAULT_ROOTS: Record<StoreId, string> = {
  play: "fastlane/metadata/android",
  appstore: "fastlane/metadata",
};

/** Folders inside fastlane/metadata that are not App Store locales. */
const APPSTORE_NON_LOCALE_DIRS = new Set([
  "android",
  "default",
  "review_information",
  "trade_representative_contact_information",
]);

export function storeRoot(config: Config, cwd: string, store: StoreId): string {
  return resolve(cwd, config.paths[store] ?? DEFAULT_ROOTS[store]);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

export async function listLocales(root: string, store: StoreId): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => store !== "appstore" || !APPSTORE_NON_LOCALE_DIRS.has(name))
    .sort();
}

function filePath(root: string, storeLocale: string, relPath: string): string {
  return join(root, storeLocale, ...relPath.split("/"));
}

export async function resolveFieldPath(
  root: string,
  sourceStoreLocale: string,
  field: FieldDef,
): Promise<string | undefined> {
  if (field.kind !== "changelog") return field.file;
  let names: string[];
  try {
    names = await readdir(join(root, sourceStoreLocale, field.file));
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  const versions = names
    .map((n) => /^(\d+)\.txt$/.exec(n)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number);
  if (versions.length === 0) return undefined;
  return `${field.file}/${Math.max(...versions)}.txt`;
}

export async function readField(
  root: string,
  storeLocale: string,
  relPath: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath(root, storeLocale, relPath), "utf8");
    return raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export async function writeField(
  root: string,
  storeLocale: string,
  relPath: string,
  text: string,
): Promise<void> {
  const target = filePath(root, storeLocale, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/metadata/fastlane.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/metadata test/metadata
git commit -m "feat: read and write fastlane metadata folders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Lock file and translate decision

**Files:**
- Create: `src/lock/lock.ts`
- Test: `test/lock/lock.test.ts`

**Interfaces:**
- Consumes: `StorelingoError` (Task 2), `StoreId` (Task 3)
- Produces:
  - `const LOCK_FILE = "storelingo.lock.json"`
  - `interface LockEntry { sourceHash: string; outputHash: string }`
  - `interface Lock { version: 1; entries: Record<string, LockEntry> }`
  - `hashText(text: string): string` → `"sha256:<hex>"`
  - `lockKey(store: StoreId, storeLocale: string, fieldKey: string): string` → `"play/ru-RU/title"`
  - `loadLock(file: string): Promise<Lock>`; `saveLock(file: string, lock: Lock): Promise<void>`
  - `type Decision = "translate" | "skip-empty-source" | "skip-unchanged" | "skip-manual-edit"`
  - `decide(args: { source: string | undefined; target: string | undefined; entry: LockEntry | undefined; force: boolean }): Decision`

- [ ] **Step 1: Write the failing test**

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_FILE, decide, hashText, loadLock, lockKey, saveLock } from "../../src/lock/lock.js";
import { makeTmpDir } from "../helpers/tmp.js";

const src = "Hello";
const out = "Привет";
const entry = { sourceHash: hashText(src), outputHash: hashText(out) };

describe("hashText / lockKey", () => {
  it("produces stable sha256 hashes", () => {
    expect(hashText("a")).toBe(
      "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
  it("builds keys", () => {
    expect(lockKey("play", "ru-RU", "title")).toBe("play/ru-RU/title");
  });
});

describe("decide", () => {
  it("skips an empty or missing source", () => {
    expect(decide({ source: undefined, target: undefined, entry: undefined, force: false })).toBe("skip-empty-source");
    expect(decide({ source: "  \n", target: undefined, entry: undefined, force: true })).toBe("skip-empty-source");
  });
  it("translates when the target does not exist", () => {
    expect(decide({ source: src, target: undefined, entry: undefined, force: false })).toBe("translate");
    expect(decide({ source: src, target: undefined, entry, force: false })).toBe("translate");
  });
  it("skips when nothing changed", () => {
    expect(decide({ source: src, target: out, entry, force: false })).toBe("skip-unchanged");
  });
  it("re-translates when the source changed", () => {
    expect(decide({ source: "Hello!", target: out, entry, force: false })).toBe("translate");
  });
  it("protects a manually edited target", () => {
    expect(decide({ source: "Hello!", target: "Привет!!", entry, force: false })).toBe("skip-manual-edit");
  });
  it("treats an existing target without lock entry as manual", () => {
    expect(decide({ source: src, target: out, entry: undefined, force: false })).toBe("skip-manual-edit");
  });
  it("--force overrides everything except an empty source", () => {
    expect(decide({ source: src, target: "edited", entry, force: true })).toBe("translate");
    expect(decide({ source: src, target: out, entry, force: true })).toBe("translate");
  });
});

describe("loadLock / saveLock", () => {
  it("returns an empty lock when the file is missing", async () => {
    const dir = await makeTmpDir();
    expect(await loadLock(join(dir, LOCK_FILE))).toEqual({ version: 1, entries: {} });
  });

  it("saves with sorted keys and reloads", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, LOCK_FILE);
    await saveLock(file, { version: 1, entries: { "play/ru-RU/title": entry, "appstore/ru/name": entry } });
    const text = await readFile(file, "utf8");
    expect(text.indexOf("appstore/ru/name")).toBeLessThan(text.indexOf("play/ru-RU/title"));
    expect(text.endsWith("\n")).toBe(true);
    expect((await loadLock(file)).entries["play/ru-RU/title"]).toEqual(entry);
  });

  it("rejects a corrupt lock file", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, LOCK_FILE);
    await writeFile(file, '{"version": 9}');
    await expect(loadLock(file)).rejects.toMatchObject({ code: "E_CONFIG" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lock/lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lock/lock.ts`**

```ts
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { StorelingoError } from "../errors.js";
import type { StoreId } from "../fields/registry.js";

export const LOCK_FILE = "storelingo.lock.json";

export interface LockEntry {
  sourceHash: string;
  outputHash: string;
}

export interface Lock {
  version: 1;
  entries: Record<string, LockEntry>;
}

const LockSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({ sourceHash: z.string(), outputHash: z.string() })),
});

export function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function lockKey(store: StoreId, storeLocale: string, fieldKey: string): string {
  return `${store}/${storeLocale}/${fieldKey}`;
}

export async function loadLock(file: string): Promise<Lock> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: {} };
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = LockSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StorelingoError(
      "E_CONFIG",
      `Lock file is corrupt: ${file}`,
      "Delete it and run `npx storelingo translate --force` to rebuild.",
    );
  }
  return parsed.data;
}

export async function saveLock(file: string, lock: Lock): Promise<void> {
  const entries = Object.fromEntries(
    Object.keys(lock.entries)
      .sort()
      .map((k) => [k, lock.entries[k]]),
  );
  await writeFile(file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
}

export type Decision = "translate" | "skip-empty-source" | "skip-unchanged" | "skip-manual-edit";

export function decide(args: {
  source: string | undefined;
  target: string | undefined;
  entry: LockEntry | undefined;
  force: boolean;
}): Decision {
  const { source, target, entry, force } = args;
  if (source === undefined || source.trim() === "") return "skip-empty-source";
  if (force || target === undefined) return "translate";
  if (!entry || hashText(target) !== entry.outputHash) return "skip-manual-edit";
  if (entry.sourceHash === hashText(source)) return "skip-unchanged";
  return "translate";
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/lock/lock.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lock test/lock
git commit -m "feat: add lock file with manual-edit protection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Retry and concurrency utilities

**Files:**
- Create: `src/util/retry.ts`, `src/util/pool.ts`
- Test: `test/util/retry.test.ts`, `test/util/pool.test.ts`

**Interfaces:**
- Produces:
  - `class RetryableError extends Error { retryAfterMs?: number }` — `new RetryableError(message, retryAfterMs?)`
  - `withRetry<T>(fn: () => Promise<T>, opts?: { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number }): Promise<T>` — default `attempts: 5`, `baseMs: 500`
  - `runPool<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]>`

- [ ] **Step 1: Write the failing tests**

`test/util/retry.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { RetryableError, withRetry } from "../../src/util/retry.js";

describe("withRetry", () => {
  it("returns the first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withRetry(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries RetryableError with exponential backoff", async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError("429"))
      .mockRejectedValueOnce(new RetryableError("503"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, {
      baseMs: 100,
      random: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result).toBe("ok");
    expect(delays).toEqual([100, 200]);
  });

  it("honours retryAfterMs", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(new RetryableError("429", 3000)).mockResolvedValue("ok");
    await withRetry(fn, { sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([3000]);
  });

  it("gives up after the attempt limit", async () => {
    const fn = vi.fn().mockRejectedValue(new RetryableError("503"));
    await expect(withRetry(fn, { attempts: 3, sleep: async () => {} })).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("400"));
    await expect(withRetry(fn, { sleep: async () => {} })).rejects.toThrow("400");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

`test/util/pool.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runPool } from "../../src/util/pool.js";

describe("runPool", () => {
  it("keeps result order and limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const results = await runPool([30, 10, 20, 5, 15], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/util/retry.test.ts test/util/pool.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/util/retry.ts`**

```ts
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries only RetryableError, with exponential backoff and jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= attempts) throw err;
      const delay = err.retryAfterMs ?? baseMs * 2 ** (attempt - 1) + Math.floor(random() * baseMs);
      await sleep(delay);
    }
  }
}
```

- [ ] **Step 4: Implement `src/util/pool.ts`**

```ts
/** Runs worker over items with at most `concurrency` in flight; keeps input order. */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/util`
Expected: PASS (12 tests including Task 1's).

- [ ] **Step 6: Commit**

```bash
git add src/util test/util
git commit -m "feat: add retry with backoff and bounded concurrency pool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Translation types, keyword normalization and prompts

**Files:**
- Create: `src/translate/types.ts`, `src/translate/keywords.ts`, `src/translate/prompt.ts`
- Test: `test/translate/keywords.test.ts`, `test/translate/prompt.test.ts`

**Interfaces:**
- Consumes: `FieldKind`, `StoreId` (Task 3), `LocaleDef`, `findLocale` (Task 4), `countChars` (Task 1)
- Produces (`types.ts`):
  - `interface Usage { inputTokens: number; outputTokens: number }`; `const ZERO_USAGE: Usage`; `addUsage(a: Usage, b: Usage): Usage`
  - `interface FieldToTranslate { key: string; text: string; maxChars: number | null; kind: FieldKind }`
  - `interface TranslateRequest { store: StoreId; sourceLocale: LocaleDef; targetLocale: LocaleDef; fields: FieldToTranslate[]; context: string; doNotTranslate: string[]; terms: Record<string, string> }`
  - `interface TranslateResult { texts: Record<string, string>; errors: Record<string, string>; usage: Usage }`
  - `interface Translator { translate(req: TranslateRequest): Promise<TranslateResult> }`
  - `interface LlmJsonRequest { system: string; user: string; keys: string[] }`
  - `interface LlmJsonResponse { data: unknown; usage: Usage }`
  - `interface LlmClient { completeJson(req: LlmJsonRequest): Promise<LlmJsonResponse> }`
- Produces (`keywords.ts`): `normalizeKeywords(raw: string, exclude?: string[]): string`
- Produces (`prompt.ts`): `const SYSTEM_PROMPT: string`; `buildTranslatePrompt(req: TranslateRequest): string`; `buildShortenPrompt(args: { text: string; maxChars: number; language: LocaleDef; kind: FieldKind }): string`

- [ ] **Step 1: Write `src/translate/types.ts`** (types only — exercised by later tests)

```ts
import type { FieldKind, StoreId } from "../fields/registry.js";
import type { LocaleDef } from "../locales/table.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export interface FieldToTranslate {
  key: string;
  text: string;
  maxChars: number | null;
  kind: FieldKind;
}

export interface TranslateRequest {
  store: StoreId;
  sourceLocale: LocaleDef;
  targetLocale: LocaleDef;
  fields: FieldToTranslate[];
  context: string;
  doNotTranslate: string[];
  /** Preferred translations for this target locale: source term → target term. */
  terms: Record<string, string>;
}

export interface TranslateResult {
  /** Field key → final text (within limits). */
  texts: Record<string, string>;
  /** Field key → reason it could not be produced. */
  errors: Record<string, string>;
  usage: Usage;
}

export interface Translator {
  translate(req: TranslateRequest): Promise<TranslateResult>;
}

export interface LlmJsonRequest {
  system: string;
  user: string;
  /** Exact keys the JSON object must have; every value is a string. */
  keys: string[];
}

export interface LlmJsonResponse {
  /** Parsed JSON, or undefined when the model returned non-JSON. */
  data: unknown;
  usage: Usage;
}

export interface LlmClient {
  completeJson(req: LlmJsonRequest): Promise<LlmJsonResponse>;
}
```

- [ ] **Step 2: Write the failing tests**

`test/translate/keywords.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeKeywords } from "../../src/translate/keywords.js";

describe("normalizeKeywords", () => {
  it("removes spaces around commas and collapses inner spaces", () => {
    expect(normalizeKeywords(" prayer ,  quran,azan   time ")).toBe("prayer,quran,azan time");
  });
  it("drops empty items and case-insensitive duplicates", () => {
    expect(normalizeKeywords("Quran,,quran,QURAN,dua")).toBe("Quran,dua");
  });
  it("splits on full-width and ideographic commas", () => {
    expect(normalizeKeywords("祈祷，古兰经、礼拜")).toBe("祈祷,古兰经,礼拜");
  });
  it("drops single words already present in name or subtitle", () => {
    expect(normalizeKeywords("prayer,times,qibla,prayer times", ["Prayer Times", "Qibla finder"])).toBe(
      "prayer times",
    );
  });
});
```

`test/translate/prompt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { findLocale } from "../../src/locales/table.js";
import { SYSTEM_PROMPT, buildShortenPrompt, buildTranslatePrompt } from "../../src/translate/prompt.js";
import type { TranslateRequest } from "../../src/translate/types.js";

const req: TranslateRequest = {
  store: "appstore",
  sourceLocale: findLocale("en-US")!,
  targetLocale: findLocale("ru")!,
  fields: [
    { key: "name", text: "Quran Widgets", maxChars: 30, kind: "text" },
    { key: "keywords", text: "quran,prayer", maxChars: 100, kind: "keywords" },
  ],
  context: "Prayer times app",
  doNotTranslate: ["Quran Widgets"],
  terms: { prayer: "намаз" },
};

describe("buildTranslatePrompt", () => {
  const prompt = buildTranslatePrompt(req);

  it("names store, languages and context", () => {
    expect(prompt).toContain("App Store");
    expect(prompt).toContain("English (United States) (en-US)");
    expect(prompt).toContain("Russian (ru)");
    expect(prompt).toContain("App context: Prayer times app");
  });
  it("includes glossary", () => {
    expect(prompt).toContain("Do not translate: Quran Widgets");
    expect(prompt).toContain('"prayer" → "намаз"');
  });
  it("embeds fields as JSON with limits and a keywords note", () => {
    expect(prompt).toContain('"maxChars": 30');
    expect(prompt).toContain("App Store search keywords");
    expect(prompt).toContain("exactly these keys: name, keywords");
  });
  it("omits empty sections", () => {
    const bare = buildTranslatePrompt({ ...req, context: "", doNotTranslate: [], terms: {} });
    expect(bare).not.toContain("App context:");
    expect(bare).not.toContain("Do not translate:");
    expect(bare).not.toContain("Preferred terms");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("forbids invented facts and asks for JSON", () => {
    expect(SYSTEM_PROMPT).toContain("Do not invent");
    expect(SYSTEM_PROMPT).toContain("JSON");
  });
});

describe("buildShortenPrompt", () => {
  it("states the current length and the limit", () => {
    const p = buildShortenPrompt({ text: "Очень длинный текст", maxChars: 10, language: findLocale("ru")!, kind: "text" });
    expect(p).toContain("19 characters");
    expect(p).toContain("at most 10 characters");
    expect(p).toContain('one key, "text"');
  });
  it("mentions the keyword format for keywords", () => {
    const p = buildShortenPrompt({ text: "a,b", maxChars: 2, language: findLocale("ru")!, kind: "keywords" });
    expect(p).toContain("comma-separated");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/translate/keywords.test.ts test/translate/prompt.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `src/translate/keywords.ts`**

```ts
const SEPARATORS = /[,，、]/;

/** Normalizes App Store keywords: "a,b,c", no spaces after commas, no duplicates. */
export function normalizeKeywords(raw: string, exclude: string[] = []): string {
  const excluded = new Set(
    exclude.flatMap((s) => s.toLowerCase().split(/[\s,，、]+/)).filter((w) => w.length > 0),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(SEPARATORS)) {
    const keyword = part.trim().replace(/\s+/g, " ");
    if (!keyword) continue;
    const lower = keyword.toLowerCase();
    if (seen.has(lower) || excluded.has(lower)) continue;
    seen.add(lower);
    out.push(keyword);
  }
  return out.join(",");
}
```

- [ ] **Step 5: Implement `src/translate/prompt.ts`**

```ts
import type { FieldKind } from "../fields/registry.js";
import type { LocaleDef } from "../locales/table.js";
import { countChars } from "../util/chars.js";
import type { TranslateRequest } from "./types.js";

export const SYSTEM_PROMPT = [
  "You localize app store listings (Google Play and the App Store) for native speakers of the target language.",
  "Write the way a native copywriter in the target market would: natural, idiomatic and persuasive, not word-for-word.",
  "Keep the meaning, features and claims of the source. Do not invent features, numbers, awards or prices, and do not add emojis the source does not have.",
  "Preserve line breaks, bullet characters and paragraph structure.",
  "Every field has a maximum length in Unicode characters; stay within it.",
  'Leave every term from the "do not translate" list exactly as written.',
  "Answer with a JSON object only.",
].join("\n");

const KEYWORDS_NOTE =
  "App Store search keywords: choose words people in the target market actually search for, not a literal translation. " +
  "Comma-separated with no spaces after commas, no repeated words, and no words already in the app name or subtitle.";

export function buildTranslatePrompt(req: TranslateRequest): string {
  const storeName = req.store === "play" ? "Google Play" : "App Store";
  const fields = Object.fromEntries(
    req.fields.map((f) => [
      f.key,
      { text: f.text, maxChars: f.maxChars, ...(f.kind === "keywords" ? { note: KEYWORDS_NOTE } : {}) },
    ]),
  );
  const terms = Object.entries(req.terms);
  const keys = req.fields.map((f) => f.key);

  return [
    `Localize these ${storeName} listing fields from ${req.sourceLocale.name} (${req.sourceLocale.code}) into ${req.targetLocale.name} (${req.targetLocale.code}).`,
    req.context ? `App context: ${req.context}` : "",
    req.doNotTranslate.length > 0 ? `Do not translate: ${req.doNotTranslate.join(", ")}` : "",
    terms.length > 0
      ? `Preferred terms in ${req.targetLocale.name}:\n${terms.map(([from, to]) => `- "${from}" → "${to}"`).join("\n")}`
      : "",
    `Fields:\n${JSON.stringify(fields, null, 2)}`,
    `Return a JSON object with exactly these keys: ${keys.join(", ")}. Each value is the localized text as a string.`,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

export function buildShortenPrompt(args: {
  text: string;
  maxChars: number;
  language: LocaleDef;
  kind: FieldKind;
}): string {
  const format = args.kind === "keywords" ? " and the comma-separated keyword format" : "";
  return [
    `This ${args.language.name} app store text is ${countChars(args.text)} characters, but the limit is ${args.maxChars}.`,
    `Rewrite it in ${args.language.name} to at most ${args.maxChars} characters, keeping the most important meaning${format}.`,
    `Text:\n${args.text}`,
    'Return a JSON object with one key, "text".',
  ].join("\n\n");
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/translate`
Expected: PASS (11 tests).

- [ ] **Step 7: Commit**

```bash
git add src/translate test/translate
git commit -m "feat: add translation types, prompts and keyword normalization

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: LLM providers (Claude, OpenAI-compatible)

**Files:**
- Create: `src/translate/providers/anthropic.ts`, `src/translate/providers/openai-compatible.ts`, `src/translate/providers/index.ts`
- Test: `test/translate/providers/anthropic.test.ts`, `test/translate/providers/openai-compatible.test.ts`, `test/translate/providers/index.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `LlmJsonRequest` (Task 9), `StorelingoError` (Task 2), `withRetry`, `RetryableError` (Task 8), `TranslatorConfig`, `Effort` (Task 5)
- Produces:
  - `jsonSchemaFor(keys: string[]): Record<string, unknown>`
  - `createAnthropicLlm(opts: { apiKey: string; model: string; effort: Effort; client?: Anthropic }): LlmClient`
  - `createOpenAiCompatibleLlm(opts: { apiKey?: string; baseUrl: string; model: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): LlmClient`
  - `createLlmClient(t: TranslatorConfig, env: NodeJS.ProcessEnv): LlmClient`

Notes for the implementer (from the Claude API reference, do not change without re-checking the docs):
- Use the official SDK `@anthropic-ai/sdk`; its built-in retries cover 429/5xx (`maxRetries`), so do not wrap it in `withRetry`.
- Request JSON via structured outputs: `output_config: { effort, format: { type: "json_schema", schema } }`. The schema must have `additionalProperties: false` and list every key in `required`.
- Opt into server-side refusal fallback: `client.beta.messages.create({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", ... })`. The header must be exactly `server-side-fallback-2026-07-01` for the `"default"` form.
- Do not send `thinking` (Opus 5.5 rejects `disabled`; adaptive is the default) and do not send `temperature`/`top_p`/`top_k`.
- Check `stop_reason` before reading `content`: `"refusal"` and `"max_tokens"` are errors.
- If `tsc` rejects the `fallbacks: "default"` literal, the installed SDK predates it: run `npm install @anthropic-ai/sdk@latest`, then re-run `npm run typecheck`.

- [ ] **Step 1: Write the failing tests**

`test/translate/providers/anthropic.test.ts`:
```ts
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicLlm, jsonSchemaFor } from "../../../src/translate/providers/anthropic.js";

function fakeClient(response: unknown) {
  const create = vi.fn().mockResolvedValue(response);
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, create };
}

const ok = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: '{"title":"Привет"}' }],
  usage: { input_tokens: 120, output_tokens: 15 },
};

describe("jsonSchemaFor", () => {
  it("builds a strict object schema of strings", () => {
    expect(jsonSchemaFor(["a", "b"])).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
      additionalProperties: false,
    });
  });
});

describe("createAnthropicLlm", () => {
  it("sends model, effort, JSON schema and fallback opt-in", async () => {
    const { client, create } = fakeClient(ok);
    const llm = createAnthropicLlm({ apiKey: "k", model: "claude-opus-5-5", effort: "medium", client });
    await llm.completeJson({ system: "SYS", user: "USER", keys: ["title"] });
    const params = create.mock.calls[0]![0];
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: "SYS",
      messages: [{ role: "user", content: "USER" }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: jsonSchemaFor(["title"]) } },
    });
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("temperature");
  });

  it("parses JSON text and usage", async () => {
    const { client } = fakeClient(ok);
    const llm = createAnthropicLlm({ apiKey: "k", model: "m", effort: "low", client });
    await expect(llm.completeJson({ system: "", user: "", keys: ["title"] })).resolves.toEqual({
      data: { title: "Привет" },
      usage: { inputTokens: 120, outputTokens: 15 },
    });
  });

  it("returns data undefined for non-JSON text", async () => {
    const { client } = fakeClient({ ...ok, content: [{ type: "text", text: "sorry" }] });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m", effort: "low", client });
    expect((await llm.completeJson({ system: "", user: "", keys: ["title"] })).data).toBeUndefined();
  });

  it("turns a refusal into E_TRANSLATOR", async () => {
    const { client } = fakeClient({ ...ok, stop_reason: "refusal", content: [] });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m", effort: "low", client });
    await expect(llm.completeJson({ system: "", user: "", keys: ["title"] })).rejects.toMatchObject({
      code: "E_TRANSLATOR",
    });
  });

  it("turns max_tokens into E_TRANSLATOR", async () => {
    const { client } = fakeClient({ ...ok, stop_reason: "max_tokens" });
    const llm = createAnthropicLlm({ apiKey: "k", model: "m", effort: "low", client });
    await expect(llm.completeJson({ system: "", user: "", keys: ["title"] })).rejects.toMatchObject({
      code: "E_TRANSLATOR",
    });
  });
});
```

`test/translate/providers/openai-compatible.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleLlm } from "../../../src/translate/providers/openai-compatible.js";

const body = {
  choices: [{ message: { content: '{"title":"Hallo"}' } }],
  usage: { prompt_tokens: 50, completion_tokens: 5 },
};
const json = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });

describe("createOpenAiCompatibleLlm", () => {
  it("posts a chat completion with JSON mode and auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, body));
    const llm = createOpenAiCompatibleLlm({ apiKey: "sk-x", baseUrl: "https://api.example.com/v1/", model: "gpt-x", fetchImpl });
    const res = await llm.completeJson({ system: "SYS", user: "USER", keys: ["title"] });
    expect(res).toEqual({ data: { title: "Hallo" }, usage: { inputTokens: 50, outputTokens: 5 } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-x");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("gpt-x");
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[0]).toEqual({ role: "system", content: "SYS" });
  });

  it("omits auth when no key (e.g. Ollama)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, body));
    const llm = createOpenAiCompatibleLlm({ baseUrl: "http://localhost:11434/v1", model: "qwen3", fetchImpl });
    await llm.completeJson({ system: "", user: "", keys: ["title"] });
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });

  it("retries 429 using retry-after seconds", async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(429, { error: "slow down" }, { "retry-after": "2" }))
      .mockResolvedValue(json(200, body));
    const llm = createOpenAiCompatibleLlm({
      baseUrl: "http://x/v1",
      model: "m",
      fetchImpl,
      sleep: async (ms) => void delays.push(ms),
    });
    await llm.completeJson({ system: "", user: "", keys: ["title"] });
    expect(delays).toEqual([2000]);
  });

  it("fails fast on 401 with E_TRANSLATOR and no key in the message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401, { error: "bad key" }));
    const llm = createOpenAiCompatibleLlm({ apiKey: "sk-secret-123", baseUrl: "http://x/v1", model: "m", fetchImpl });
    const err = await llm.completeJson({ system: "", user: "", keys: ["t"] }).catch((e) => e);
    expect(err.code).toBe("E_TRANSLATOR");
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("sk-secret-123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns data undefined when content is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { choices: [{ message: { content: "nope" } }] }));
    const llm = createOpenAiCompatibleLlm({ baseUrl: "http://x/v1", model: "m", fetchImpl });
    const res = await llm.completeJson({ system: "", user: "", keys: ["t"] });
    expect(res).toEqual({ data: undefined, usage: { inputTokens: 0, outputTokens: 0 } });
  });
});
```

`test/translate/providers/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createLlmClient } from "../../../src/translate/providers/index.js";

describe("createLlmClient", () => {
  it("requires ANTHROPIC_API_KEY for the anthropic provider", () => {
    expect(() =>
      createLlmClient({ provider: "anthropic", model: "claude-opus-5-5", effort: "medium", concurrency: 4 }, {}),
    ).toThrow("ANTHROPIC_API_KEY");
  });
  it("creates clients when configured", () => {
    expect(
      createLlmClient(
        { provider: "anthropic", model: "claude-opus-5-5", effort: "medium", concurrency: 4 },
        { ANTHROPIC_API_KEY: "sk-ant-test" },
      ),
    ).toHaveProperty("completeJson");
    expect(
      createLlmClient({ provider: "openai-compatible", baseUrl: "http://x/v1", model: "m", concurrency: 4 }, {}),
    ).toHaveProperty("completeJson");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/translate/providers`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/translate/providers/anthropic.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../../config/schema.js";
import { StorelingoError } from "../../errors.js";
import type { LlmClient } from "../types.js";

export function jsonSchemaFor(keys: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
    required: keys,
    additionalProperties: false,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createAnthropicLlm(opts: {
  apiKey: string;
  model: string;
  effort: Effort;
  client?: Anthropic;
}): LlmClient {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 4 });

  return {
    async completeJson({ system, user, keys }) {
      let response;
      try {
        response = await client.beta.messages.create({
          model: opts.model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system,
          messages: [{ role: "user", content: user }],
          output_config: {
            effort: opts.effort,
            format: { type: "json_schema", schema: jsonSchemaFor(keys) },
          },
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) {
          throw new StorelingoError(
            "E_TRANSLATOR",
            "Claude API rejected the API key",
            "Check ANTHROPIC_API_KEY (create keys in the Claude Console).",
          );
        }
        if (err instanceof Anthropic.APIError) {
          throw new StorelingoError("E_TRANSLATOR", `Claude API error ${err.status}: ${err.message}`);
        }
        throw err;
      }

      if (response.stop_reason === "refusal") {
        throw new StorelingoError(
          "E_TRANSLATOR",
          "The model declined to translate this listing",
          "Review the source text, or set another model in storelingo.config.json.",
        );
      }
      if (response.stop_reason === "max_tokens") {
        throw new StorelingoError("E_TRANSLATOR", "The model response was cut off (max_tokens)");
      }

      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      return {
        data: parseJson(text),
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    },
  };
}
```

- [ ] **Step 4: Implement `src/translate/providers/openai-compatible.ts`**

```ts
import { StorelingoError } from "../../errors.js";
import { RetryableError, withRetry } from "../../util/retry.js";
import type { LlmClient } from "../types.js";

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function retryAfterMs(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export function createOpenAiCompatibleLlm(opts: {
  apiKey?: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): LlmClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async completeJson({ system, user, keys }) {
      const body = JSON.stringify({
        model: opts.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${user}\n\nRespond with a JSON object with keys: ${keys.join(", ")}.` },
        ],
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

      const completion = await withRetry(
        async () => {
          let res: Response;
          try {
            res = await fetchImpl(url, { method: "POST", headers, body });
          } catch (err) {
            throw new RetryableError(`Network error: ${(err as Error).message}`);
          }
          if (res.status === 429 || res.status >= 500) {
            throw new RetryableError(`HTTP ${res.status}`, retryAfterMs(res));
          }
          if (!res.ok) {
            const text = (await res.text()).slice(0, 500);
            throw new StorelingoError("E_TRANSLATOR", `Translator API error ${res.status}: ${text}`);
          }
          return (await res.json()) as ChatCompletion;
        },
        { sleep: opts.sleep },
      ).catch((err: unknown) => {
        if (err instanceof RetryableError) {
          throw new StorelingoError("E_TRANSLATOR", `Translator API kept failing: ${err.message}`);
        }
        throw err;
      });

      const content = completion.choices?.[0]?.message?.content ?? "";
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch {
        data = undefined;
      }
      return {
        data,
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
```

- [ ] **Step 5: Implement `src/translate/providers/index.ts`**

```ts
import type { TranslatorConfig } from "../../config/schema.js";
import { StorelingoError } from "../../errors.js";
import type { LlmClient } from "../types.js";
import { createAnthropicLlm } from "./anthropic.js";
import { createOpenAiCompatibleLlm } from "./openai-compatible.js";

export function createLlmClient(t: TranslatorConfig, env: NodeJS.ProcessEnv): LlmClient {
  if (t.provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new StorelingoError(
        "E_CONFIG",
        "ANTHROPIC_API_KEY is not set",
        "Create an API key in the Claude Console and export it as ANTHROPIC_API_KEY.",
      );
    }
    return createAnthropicLlm({ apiKey, model: t.model, effort: t.effort });
  }
  return createOpenAiCompatibleLlm({ apiKey: env.OPENAI_API_KEY, baseUrl: t.baseUrl, model: t.model });
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/translate/providers && npm run typecheck`
Expected: PASS (12 tests); tsc clean. If tsc rejects `fallbacks: "default"` or `output_config.format`, upgrade the SDK as described in the notes above and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/translate/providers test/translate/providers package.json package-lock.json
git commit -m "feat: add Claude and OpenAI-compatible translator providers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Translation engine (validation and length limits)

**Files:**
- Create: `src/translate/engine.ts`
- Test: `test/translate/engine.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `Translator`, `TranslateRequest`, `addUsage`, `ZERO_USAGE` (Task 9), `SYSTEM_PROMPT`, `buildTranslatePrompt`, `buildShortenPrompt` (Task 9), `normalizeKeywords` (Task 9), `countChars` (Task 1), `StorelingoError` (Task 2)
- Produces: `createTranslator(llm: LlmClient, opts?: { maxShortenAttempts?: number }): Translator`

Behaviour (spec §6.2–6.3): one request per locale; invalid JSON or wrong keys → one retry, then `E_TRANSLATOR`; trim results; normalize keywords excluding single words of translated `name`/`subtitle`; over-limit field → up to 2 shorten requests; still over → `errors[key]`, never truncated.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { findLocale } from "../../src/locales/table.js";
import { createTranslator } from "../../src/translate/engine.js";
import type { LlmClient, LlmJsonResponse, TranslateRequest } from "../../src/translate/types.js";

const usage = { inputTokens: 10, outputTokens: 2 };
const reply = (data: unknown): LlmJsonResponse => ({ data, usage });

function fakeLlm(...responses: LlmJsonResponse[]) {
  const completeJson = vi.fn();
  for (const r of responses) completeJson.mockResolvedValueOnce(r);
  return { llm: { completeJson } as LlmClient, completeJson };
}

const base: TranslateRequest = {
  store: "appstore",
  sourceLocale: findLocale("en-US")!,
  targetLocale: findLocale("de")!,
  fields: [{ key: "name", text: "Prayer Times", maxChars: 30, kind: "text" }],
  context: "",
  doNotTranslate: [],
  terms: {},
};

describe("createTranslator", () => {
  it("returns trimmed texts and summed usage", async () => {
    const { llm, completeJson } = fakeLlm(reply({ name: "  Gebetszeiten \n" }));
    const result = await createTranslator(llm).translate(base);
    expect(result).toEqual({ texts: { name: "Gebetszeiten" }, errors: {}, usage });
    expect(completeJson.mock.calls[0]![0].keys).toEqual(["name"]);
  });

  it("retries once on an invalid response", async () => {
    const { llm, completeJson } = fakeLlm(reply(undefined), reply({ name: "Gebetszeiten" }));
    const result = await createTranslator(llm).translate(base);
    expect(result.texts.name).toBe("Gebetszeiten");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 4 });
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("rejects responses with missing or extra keys, then fails after the retry", async () => {
    const { llm } = fakeLlm(reply({ wrong: "x" }), reply({ name: "x", extra: "y" }));
    await expect(createTranslator(llm).translate(base)).rejects.toMatchObject({ code: "E_TRANSLATOR" });
  });

  it("shortens an over-limit field", async () => {
    const { llm, completeJson } = fakeLlm(
      reply({ name: "Gebetszeiten und Qibla-Kompass für Muslime" }),
      reply({ text: "Gebetszeiten & Qibla" }),
    );
    const result = await createTranslator(llm).translate(base);
    expect(result.texts.name).toBe("Gebetszeiten & Qibla");
    expect(completeJson.mock.calls[1]![0].keys).toEqual(["text"]);
    expect(completeJson.mock.calls[1]![0].user).toContain("at most 30 characters");
  });

  it("reports E_LIMIT-style error after two failed shortenings and never truncates", async () => {
    const long = "x".repeat(40);
    const { llm, completeJson } = fakeLlm(reply({ name: long }), reply({ text: long }), reply({ text: long }));
    const result = await createTranslator(llm).translate(base);
    expect(result.texts).toEqual({});
    expect(result.errors.name).toBe("40 characters, limit is 30");
    expect(completeJson).toHaveBeenCalledTimes(3);
  });

  it("normalizes keywords and removes name/subtitle words", async () => {
    const { llm } = fakeLlm(reply({ name: "Gebet", subtitle: "Koran", keywords: "gebet , koran,qibla, qibla" }));
    const result = await createTranslator(llm).translate({
      ...base,
      fields: [
        { key: "name", text: "Prayer", maxChars: 30, kind: "text" },
        { key: "subtitle", text: "Quran", maxChars: 30, kind: "text" },
        { key: "keywords", text: "prayer,quran,qibla", maxChars: 100, kind: "keywords" },
      ],
    });
    expect(result.texts.keywords).toBe("qibla");
  });

  it("does not limit fields without maxChars", async () => {
    const { llm, completeJson } = fakeLlm(reply({ name: "y".repeat(100) }));
    const result = await createTranslator(llm).translate({
      ...base,
      fields: [{ key: "name", text: "x", maxChars: null, kind: "text" }],
    });
    expect(result.texts.name).toHaveLength(100);
    expect(completeJson).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/translate/engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/translate/engine.ts`**

```ts
import { z } from "zod";
import { StorelingoError } from "../errors.js";
import { countChars } from "../util/chars.js";
import { normalizeKeywords } from "./keywords.js";
import { SYSTEM_PROMPT, buildShortenPrompt, buildTranslatePrompt } from "./prompt.js";
import {
  ZERO_USAGE,
  addUsage,
  type FieldToTranslate,
  type LlmClient,
  type TranslateRequest,
  type TranslateResult,
  type Translator,
  type Usage,
} from "./types.js";

function responseSchema(keys: string[]) {
  return z.object(Object.fromEntries(keys.map((k) => [k, z.string()]))).strict();
}

function parseTexts(data: unknown, keys: string[]): Record<string, string> | undefined {
  const parsed = responseSchema(keys).safeParse(data);
  return parsed.success ? (parsed.data as Record<string, string>) : undefined;
}

export function createTranslator(llm: LlmClient, opts: { maxShortenAttempts?: number } = {}): Translator {
  const maxShorten = opts.maxShortenAttempts ?? 2;

  return {
    async translate(req: TranslateRequest): Promise<TranslateResult> {
      let usage: Usage = ZERO_USAGE;
      const keys = req.fields.map((f) => f.key);
      const user = buildTranslatePrompt(req);

      let raw: Record<string, string> | undefined;
      for (let attempt = 0; attempt < 2 && raw === undefined; attempt++) {
        const res = await llm.completeJson({ system: SYSTEM_PROMPT, user, keys });
        usage = addUsage(usage, res.usage);
        raw = parseTexts(res.data, keys);
      }
      if (raw === undefined) {
        throw new StorelingoError(
          "E_TRANSLATOR",
          `The model returned an invalid response twice for ${req.store}/${req.targetLocale.code}`,
          "Run translate again, or try a different model.",
        );
      }

      const nameWords = [raw.name, raw.subtitle].filter((s): s is string => s !== undefined);
      const clean = (field: FieldToTranslate, text: string): string =>
        field.kind === "keywords" ? normalizeKeywords(text.trim(), nameWords) : text.trim();

      const texts: Record<string, string> = {};
      const errors: Record<string, string> = {};

      for (const field of req.fields) {
        let text = clean(field, raw[field.key] ?? "");
        if (field.maxChars !== null) {
          for (let i = 0; i < maxShorten && countChars(text) > field.maxChars; i++) {
            const res = await llm.completeJson({
              system: SYSTEM_PROMPT,
              user: buildShortenPrompt({ text, maxChars: field.maxChars, language: req.targetLocale, kind: field.kind }),
              keys: ["text"],
            });
            usage = addUsage(usage, res.usage);
            const shorter = parseTexts(res.data, ["text"]);
            if (shorter?.text !== undefined) text = clean(field, shorter.text);
          }
          if (countChars(text) > field.maxChars) {
            errors[field.key] = `${countChars(text)} characters, limit is ${field.maxChars}`;
            continue;
          }
        }
        texts[field.key] = text;
      }

      return { texts, errors, usage };
    },
  };
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/translate/engine.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/translate/engine.ts test/translate/engine.test.ts
git commit -m "feat: add translation engine with validation and limit shortening

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `check` command logic

**Files:**
- Create: `src/commands/check.ts`, `test/helpers/project.ts`
- Test: `test/commands/check.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 5), `fieldsFor`, `STORES`, `StoreId` (Task 3), `toStoreLocale` (Task 4), `storeRoot`, `resolveFieldPath`, `readField` (Task 6), `countChars` (Task 1), `normalizeKeywords` (Task 9)
- Produces:
  - `interface CheckIssue { level: "error" | "warning"; store: StoreId; locale: string; field?: string; code: string; message: string }`
  - `const STORE_NAMES: Record<StoreId, string>` — `{ play: "Google Play", appstore: "App Store" }`
  - `configuredStores(config: Config): StoreId[]`
  - `runCheck(config: Config, cwd: string): Promise<CheckIssue[]>`
  - test helper `makeProject(files: Record<string, string>, config?: object): Promise<{ cwd: string; config: Config }>`

Rules: for every configured store × (source + target locales): unsupported locale → warning `E_LOCALE_UNSUPPORTED`; for each translatable or URL field with a resolvable path: source missing & `required` → error `E_MISSING`; target missing & source present & translatable → warning `W_MISSING` ("not translated yet"); over limit (trailing newlines ignored) → error `E_LIMIT`; keywords not equal to their normalized form → error `E_FORMAT`.

- [ ] **Step 1: Write the test helper `test/helpers/project.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { runCheck } from "../../src/commands/check.js";
import { makeProject } from "../helpers/project.js";

const P = "fastlane/metadata/android";
const A = "fastlane/metadata";

const complete = {
  [`${P}/en-US/title.txt`]: "Prayer Times\n",
  [`${P}/en-US/short_description.txt`]: "Accurate prayer times",
  [`${P}/en-US/full_description.txt`]: "Long text",
  [`${P}/ru-RU/title.txt`]: "Время намаза",
  [`${P}/ru-RU/short_description.txt`]: "Точное время",
  [`${P}/ru-RU/full_description.txt`]: "Длинный текст",
  [`${P}/ky-KG/title.txt`]: "Намаз убактысы",
  [`${P}/ky-KG/short_description.txt`]: "Так убакыт",
  [`${P}/ky-KG/full_description.txt`]: "Узун текст",
  [`${A}/en-US/name.txt`]: "Prayer Times",
  [`${A}/en-US/description.txt`]: "Long text",
  [`${A}/en-US/keywords.txt`]: "quran,qibla",
  [`${A}/ru/name.txt`]: "Время намаза",
  [`${A}/ru/description.txt`]: "Длинный текст",
  [`${A}/ru/keywords.txt`]: "коран,кибла",
};

describe("runCheck", () => {
  it("passes a complete project, warning only about unsupported locales", async () => {
    const { cwd, config } = await makeProject(complete);
    const issues = await runCheck(config, cwd);
    expect(issues).toEqual([
      {
        level: "warning",
        store: "appstore",
        locale: "ky",
        code: "E_LOCALE_UNSUPPORTED",
        message: "App Store does not support ky; skipped",
      },
    ]);
  });

  it("reports a missing required source field", async () => {
    const files = { ...complete };
    delete files[`${A}/en-US/name.txt`];
    const { cwd, config } = await makeProject(files);
    const issues = await runCheck(config, cwd);
    expect(issues).toContainEqual(
      expect.objectContaining({ level: "error", store: "appstore", locale: "en-US", field: "name", code: "E_MISSING" }),
    );
  });

  it("warns about untranslated fields", async () => {
    const files = { ...complete };
    delete files[`${P}/ru-RU/title.txt`];
    const { cwd, config } = await makeProject(files);
    expect(await runCheck(config, cwd)).toContainEqual(
      expect.objectContaining({ level: "warning", store: "play", locale: "ru-RU", field: "title", code: "W_MISSING" }),
    );
  });

  it("reports over-limit fields, ignoring trailing newlines", async () => {
    const { cwd, config } = await makeProject({
      ...complete,
      [`${P}/ru-RU/title.txt`]: "Очень длинное название приложения",
      [`${P}/en-US/title.txt`]: `${"x".repeat(30)}\n\n`,
    });
    const issues = (await runCheck(config, cwd)).filter((i) => i.code === "E_LIMIT");
    expect(issues).toEqual([
      expect.objectContaining({ store: "play", locale: "ru-RU", field: "title", message: "33 characters, limit is 30" }),
    ]);
  });

  it("reports badly formatted keywords", async () => {
    const { cwd, config } = await makeProject({ ...complete, [`${A}/ru/keywords.txt`]: "коран, кибла,коран" });
    expect(await runCheck(config, cwd)).toContainEqual(
      expect.objectContaining({ level: "error", locale: "ru", field: "keywords", code: "E_FORMAT" }),
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/commands/check.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/commands/check.ts`**

```ts
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
```

- [ ] **Step 5: Run test**

Run: `npx vitest run test/commands/check.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/check.ts test/commands/check.test.ts test/helpers/project.ts
git commit -m "feat: add offline check for limits, missing fields and keywords

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: `translate` command orchestration

**Files:**
- Create: `src/commands/translate.ts`
- Test: `test/commands/translate.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 5), `fieldsFor`, `StoreId` (Task 3), `findLocale`, `toStoreLocale` (Task 4), `storeRoot`, `resolveFieldPath`, `readField`, `writeField` (Task 6), `LOCK_FILE`, `loadLock`, `saveLock`, `decide`, `hashText`, `lockKey` (Task 7), `runPool` (Task 8), `Translator`, `Usage`, `ZERO_USAGE`, `addUsage` (Task 9), `configuredStores`, `STORE_NAMES` (Task 12), `Logger` (Task 2), `StorelingoError` (Task 2)
- Produces:
  - `interface TranslateOptions { config: Config; cwd: string; translator: Translator; log: Logger; locales?: string[]; force?: boolean }`
  - `interface TranslateFailure { store: StoreId; locale: string; field?: string; message: string }`
  - `interface TranslateReport { translated: number; unchanged: number; manual: number; unsupported: number; failed: TranslateFailure[]; usage: Usage }`
  - `runTranslate(opts: TranslateOptions): Promise<TranslateReport>`

Behaviour: jobs = configured store × target locale; per job collect fields where `decide()` returns `"translate"`; the text sent to the model has trailing newlines removed and the written file gets the source's trailing `\n` back; lock is saved after every job (serialized); a thrown translator error fails only that job.

- [ ] **Step 1: Write the failing test**

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runTranslate } from "../../src/commands/translate.js";
import { createLogger } from "../../src/log.js";
import { LOCK_FILE, loadLock } from "../../src/lock/lock.js";
import { StorelingoError } from "../../src/errors.js";
import type { TranslateRequest, Translator } from "../../src/translate/types.js";
import { makeProject } from "../helpers/project.js";

const P = "fastlane/metadata/android";
const config = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "de"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic", concurrency: 2 },
  glossary: { doNotTranslate: ["Qibla"], terms: { ru: { prayer: "намаз" } } },
};
const files = {
  [`${P}/en-US/title.txt`]: "Prayer Times\n",
  [`${P}/en-US/short_description.txt`]: "Accurate times",
};

const silent = createLogger({ verbose: false, secrets: [], out: () => {}, err: () => {} });

function fakeTranslator(fn?: (req: TranslateRequest) => Promise<void>) {
  const calls: TranslateRequest[] = [];
  const translator: Translator = {
    translate: vi.fn(async (req: TranslateRequest) => {
      calls.push(req);
      await fn?.(req);
      return {
        texts: Object.fromEntries(req.fields.map((f) => [f.key, `[${req.targetLocale.code}] ${f.text}`])),
        errors: {},
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    }),
  };
  return { translator, calls };
}

describe("runTranslate", () => {
  it("translates all fields, restores trailing newline and writes the lock", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    const { translator, calls } = fakeTranslator();
    const report = await runTranslate({ config: cfg, cwd, translator, log: silent });

    expect(report).toMatchObject({ translated: 4, unchanged: 0, manual: 0, unsupported: 0, failed: [] });
    expect(report.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(await readFile(join(cwd, P, "ru-RU", "title.txt"), "utf8")).toBe("[ru] Prayer Times\n");
    expect(await readFile(join(cwd, P, "de-DE", "short_description.txt"), "utf8")).toBe("[de] Accurate times");

    const ru = calls.find((c) => c.targetLocale.code === "ru")!;
    expect(ru.fields.map((f) => f.text)).toEqual(["Prayer Times", "Accurate times"]);
    expect(ru.terms).toEqual({ prayer: "намаз" });
    expect(ru.doNotTranslate).toEqual(["Qibla"]);

    const lock = await loadLock(join(cwd, LOCK_FILE));
    expect(Object.keys(lock.entries).sort()).toEqual([
      "play/de-DE/short_description",
      "play/de-DE/title",
      "play/ru-RU/short_description",
      "play/ru-RU/title",
    ]);
  });

  it("skips unchanged fields on the second run", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    await runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent });
    const second = fakeTranslator();
    const report = await runTranslate({ config: cfg, cwd, translator: second.translator, log: silent });
    expect(report).toMatchObject({ translated: 0, unchanged: 4 });
    expect(second.calls).toHaveLength(0);
  });

  it("protects manual edits unless --force", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    await runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent });
    await writeFile(join(cwd, P, "ru-RU", "title.txt"), "Время намаза");
    await writeFile(join(cwd, P, "en-US", "title.txt"), "Prayer Times Pro\n");

    const report = await runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent });
    expect(report).toMatchObject({ translated: 1, manual: 1 });
    expect(await readFile(join(cwd, P, "ru-RU", "title.txt"), "utf8")).toBe("Время намаза");

    const forced = await runTranslate({ config: cfg, cwd, translator: fakeTranslator().translator, log: silent, force: true });
    expect(forced.translated).toBe(4);
    expect(await readFile(join(cwd, P, "ru-RU", "title.txt"), "utf8")).toBe("[ru] Prayer Times Pro\n");
  });

  it("limits to --locale and rejects locales outside targetLocales", async () => {
    const { cwd, config: cfg } = await makeProject(files, config);
    const { translator, calls } = fakeTranslator();
    await runTranslate({ config: cfg, cwd, translator, log: silent, locales: ["de"] });
    expect(calls.map((c) => c.targetLocale.code)).toEqual(["de"]);
    await expect(runTranslate({ config: cfg, cwd, translator, log: silent, locales: ["fr-FR"] })).rejects.toMatchObject({
      code: "E_USAGE",
    });
  });

  it("counts unsupported locales and keeps going after a failed job", async () => {
    const { cwd, config: cfg } = await makeProject(files, {
      ...config,
      targetLocales: ["ru", "de", "ky"],
      stores: { play: { packageName: "x" }, appstore: { appId: "1" } },
    });
    const { translator } = fakeTranslator(async (req) => {
      if (req.targetLocale.code === "de") throw new StorelingoError("E_TRANSLATOR", "boom");
    });
    const report = await runTranslate({ config: cfg, cwd, translator, log: silent });
    expect(report.unsupported).toBe(1); // ky on App Store
    expect(report.failed).toEqual([{ store: "play", locale: "de-DE", message: "boom" }]);
    expect(report.translated).toBe(4); // ru + ky on Play
  });

  it("records per-field errors from the translator", async () => {
    const { cwd, config: cfg } = await makeProject(files, { ...config, targetLocales: ["ru"] });
    const translator: Translator = {
      translate: async () => ({
        texts: { short_description: "Точно" },
        errors: { title: "40 characters, limit is 30" },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const report = await runTranslate({ config: cfg, cwd, translator, log: silent });
    expect(report.translated).toBe(1);
    expect(report.failed).toEqual([
      { store: "play", locale: "ru-RU", field: "title", message: "40 characters, limit is 30" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/commands/translate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/commands/translate.ts`**

```ts
import { join } from "node:path";
import type { Config } from "../config/schema.js";
import { StorelingoError } from "../errors.js";
import { fieldsFor, type StoreId } from "../fields/registry.js";
import { findLocale, toStoreLocale, type LocaleDef } from "../locales/table.js";
import { LOCK_FILE, decide, hashText, loadLock, lockKey, saveLock } from "../lock/lock.js";
import type { Logger } from "../log.js";
import { readField, resolveFieldPath, storeRoot, writeField } from "../metadata/fastlane.js";
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
  root: string;
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

  let saving: Promise<void> = Promise.resolve();
  const persistLock = () => {
    saving = saving.then(() => saveLock(lockFile, lock));
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
      report.failed.push({ store: job.store, locale: job.storeLocale, message: (err as Error).message });
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
      await writeField(job.root, job.storeLocale, field.rel, output);
      lock.entries[lockKey(job.store, job.storeLocale, field.key)] = {
        sourceHash: hashText(field.source),
        outputHash: hashText(output),
      };
      report.translated++;
    }
    await persistLock();
  });

  await saving;
  return report;
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run test/commands/translate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/translate.ts test/commands/translate.test.ts
git commit -m "feat: add translate command with incremental lock and concurrency

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `init` command

**Files:**
- Create: `src/commands/init.ts`
- Test: `test/commands/init.test.ts`

**Interfaces:**
- Consumes: `CONFIG_FILE`, `parseConfig` (Task 5), `DEFAULT_ROOTS` (Task 6), `toStoreLocale`, `LOCALES` (Task 4), `StorelingoError` (Task 2)
- Produces:
  - `interface InitAnswers { sourceLocale: string; targetLocales: string[]; playPackageName?: string; appstoreAppId?: string; provider: "anthropic" | "openai-compatible"; baseUrl?: string; model?: string; context: string }`
  - `buildConfigJson(a: InitAnswers): Record<string, unknown>`
  - `writeInitFiles(cwd: string, answers: InitAnswers, opts?: { force?: boolean }): Promise<string[]>` — returns created/updated paths relative to cwd
  - `promptInitAnswers(): Promise<InitAnswers>` (interactive, not unit-tested)

- [ ] **Step 1: Write the failing test**

```ts
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfigJson, writeInitFiles, type InitAnswers } from "../../src/commands/init.js";
import { parseConfig } from "../../src/config/load.js";
import { makeTmpDir } from "../helpers/tmp.js";

const answers: InitAnswers = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "ky"],
  playPackageName: "com.example.app",
  appstoreAppId: "123",
  provider: "anthropic",
  context: "Prayer times app",
};

describe("buildConfigJson", () => {
  it("produces a valid config", () => {
    const config = parseConfig(buildConfigJson(answers));
    expect(config.stores).toEqual({ play: { packageName: "com.example.app" }, appstore: { appId: "123" } });
    expect(config.translator.provider).toBe("anthropic");
  });
  it("includes baseUrl and model for openai-compatible", () => {
    const json = buildConfigJson({ ...answers, provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen3" });
    expect(json.translator).toEqual({ provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen3" });
  });
});

describe("writeInitFiles", () => {
  it("writes config, source folders and .gitignore entries", async () => {
    const cwd = await makeTmpDir();
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    const created = await writeInitFiles(cwd, answers);

    expect(created).toEqual([
      "storelingo.config.json",
      "fastlane/metadata/android/en-US",
      "fastlane/metadata/en-US",
      ".gitignore",
    ]);
    const config = JSON.parse(await readFile(join(cwd, "storelingo.config.json"), "utf8"));
    expect(config.$schema).toBe("https://unpkg.com/storelingo/schema.json");
    expect((await stat(join(cwd, "fastlane/metadata/android/en-US"))).isDirectory()).toBe(true);
    const gitignore = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gitignore).toBe("node_modules/\n*.p8\nplay-service-account*.json\n");
  });

  it("does not duplicate .gitignore entries", async () => {
    const cwd = await makeTmpDir();
    await writeFile(join(cwd, ".gitignore"), "*.p8\nplay-service-account*.json\n");
    const created = await writeInitFiles(cwd, answers);
    expect(created).not.toContain(".gitignore");
  });

  it("refuses to overwrite an existing config without force", async () => {
    const cwd = await makeTmpDir();
    await writeInitFiles(cwd, answers);
    await expect(writeInitFiles(cwd, answers)).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(writeInitFiles(cwd, { ...answers, targetLocales: ["de"] }, { force: true })).resolves.toContain(
      "storelingo.config.json",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/commands/init.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/commands/init.ts`**

```ts
import { checkbox, input, select } from "@inquirer/prompts";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE, parseConfig } from "../config/load.js";
import { StorelingoError } from "../errors.js";
import type { StoreId } from "../fields/registry.js";
import { LOCALES, toStoreLocale } from "../locales/table.js";
import { DEFAULT_ROOTS } from "../metadata/fastlane.js";

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
    $schema: "https://unpkg.com/storelingo/schema.json",
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
): Promise<string[]> {
  const json = buildConfigJson(answers);
  const config = parseConfig(json); // validate before touching disk
  const configPath = join(cwd, CONFIG_FILE);
  if (!opts.force && (await exists(configPath))) {
    throw new StorelingoError("E_USAGE", `${CONFIG_FILE} already exists`, "Use `storelingo init --force` to overwrite it.");
  }

  const created: string[] = [];
  await writeFile(configPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  created.push(CONFIG_FILE);

  for (const store of ["play", "appstore"] as StoreId[]) {
    if (!config.stores[store]) continue;
    const storeLocale = toStoreLocale(store, config.sourceLocale);
    if (!storeLocale) continue;
    const rel = `${DEFAULT_ROOTS[store]}/${storeLocale}`;
    await mkdir(join(cwd, ...rel.split("/")), { recursive: true });
    created.push(rel);
  }

  const gitignorePath = join(cwd, ".gitignore");
  const current = (await exists(gitignorePath)) ? await readFile(gitignorePath, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length > 0) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
    created.push(".gitignore");
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
    ? await input({ message: "App Store app ID (numbers from App Store Connect)", required: true })
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
```

- [ ] **Step 4: Run test and typecheck**

Run: `npx vitest run test/commands/init.test.ts && npm run typecheck`
Expected: PASS (5 tests); tsc clean. If `@inquirer/prompts` option names differ in the installed version (`required`, `default`), follow the tsc errors — the unit tests do not depend on the prompt function.

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts test/commands/init.test.ts
git commit -m "feat: add init command that scaffolds config and folders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: CLI wiring and binary

**Files:**
- Create: `src/cli/main.ts`, `src/bin.ts`
- Test: `test/cli/main.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `interface CliDeps { cwd: string; env: NodeJS.ProcessEnv; out: (line: string) => void; err: (line: string) => void; makeTranslator?: (config: Config, env: NodeJS.ProcessEnv) => Translator; promptInit?: () => Promise<InitAnswers> }`
  - `main(argv: string[], deps?: CliDeps): Promise<number>` — returns the exit code, never calls `process.exit`

Commands: `init [--force]`, `translate [--locale <code...>] [--force]`, `check`. Global: `--config <path>`, `--verbose`, `--no-color` (accepted; output has no colors in v0.1).

- [ ] **Step 1: Write the failing test**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type CliDeps } from "../../src/cli/main.js";
import type { Translator } from "../../src/translate/types.js";
import { makeProject } from "../helpers/project.js";
import { makeTmpDir } from "../helpers/tmp.js";

const P = "fastlane/metadata/android";
const config = {
  sourceLocale: "en-US",
  targetLocales: ["ru"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic" },
};
const files = {
  "storelingo.config.json": JSON.stringify(config),
  [`${P}/en-US/title.txt`]: "Prayer Times",
  [`${P}/en-US/short_description.txt`]: "Accurate",
  [`${P}/en-US/full_description.txt`]: "Long",
};

const echoTranslator: Translator = {
  translate: async (req) => ({
    texts: Object.fromEntries(req.fields.map((f) => [f.key, `RU ${f.text}`])),
    errors: {},
    usage: { inputTokens: 5, outputTokens: 1 },
  }),
};

function deps(cwd: string, extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: CliDeps = {
    cwd,
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    makeTranslator: () => echoTranslator,
    ...extra,
  };
  return { d, out, err };
}

const run = (d: CliDeps, ...args: string[]) => main(["node", "storelingo", ...args], d);

describe("cli", () => {
  it("check passes with warnings before translation, translate fills the gaps", async () => {
    const { cwd } = await makeProject(files, config);
    const first = deps(cwd);
    expect(await run(first.d, "check")).toBe(0); // missing translations are warnings only
    expect(first.err.join("\n")).toContain("not translated yet");

    const t = deps(cwd);
    expect(await run(t.d, "translate")).toBe(0);
    expect(t.out.join("\n")).toContain("Translated 3 fields");
    expect(await readFile(join(cwd, P, "ru-RU", "title.txt"), "utf8")).toBe("RU Prayer Times");
  });

  it("check returns 1 on errors", async () => {
    const { cwd } = await makeProject({ ...files, [`${P}/en-US/title.txt`]: "x".repeat(31) }, config);
    const { d, err } = deps(cwd);
    expect(await run(d, "check")).toBe(1);
    expect(err.join("\n")).toContain("error play/en-US/title: 31 characters, limit is 30");
  });

  it("returns 2 with a hint when the config is missing", async () => {
    const cwd = await makeTmpDir();
    const { d, err } = deps(cwd);
    expect(await run(d, "check")).toBe(2);
    expect(err.join("\n")).toContain("E_CONFIG");
    expect(err.join("\n")).toContain("npx storelingo init");
  });

  it("supports --config with a relative path", async () => {
    const { cwd } = await makeProject({ ...files, "conf/sl.json": JSON.stringify(config) }, config);
    const { d } = deps(cwd);
    expect(await run(d, "--config", "conf/sl.json", "check")).toBe(0);
  });

  it("init uses the prompt and writes files", async () => {
    const cwd = await makeTmpDir();
    const { d, out } = deps(cwd, {
      promptInit: async () => ({
        sourceLocale: "en-US",
        targetLocales: ["de"],
        playPackageName: "a.b",
        provider: "anthropic",
        context: "",
      }),
    });
    expect(await run(d, "init")).toBe(0);
    expect(out.join("\n")).toContain("created storelingo.config.json");
  });

  it("translate returns 1 when some fields failed", async () => {
    const { cwd } = await makeProject(files, config);
    const failing: Translator = {
      translate: async () => ({ texts: {}, errors: { title: "too long" }, usage: { inputTokens: 0, outputTokens: 0 } }),
    };
    const { d, err } = deps(cwd, { makeTranslator: () => failing });
    expect(await run(d, "translate")).toBe(1);
    expect(err.join("\n")).toContain("play/ru-RU/title: too long");
  });

  it("prints help with exit 0", async () => {
    const cwd = await makeTmpDir();
    const { d, out } = deps(cwd);
    expect(await run(d, "--help")).toBe(0);
    expect(out.join("\n")).toContain("translate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/main.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/cli/main.ts`**

```ts
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

  const logger = (): Logger =>
    createLogger({
      verbose: program.opts<GlobalOpts>().verbose ?? false,
      secrets: [deps.env.ANTHROPIC_API_KEY, deps.env.OPENAI_API_KEY],
      out: deps.out,
      err: deps.err,
    });
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
      for (const path of created) log.info(`created ${path}`);
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
      deps.err(`error [${err.code}]: ${err.message}`);
      if (err.hint) deps.err(`hint: ${err.hint}`);
    } else {
      deps.err(`error: ${(err as Error).message}`);
    }
    return exitCodeFor(err);
  }
}
```

- [ ] **Step 4: Implement `src/bin.ts`**

```ts
#!/usr/bin/env node
import { main } from "./cli/main.js";

main(process.argv).then((code) => {
  process.exitCode = code;
});
```

- [ ] **Step 5: Run tests, build, and smoke-test the binary**

Run:
```bash
npx vitest run test/cli/main.test.ts
npm run build
node dist/bin.js --help
```
Expected: 7 tests pass; build succeeds; help lists `init`, `check`, `translate`.

- [ ] **Step 6: Run the whole suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/cli src/bin.ts test/cli
git commit -m "feat: wire init, check and translate into the CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Docs and package check

**Files:**
- Create: `README.md`, `README.ru.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/new_store_or_locale.md`, `.github/pull_request_template.md`, `CHANGELOG.md`

- [ ] **Step 1: Write `README.md`** (English) with these sections and content:
  - Title + one-line pitch: "AI localization for your Google Play and App Store listings. Works with fastlane metadata — no fastlane required."
  - **Why**: store character limits respected (never truncated), keywords localized for search not translated literally, manual edits protected, incremental (lock file), bring your own model (Claude or any OpenAI-compatible endpoint, incl. local Ollama).
  - **Quick start**:
    ```bash
    npx storelingo init
    export ANTHROPIC_API_KEY=sk-ant-...
    npx storelingo translate
    git diff
    npx storelingo check
    ```
  - **Folder layout**: the two fastlane trees from spec §5.1.
  - **Config reference**: the JSON example from spec §5.3 and a table of each key.
  - **Commands**: `init`, `translate [--locale <code...>] [--force]`, `check`, global flags; exit codes 0/1/2.
  - **How translation works**: one request per store+locale, limits, shortening retries, lock file and manual-edit protection, keywords rules.
  - **Cost**: default model `claude-opus-5-5` at `effort: "medium"`; set `"model": "claude-haiku-5-5"` or `"claude-sonnet-5-5"` for cheaper runs; token totals are printed after each run.
  - **Supported languages**: generated table of `LOCALES` (code, name, Play, App Store; "—" where unsupported).
  - **Roadmap**: v0.2 Google Play `pull`/`push`, v0.3 App Store `pull`/`push`, v1.0 GitHub Action; later: screenshots, RuStore, Huawei AppGallery.
  - **Contributing** link and MIT license.

- [ ] **Step 2: Write `README.ru.md`** — the same content in Russian.

- [ ] **Step 3: Write `CONTRIBUTING.md`** covering: requirements (Node 20+), `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`; TDD expectation (a failing test first); how to add a locale (one row in `src/locales/table.ts` + test), how to update a limit (`src/fields/registry.ts` + source link in the PR), how to add a translator provider (implement `LlmClient` in `src/translate/providers/`, register in `index.ts`, add tests with a fake `fetch`); commit message style (`feat:`, `fix:`, `docs:`, `chore:`); never commit API keys.

- [ ] **Step 4: Write issue/PR templates and `CHANGELOG.md`**

`.github/ISSUE_TEMPLATE/bug_report.md`:
```markdown
---
name: Bug report
about: Something does not work as described
labels: bug
---

**Command you ran**

**What happened** (paste output with `--verbose`; remove any keys)

**What you expected**

**Environment**: OS, Node version, storelingo version, translator provider/model
```

`.github/ISSUE_TEMPLATE/new_store_or_locale.md`:
```markdown
---
name: New store, locale or limit change
about: Add a language, update a character limit, or propose a new store
labels: good first issue
---

**What to add or change**

**Official source** (link to Play Console / App Store Connect / store docs)
```

`.github/pull_request_template.md`:
```markdown
## What

## Why

## Checklist
- [ ] Tests added or updated (failing first)
- [ ] `npm run lint && npm run typecheck && npm test` pass
- [ ] No API keys or real store credentials in the diff
```

`CHANGELOG.md`:
```markdown
# Changelog

## 0.1.0 — unreleased

- `init`: create `storelingo.config.json` and fastlane folders.
- `translate`: AI localization with store limits, keyword rules, lock file and manual-edit protection.
- `check`: offline validation of limits, missing fields and keyword format.
- Translators: Claude API and any OpenAI-compatible endpoint.
```

- [ ] **Step 5: Verify the package contents**

Run:
```bash
npm run build
npm pack --dry-run
```
Expected: the tarball lists only `dist/**`, `README.md`, `LICENSE`, `package.json`; no `test/`, no `src/`.

- [ ] **Step 6: Commit**

```bash
git add README.md README.ru.md CONTRIBUTING.md CHANGELOG.md .github
git commit -m "docs: add README (en/ru), contributing guide and templates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After this plan (not part of v0.1)

- Manual end-to-end run with a real `ANTHROPIC_API_KEY` on a real listing (reviewed by the user; costs real tokens).
- Create the GitHub repository `Alisher23/storelingo` and push (user action / explicit approval).
- Publish to npm (user action / explicit approval).
- Next plans: v0.2 Google Play `pull`/`push`, v0.3 App Store `pull`/`push`.
