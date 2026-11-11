# storelingo v0.3 (App Store pull/push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add App Store Connect support to `storelingo pull` / `push`, and make both commands work across all configured stores.

**Architecture:** Same layering as the Google Play adapter: `src/stores/app-store/auth.ts` (ES256 JWT, no network), `client.ts` (raw HTTP to the App Store Connect API), `store.ts` (a `StoreClient` that picks the editable/live app info and version and routes each field to the right resource). App Store writes are not atomic, so `StoreSession` gains optional `atomic`, `isWritable(field)` and `notes`; `push` uses them to skip fields that can't be written and to report partial progress honestly.

**Tech Stack:** unchanged (Node ≥ 22.13, TypeScript strict, commander, zod, jose, vitest).

**Spec:** `docs/superpowers/specs/2026-11-06-storelingo-design.md` — §7.2 (App Store, incl. the verified API facts and resource-selection rules), §7.1 `--store` bullet, §7.3, §8.

## Global Constraints

- Everything from the v0.1/v0.2 Global Constraints holds (ESM + `.js` imports, strict TS, no `any` in `src/`, UTF-8/LF, code points, never truncate, secrets only from env and never in logs/errors/files, exit codes 0/1/2, symlink refusal via `assertSafePath`, `redirect: "error"` + timeout on every request, BOM only as the `\uFEFF` escape and byte-checked).
- No new runtime dependencies.
- App Store Connect base `https://api.appstoreconnect.apple.com`. JWT: header `{ alg: "ES256", kid, typ: "JWT" }`, claims `iss` (Issuer ID), `iat`, `exp = iat + 900`, `aud: "appstoreconnect-v1"`. Team keys only.
- Env: `STORELINGO_ASC_ISSUER_ID`, `STORELINGO_ASC_KEY_ID`, `STORELINGO_ASC_PRIVATE_KEY` (path to the `.p8` or its contents; literal `\n` sequences accepted).
- Editable version states: `PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED, METADATA_REJECTED`. Editable app info states: `PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED`. Live state for both: `READY_FOR_DISTRIBUTION`.
- POST (create) requests to App Store Connect are never retried; a lost response becomes `E_STORE` "status is unknown … run `storelingo push --dry-run`".
- `push` never sends a field to a resource that can't take it; such changes are shown as skipped.
- Commit trailer names the authoring model.

---

### Task 1: Config `platform` and App Store Connect auth

**Files:**
- Modify: `src/config/schema.ts`, `test/config/load.test.ts`
- Create: `src/stores/app-store/auth.ts`, `test/stores/app-store/auth.test.ts`

**Interfaces:**
- Produces: `stores.appstore` = `{ appId: string /* digits only */; platform: "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS" /* default "IOS" */ }`; `ASC_AUDIENCE`; `interface AscKey { issuerId: string; keyId: string; privateKey: string }`; `loadAscKey(env): Promise<AscKey>`; `createAscTokenProvider(opts: { key: AscKey; now?: () => number }): { getToken(): Promise<string> }`.

- [ ] **Step 1: Config.** In `src/config/schema.ts` replace the appstore entry with:
```ts
      appstore: z
        .strictObject({
          appId: z.string().regex(/^\d+$/, "must be the numeric Apple ID of the app"),
          platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
        })
        .optional(),
```
Add to `test/config/load.test.ts`:
```ts
  it("defaults the App Store platform to IOS and requires a numeric appId", () => {
    const cfg = parseConfig({ ...minimal, stores: { appstore: { appId: "1234567890" } } });
    expect(cfg.stores.appstore).toEqual({ appId: "1234567890", platform: "IOS" });
    expect(() => parseConfig({ ...minimal, stores: { appstore: { appId: "com.example" } } })).toThrow(
      "stores.appstore.appId",
    );
  });
```
(`minimal` already exists in that file.) Run it RED → implement → GREEN.

- [ ] **Step 2: Write the failing test `test/stores/app-store/auth.test.ts`**
```ts
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { ASC_AUDIENCE, createAscTokenProvider, loadAscKey } from "../../../src/stores/app-store/auth.js";
import { makeTmpDir } from "../../helpers/tmp.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const env = (value: string) => ({
  STORELINGO_ASC_ISSUER_ID: "57246542-96fe-1a63-e053-0824d011072a",
  STORELINGO_ASC_KEY_ID: "2X9R4HXF34",
  STORELINGO_ASC_PRIVATE_KEY: value,
});

describe("loadAscKey", () => {
  it("reads the key inline", async () => {
    expect(await loadAscKey(env(privateKey))).toEqual({
      issuerId: "57246542-96fe-1a63-e053-0824d011072a",
      keyId: "2X9R4HXF34",
      privateKey,
    });
  });

  it("reads the key from a .p8 path", async () => {
    const file = join(await makeTmpDir(), "AuthKey_2X9R4HXF34.p8");
    await writeFile(file, privateKey);
    expect((await loadAscKey(env(file))).privateKey).toBe(privateKey);
  });

  it("accepts literal \\n sequences (CI secrets)", async () => {
    const escaped = privateKey.trim().split("\n").join("\\n");
    expect((await loadAscKey(env(escaped))).privateKey.trim()).toBe(privateKey.trim());
  });

  it("names every missing variable", async () => {
    await expect(loadAscKey({ STORELINGO_ASC_KEY_ID: "x" })).rejects.toMatchObject({
      code: "E_CONFIG",
      message: "STORELINGO_ASC_ISSUER_ID, STORELINGO_ASC_PRIVATE_KEY not set",
    });
  });

  it("explains an unreadable file without echoing secrets", async () => {
    const err = await loadAscKey(env(join(await makeTmpDir(), "missing.p8"))).catch((e) => e);
    expect(err.code).toBe("E_CONFIG");
  });
});

describe("createAscTokenProvider", () => {
  const key = { issuerId: "issuer-1", keyId: "KEY123", privateKey };

  it("signs an ES256 token Apple accepts", async () => {
    const now = 1_800_000_000_000;
    const token = await createAscTokenProvider({ key, now: () => now }).getToken();
    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    const { payload } = await jwtVerify(token, await importSPKI(publicKey, "ES256"), {
      issuer: "issuer-1",
      audience: ASC_AUDIENCE,
      currentDate: new Date(now),
    });
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it("reuses the token until a minute before expiry", async () => {
    let now = 1_800_000_000_000;
    const provider = createAscTokenProvider({ key, now: () => now });
    const first = await provider.getToken();
    now += 13 * 60_000;
    expect(await provider.getToken()).toBe(first);
    now += 60_000 + 1_000; // 14 min 1 s after issue: inside the refresh margin
    expect(await provider.getToken()).not.toBe(first);
  });

  it("rejects a malformed key with E_CONFIG", async () => {
    const bad = { ...key, privateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" };
    await expect(createAscTokenProvider({ key: bad }).getToken()).rejects.toMatchObject({ code: "E_CONFIG" });
  });
});
```
Note: two tokens signed in the same second are different because ES256 signatures are randomized, so the refresh test compares tokens, not payloads.

- [ ] **Step 3: Implement `src/stores/app-store/auth.ts`**
```ts
import { readFile } from "node:fs/promises";
import { SignJWT, importPKCS8 } from "jose";
import { StorelingoError } from "../../errors.js";

export const ASC_AUDIENCE = "appstoreconnect-v1";
const TOKEN_LIFETIME_S = 15 * 60; // Apple allows at most 20 minutes
const REFRESH_MARGIN_MS = 60_000;
const SETUP_URL = "https://github.com/Alisher23/storelingo/blob/main/docs/app-store-setup.md";

export interface AscKey {
  issuerId: string;
  keyId: string;
  privateKey: string;
}

/** Reads the App Store Connect team API key from STORELINGO_ASC_* environment variables. */
export async function loadAscKey(env: NodeJS.ProcessEnv): Promise<AscKey> {
  const vars = {
    STORELINGO_ASC_ISSUER_ID: env.STORELINGO_ASC_ISSUER_ID?.trim(),
    STORELINGO_ASC_KEY_ID: env.STORELINGO_ASC_KEY_ID?.trim(),
    STORELINGO_ASC_PRIVATE_KEY: env.STORELINGO_ASC_PRIVATE_KEY?.trim(),
  };
  const missing = Object.entries(vars)
    .filter(([, v]) => !v)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new StorelingoError(
      "E_CONFIG",
      `${missing.join(", ")} not set`,
      `Create an App Store Connect API key (Users and Access → Integrations) and set the variables. See ${SETUP_URL}`,
    );
  }
  const value = vars.STORELINGO_ASC_PRIVATE_KEY as string;
  let pem = value;
  if (!value.includes("PRIVATE KEY")) {
    try {
      pem = await readFile(value, "utf8");
    } catch {
      throw new StorelingoError(
        "E_CONFIG",
        "Cannot read the .p8 file named in STORELINGO_ASC_PRIVATE_KEY",
        "Check that the path exists and is readable.",
      );
    }
  }
  pem = pem.replace(/^\uFEFF/, "");
  if (!pem.includes("\n") && pem.includes("\\n")) pem = pem.split("\\n").join("\n");
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw new StorelingoError("E_CONFIG", "STORELINGO_ASC_PRIVATE_KEY does not contain a .p8 private key");
  }
  return { issuerId: vars.STORELINGO_ASC_ISSUER_ID as string, keyId: vars.STORELINGO_ASC_KEY_ID as string, privateKey: pem };
}

export interface AscTokenProvider {
  getToken(): Promise<string>;
}

export function createAscTokenProvider(opts: { key: AscKey; now?: () => number }): AscTokenProvider {
  const now = opts.now ?? (() => Date.now());
  let cached: { token: string; expiresAt: number } | undefined;
  return {
    async getToken() {
      if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
      let key;
      try {
        key = await importPKCS8(opts.key.privateKey, "ES256");
      } catch {
        throw new StorelingoError("E_CONFIG", "STORELINGO_ASC_PRIVATE_KEY is not a valid ES256 (.p8) key");
      }
      const iat = Math.floor(now() / 1000);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: opts.key.keyId, typ: "JWT" })
        .setIssuer(opts.key.issuerId)
        .setAudience(ASC_AUDIENCE)
        .setIssuedAt(iat)
        .setExpirationTime(iat + TOKEN_LIFETIME_S)
        .sign(key);
      cached = { token, expiresAt: (iat + TOKEN_LIFETIME_S) * 1000 };
      return token;
    },
  };
}
```

- [ ] **Step 4:** Focused tests GREEN, full gate, BOM byte check, commit `feat: App Store Connect auth and appstore platform config`.

---

### Task 2: App Store Connect HTTP client

**Files:** Create `src/stores/app-store/client.ts`, `test/stores/app-store/client.test.ts`

**Interfaces:**
- Consumes: `StorelingoError`, `withRetry`, `RetryableError`.
- Produces:
```ts
export const ASC_API_BASE = "https://api.appstoreconnect.apple.com";
export type AscPlatform = "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS";
export interface AscResource<A> { id: string; attributes: A }
export interface AppInfoAttrs { state?: string | null }
export interface AppInfoLocalizationAttrs { locale: string; name?: string | null; subtitle?: string | null; privacyPolicyUrl?: string | null }
export interface VersionAttrs { appVersionState?: string | null; versionString?: string | null }
export interface VersionLocalizationAttrs { locale: string; description?: string | null; keywords?: string | null; promotionalText?: string | null; whatsNew?: string | null; marketingUrl?: string | null; supportUrl?: string | null }
export interface AscApi {
  listAppInfos(appId: string): Promise<AscResource<AppInfoAttrs>[]>;
  listAppInfoLocalizations(appInfoId: string): Promise<AscResource<AppInfoLocalizationAttrs>[]>;
  createAppInfoLocalization(appInfoId: string, attributes: { locale: string } & Record<string, string>): Promise<void>;
  updateAppInfoLocalization(id: string, attributes: Record<string, string>): Promise<void>;
  listVersions(appId: string, platform: AscPlatform): Promise<AscResource<VersionAttrs>[]>;
  listVersionLocalizations(versionId: string): Promise<AscResource<VersionLocalizationAttrs>[]>;
  createVersionLocalization(versionId: string, attributes: { locale: string } & Record<string, string>): Promise<void>;
  updateVersionLocalization(id: string, attributes: Record<string, string>): Promise<void>;
}
export function createAscApi(opts: { getToken: () => Promise<string>; fetchImpl?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }): AscApi;
```

Behaviour (follow `src/stores/google-play/client.ts` closely — same helpers `scrub`, `segment`, `retryAfterMs`, body read inside the network try):
- Every request: `authorization: Bearer <token>`, `accept: application/json`, `content-type: application/json` when there is a body, `redirect: "error"`, `AbortSignal.timeout(timeoutMs ?? 60_000)`.
- GET and PATCH: retried via `withRetry` on network/body-read errors, 429 (honour numeric `retry-after`) and 5xx; exhausted → `E_STORE` "App Store Connect API kept failing: …".
- POST (create): never retried; a network/body-read/429/5xx failure → `E_STORE` "App Store Connect create request status is unknown (<reason>)" with hint "Run `storelingo push --dry-run` to see whether the localization was created."
- Lists: `?limit=200` (versions also `filter[platform]=<platform>`, built with `URLSearchParams`); follow `links.next` while present, but only if it starts with `ASC_API_BASE + "/"` (otherwise stop — never send the token elsewhere).
- Path segments (`appId`, ids) validated: reject empty, `.`, `..` with `E_STORE` "invalid App Store Connect path segment: <JSON value>".
- Request bodies (exact shapes from spec §7.2):
  - create info loc: `{ data: { type: "appInfoLocalizations", attributes, relationships: { appInfo: { data: { type: "appInfos", id } } } } }`
  - update info loc: `{ data: { type: "appInfoLocalizations", id, attributes } }`
  - create version loc: `{ data: { type: "appStoreVersionLocalizations", attributes, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id } } } } }`
  - update version loc: `{ data: { type: "appStoreVersionLocalizations", id, attributes } }`
- Error mapping from `{ errors: [{ status, code, title, detail }] }` (first error; fall back to raw text; scrub the token; cap 500 chars):
  - 401 → `E_AUTH_ASC` "App Store Connect rejected the API key (401): <detail>", hint "Check STORELINGO_ASC_ISSUER_ID, STORELINGO_ASC_KEY_ID and the .p8 key; the key must not be revoked."
  - 403 → `E_AUTH_ASC` "App Store Connect denied access (403): <detail>", hint "Use a team key with the App Manager role (or Admin)."
  - 404 on `listAppInfos` / `listVersions` → `E_CONFIG` "App Store app <appId> not found or not accessible: <detail>", hint "Check stores.appstore.appId (the numeric Apple ID)."
  - 409 → `E_STORE` "App Store Connect refused the change (409): <title> — <detail>" (state conflicts).
  - other non-OK → `E_STORE` "App Store Connect API error <status>: <title> — <detail>".

Tests (`test/stores/app-store/client.test.ts`, fake fetch with `vi.fn().mockImplementation(async () => new Response(...))` so each call gets a fresh body):
1. `listAppInfos("123")` → GET `${ASC_API_BASE}/v1/apps/123/appInfos?limit=200`, bearer header, `redirect: "error"`, signal set; returns `[{ id, attributes }]` from `data`.
2. pagination: first page has `links.next` = `${ASC_API_BASE}/v1/apps/123/appInfos?cursor=abc&limit=200`, second page none → both pages' data returned; a `links.next` pointing to `https://evil.example/...` is NOT followed.
3. `listVersions("123", "IOS")` URL contains `filter%5Bplatform%5D=IOS` and `limit=200`.
4. `createAppInfoLocalization("info1", { locale: "ru", name: "Время" })` → POST `/v1/appInfoLocalizations` with the exact body shape; same for `createVersionLocalization`.
5. `updateVersionLocalization("loc1", { description: "D" })` → PATCH `/v1/appStoreVersionLocalizations/loc1` with `{ data: { type: "appStoreVersionLocalizations", id: "loc1", attributes: { description: "D" } } }`.
6. 401 → E_AUTH_ASC; 403 → E_AUTH_ASC; 404 on listAppInfos → E_CONFIG; 409 → E_STORE containing the detail; a 400 whose detail echoes the token → message contains "***", not the token.
7. GET 503 then 200 → succeeds (2 calls); 429 with `retry-after: 2` → sleep(2000).
8. POST 503 → E_STORE "status is unknown", fetch called once.
9. segment validation: `updateAppInfoLocalization("..", {})` rejects with E_STORE before any fetch.

Commit `feat: App Store Connect API client`.

---

### Task 3: StoreSession capabilities and the App Store store adapter

**Files:** Modify `src/stores/types.ts`; create `src/stores/app-store/store.ts`, `test/stores/app-store/store.test.ts`

**Interfaces:**
- `StoreSession` gains three OPTIONAL members (Google Play's adapter keeps working unchanged):
```ts
  /** False when updates apply immediately and one by one (no commit/rollback). Default: true. */
  readonly atomic?: boolean;
  /** Whether this session can write the field; undefined means every field is writable. */
  isWritable?(field: string): boolean;
  /** Human-readable facts about this session to show before the diff (e.g. "no editable version"). */
  readonly notes?: readonly string[];
```
- Produces `createAppStoreStore(api: AscApi, opts: { appId: string; platform: AscPlatform }): StoreClient` with `store: "appstore"`, plus exported `EDITABLE_VERSION_STATES`, `EDITABLE_INFO_STATES`, `LIVE_STATE = "READY_FOR_DISTRIBUTION"`.

Behaviour (spec §7.2 "Выбор ресурсов"):
```ts
const INFO_FIELDS = [["name", "name"], ["subtitle", "subtitle"], ["privacy_url", "privacyPolicyUrl"]] as const;
const VERSION_FIELDS = [
  ["description", "description"], ["keywords", "keywords"], ["promotional_text", "promotionalText"],
  ["release_notes", "whatsNew"], ["marketing_url", "marketingUrl"], ["support_url", "supportUrl"],
] as const;
```
`open()`:
1. `infos = api.listAppInfos(appId)`; `editableInfo` = first with state in `EDITABLE_INFO_STATES`; `liveInfo` = first with `READY_FOR_DISTRIBUTION`; `readInfo = editableInfo ?? liveInfo`.
2. `versions = api.listVersions(appId, platform)`; `editableVersion` / `liveVersion` likewise with `appVersionState`; `readVersion = editableVersion ?? liveVersion`.
3. Load localizations of `readInfo` and `readVersion` (skip when absent). Keep `locale → localization id` maps.
4. `notes`: when `!editableVersion`: "No editable App Store version: only promotional text can be updated. Create a new version in App Store Connect to change the rest." When `!editableInfo`: "No editable app info: name, subtitle and privacy URL can't be changed until a new version is being prepared."
5. `isWritable(field)`: info fields → `!!editableInfo`; `promotional_text` → `!!readVersion`; other version fields → `!!editableVersion`; unknown fields → false.
6. `listings()`: union by locale (info locales first, then version-only locales); values `normalizeText`-ed (src/util/text.ts); blank / null values dropped.
7. `update(listing)`: split the listing's fields into info attributes and version attributes, keeping only writable fields (unwritable keys are ignored — `push` never sends changes for them; merged unchanged values may still be present). Info attrs (if any): PATCH the existing localization id for the locale on `editableInfo`, else POST a new one on `editableInfo.id` with `{ locale, ...attrs }`. Version attrs (if any): target `readVersion` (that is `editableVersion` when it exists; otherwise only promotional text is writable and goes to the live version) — PATCH existing id or POST.
8. `commit()` and `abort()`: no-ops (App Store writes are immediate). `atomic: false`.

Tests (fake `AscApi` with `vi.fn` per method, recording calls):
1. Editable info + editable version present → `listings()` merges `name`/`subtitle` from the editable info and `description`/`keywords`/`promotional_text`/`release_notes` from the editable version (registry keys), CRLF normalized, null dropped; `notes` empty; every field writable.
2. Only live resources → reads from live; `isWritable("description")` false, `isWritable("promotional_text")` true, `isWritable("name")` false; two notes present.
3. `update({ locale: "en-US", fields: { name: "N", description: "D", promotional_text: "P" } })` with existing localizations → one PATCH on the info localization (`{ name: "N" }`) and one PATCH on the version localization (`{ description: "D", promotionalText: "P" }`).
4. New locale → POST info loc on `editableInfo.id` with `{ locale: "ru", name: … }` and POST version loc on `editableVersion.id`.
5. Live-only: `update` with `{ promotional_text: "P", description: "ignored" }` → a single PATCH on the live version localization with `{ promotionalText: "P" }`.
6. `atomic === false`; `commit()`/`abort()` resolve and call nothing.

Commit `feat: App Store store adapter with editable/live resource selection`.

---

### Task 4: `push` honours writability and non-atomic stores

**Files:** Modify `src/commands/push.ts`, `test/commands/push.test.ts`, `test/helpers/fake-store.ts`

**Interfaces:**
- `PushReport` gains `skipped: string[]` (lines like `"en-US/description: skipped (no editable version in App Store Connect)"`).
- `fakeStore(initial, opts)` gains options `store?: StoreId` (default "play"), `atomic?: boolean`, `writable?: (field: string) => boolean`, `notes?: string[]`, `failOnLocale?: string` (update throws `E_STORE` for that locale). Existing callers keep working.

Behaviour changes in `runPush` (after `computeDiff`, before printing):
1. Log every `session.notes` line (if any) first.
2. For each diff: changes whose field is not writable (`session.isWritable?.(field) === false`) move to `skipped` ("<locale>/<field>: skipped (no editable version in App Store Connect)" for appstore, "… skipped (the store can't take this field)" otherwise). A NEW-listing diff where any `REQUIRED_FOR_NEW` field is not writable becomes a problem "<locale>: a new listing needs an editable app info and version in App Store Connect" (→ blocked). Diffs left without changes are dropped.
3. If no diffs remain but `skipped` is non-empty → abort and throw `StorelingoError("E_NO_EDITABLE_VERSION", "Nothing can be pushed: every change needs an editable version in App Store Connect", "Create a new version in App Store Connect, then push again.")`.
4. The printed summary (and the `confirm(summary)` argument) = `formatDiff(diffs)` followed by the skipped lines.
5. Non-atomic sessions (`session.atomic === false`): track locales whose `update` completed; if an update throws after at least one succeeded, rethrow a `StorelingoError` with the original code (or `E_STORE` for non-StorelingoErrors), message `"<original message> — already applied: <locales>; not applied: <rest>"` and hint "Re-run `storelingo push`: it only sends what still differs." Atomic sessions keep today's behaviour (abort + rethrow unchanged).

Tests (add; keep all existing ones green):
1. Writable filter: fake appstore store with `writable: (f) => f === "promotional_text"`, local en-US changes `description` and `promotional_text` → only promotional_text is updated; `report.skipped` has the description line; the skipped line is in the confirm summary.
2. Only unwritable changes → rejects with `E_NO_EDITABLE_VERSION`; nothing updated; session aborted.
3. New locale with a required field unwritable → status blocked with the "editable app info and version" problem.
4. Notes are logged before the diff lines.
5. Non-atomic partial failure: two locales, `failOnLocale: "ru-RU"`... (use the store's codes for the configured store), first locale applied → error message contains "already applied: en-US" and "not applied: ru-RU", code `E_STORE`.
6. Atomic store with the same failure → original error unchanged (no "already applied").

Commit `feat: push skips unwritable fields and reports partial App Store progress`.

---

### Task 5: CLI — App Store store and multi-store pull/push

**Files:** Modify `src/cli/main.ts`, `test/cli/main.test.ts`

Behaviour:
- Replace `selectStore` with `selectStores(option, config): StoreId[]`, validated before any network call:
  - `--store play` → requires `stores.play` (else `E_CONFIG` "stores.play is not configured"); `--store appstore` → requires `stores.appstore` (else `E_CONFIG` "stores.appstore is not configured"); any other value → `E_USAGE` "--store must be play or appstore, got <JSON>".
  - no `--store` → every configured store in order `play`, `appstore`.
  - Remove the old "App Store pull/push … v0.3" message and info line.
- `pull` and `push` loop over the selected stores. Each store: `makeStore(store, config, env)` → run → print its own summary. `push` asks for confirmation per store with message `Upload these changes to <Store name>?`. The TTY/`--yes`/`--dry-run` decision stays before any network call (once).
- Exit code: 1 if any store's push was blocked; a thrown `StorelingoError` stops the loop and goes to the existing top-level handler.
- Pushed message: play → existing text; appstore → "Updated N App Store localization(s): <locales>. Changes to an editable version go live with that version; promotional text on the live version changes right away."
- Print `report.skipped` lines are already part of the summary; after a push with skipped lines also print "Some changes were skipped: create a new version in App Store Connect to push them."
- `defaultMakeStore` for `appstore`: `loadAscKey(env)` → `createAscTokenProvider({ key })` → `createAscApi({ getToken: () => tokens.getToken() })` → `createAppStoreStore(api, { appId, platform })`.
- Add `deps.env.STORELINGO_ASC_PRIVATE_KEY` to the masking `secrets` list.
- `--store` option help: "store to pull from / push to (play or appstore; default: all configured)".

Tests (update the existing pull/push block; the fake store helper takes `store`):
1. `--store appstore` with an appstore-only config pulls via `makeStore("appstore", …)` and writes `fastlane/metadata/<locale>/name.txt`.
2. No `--store` with both stores configured → `makeStore` called for "play" then "appstore"; push asks twice (deps.confirm called twice with the two messages).
3. `--store appstore` with a play-only config → exit 2 "stores.appstore is not configured", makeStore not called.
4. `--store foo` → exit 2, makeStore not called.
5. Masking: `STORELINGO_ASC_PRIVATE_KEY` value in a thrown error is masked.
6. A blocked App Store push exits 1 even if the Play push succeeded.
Replace the obsolete tests that expected "arrives in v0.3".

Commit `feat: App Store pull/push in the CLI and multi-store runs`.

---

### Task 6: Docs, version 0.3.0

**Files:** `README.md`, `README.ru.md`, `docs/app-store-setup.md`, `docs/app-store-setup.ru.md`, `CHANGELOG.md`, `package.json` (+ lock), `docs/superpowers/followups-2026-11-07-v0.2.md` (mark nothing; add a new `docs/superpowers/followups-2026-11-11-v0.3.md` only if the reviews leave items).

- Setup guide (EN + RU): create a team API key in App Store Connect (Users and Access → Integrations → App Store Connect API), role App Manager; download the `.p8` (only once!), note Key ID and Issuer ID; find the app's Apple ID (App Information); set the three env vars (bash and PowerShell examples; never commit the `.p8` — `init` already ignores `*.p8`); config `stores.appstore.appId` (+ optional `platform`); first run `pull --store appstore`, then `push --store appstore --dry-run`; how editable vs live works (what can change without a new version: only promotional text); troubleshooting table: E_AUTH_ASC (401/403), E_CONFIG (app not found), E_NO_EDITABLE_VERSION, E_STORE "status is unknown", 409 state conflicts. Don't invent exact UI labels beyond those named here; note that menu names change.
- README/README.ru: Commands (`--store play|appstore`, default all configured), App Store section (non-atomic, per-field routing, skipped lines, partial-progress message, re-run is safe), env table (+3 vars), exit codes, roadmap (v0.3 done → v1.0 GitHub Action). Absolute GitHub URLs for docs links. Every claim must match `src/`.
- CHANGELOG `## 0.3.0 — unreleased`; `package.json` version `0.3.0`.

Gate: `npm run build && node dist/bin.js --version` → 0.3.0; `npm pack --dry-run`; full gate; commit `docs: App Store setup guide and v0.3 docs`.
