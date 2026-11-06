# storelingo v0.2 (Google Play pull/push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `storelingo pull` and `storelingo push` for Google Play: download current listings into fastlane folders, show a diff against the live listing, and upload changes atomically through the Android Publisher API.

**Architecture:** A generic store layer (`src/stores/types.ts`, `diff.ts`, `local.ts`) plus a Google Play adapter split into auth (service-account JWT → token), a thin HTTP API client, and a `StoreClient` that wraps one Play "edit" per session. Commands `pull`/`push` depend only on the `StoreClient` interface, so they are tested with an in-memory fake; the Play adapter is tested with a fake `fetch`.

**Tech Stack:** existing (Node ≥ 22.13, TypeScript strict, commander, zod, vitest) + `jose` for RS256 JWT signing.

**Spec:** `docs/superpowers/specs/2026-11-06-storelingo-design.md` — §3 (pull/push), §7.1 (Google Play, incl. the verified API facts), §7.3 (safety invariants), §8 (errors incl. `E_IN_REVIEW`, `E_STORE`).

## Global Constraints

- Everything from the v0.1 plan's Global Constraints still holds (ESM + `.js` imports, strict TS, no `any` in `src/`, UTF-8/LF, code-point limits, never truncate, secrets only from env and never in logs/errors, exit codes 0/1/2, cwd-relative config/lock, symlink refusal via `assertSafePath`).
- Runtime deps: `commander`, `zod`, `@anthropic-ai/sdk`, `@inquirer/prompts`, **`jose`** (new). Nothing else.
- Google Play API base: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}`; token endpoint fixed to `https://oauth2.googleapis.com/token` (ignore `token_uri` in the key file); scope `https://www.googleapis.com/auth/androidpublisher`.
- Every Play commit uses `changesInReviewBehavior=ERROR_IF_IN_REVIEW`. storelingo never cancels changes already in review.
- All store HTTP requests: `redirect: "error"`, a timeout via `AbortSignal.timeout`, retries only for 429/5xx/network errors.
- `push` never runs network calls when it cannot ask for confirmation: outside a TTY it requires `--yes` (or `--dry-run`), checked before any request.
- `pull` never commits and never touches `storelingo.lock.json`.
- Write the BOM in source only as the ASCII escape `\uFEFF`; verify with `grep -c $'\xEF\xBB\xBF' <file>` → 0 (tooling has turned the escape into a literal before).
- Commit trailer: `Co-Authored-By: Claude <model> <noreply@anthropic.com>` naming the model that wrote the commit.

## File Map

```
src/errors.ts                          + E_IN_REVIEW, E_STORE
src/stores/types.ts                    StoreListing, StoreSession, StoreClient
src/stores/diff.ts                     computeDiff, formatDiff
src/stores/local.ts                    readLocalListings
src/stores/google-play/auth.ts         loadServiceAccount, createTokenProvider
src/stores/google-play/client.ts       createPlayApi (raw HTTP)
src/stores/google-play/store.ts        createPlayStore (StoreClient over one edit)
src/commands/pull.ts                   runPull
src/commands/push.ts                   runPush
src/cli/main.ts                        + pull, push commands; version from package.json
test/helpers/fake-store.ts             in-memory StoreClient
test/... one test file per new module
docs/google-play-setup.md, docs/google-play-setup.ru.md
```

---

### Task 1: Error codes, `jose`, Google service-account auth

**Files:**
- Modify: `src/errors.ts`, `package.json` (via npm install)
- Create: `src/stores/google-play/auth.ts`
- Test: `test/stores/google-play/auth.test.ts`

**Interfaces:**
- Consumes: `StorelingoError` (src/errors.ts), `makeTmpDir` (test/helpers/tmp.ts)
- Produces:
  - `ErrorCode` gains `"E_IN_REVIEW" | "E_STORE"` (both map to exit 1 through the existing `exitCodeFor`)
  - `PLAY_SCOPE`, `GOOGLE_TOKEN_URL` constants
  - `interface ServiceAccount { clientEmail: string; privateKey: string }`
  - `loadServiceAccount(env: NodeJS.ProcessEnv): Promise<ServiceAccount>`
  - `interface TokenProvider { getToken(): Promise<string> }`
  - `createTokenProvider(opts: { account: ServiceAccount; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number }): TokenProvider`

- [ ] **Step 1: Install jose and add the error codes**

Run: `npm install jose`

In `src/errors.ts` add two members to the `ErrorCode` union, after `"E_TRANSLATOR"`:
```ts
  | "E_IN_REVIEW"
  | "E_STORE";
```

- [ ] **Step 2: Write the failing test `test/stores/google-play/auth.test.ts`**

```ts
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_TOKEN_URL,
  PLAY_SCOPE,
  createTokenProvider,
  loadServiceAccount,
} from "../../../src/stores/google-play/auth.js";
import { makeTmpDir } from "../../helpers/tmp.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const EMAIL = "bot@proj.iam.gserviceaccount.com";
const keyJson = JSON.stringify({
  type: "service_account",
  client_email: EMAIL,
  private_key: privateKey,
  token_uri: "https://evil.example/token",
});
const tokenResponse = (token = "ya29.token", expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }), { status: 200 });

describe("loadServiceAccount", () => {
  it("reads inline JSON", async () => {
    expect(await loadServiceAccount({ STORELINGO_PLAY_SERVICE_ACCOUNT: keyJson })).toEqual({
      clientEmail: EMAIL,
      privateKey,
    });
  });

  it("reads a file path", async () => {
    const dir = await makeTmpDir();
    const file = join(dir, "key.json");
    await writeFile(file, keyJson);
    expect((await loadServiceAccount({ STORELINGO_PLAY_SERVICE_ACCOUNT: file })).clientEmail).toBe(EMAIL);
  });

  it("explains a missing variable", async () => {
    await expect(loadServiceAccount({})).rejects.toMatchObject({
      code: "E_CONFIG",
      message: "STORELINGO_PLAY_SERVICE_ACCOUNT is not set",
    });
  });

  it("rejects invalid content without echoing it", async () => {
    const err = await loadServiceAccount({
      STORELINGO_PLAY_SERVICE_ACCOUNT: '{"client_email":"x","private_key":"secret-material"}',
    }).catch((e) => e);
    expect(err.code).toBe("E_CONFIG");
    expect(err.message).not.toContain("secret-material");
  });

  it("explains an unreadable file", async () => {
    await expect(
      loadServiceAccount({ STORELINGO_PLAY_SERVICE_ACCOUNT: join(await makeTmpDir(), "missing.json") }),
    ).rejects.toMatchObject({ code: "E_CONFIG" });
  });
});

describe("createTokenProvider", () => {
  const account = { clientEmail: EMAIL, privateKey };

  it("signs a correct JWT and exchanges it at Google's fixed endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse());
    const now = 1_800_000_000_000;
    const provider = createTokenProvider({ account, fetchImpl, now: () => now });
    expect(await provider.getToken()).toBe("ya29.token");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const form = new URLSearchParams(init.body.toString());
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion")!;
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const { payload } = await jwtVerify(assertion, await importSPKI(publicKey, "RS256"), {
      issuer: EMAIL,
      audience: GOOGLE_TOKEN_URL,
      currentDate: new Date(now),
    });
    expect(payload.scope).toBe(PLAY_SCOPE);
    expect(payload.exp! - payload.iat!).toBe(3600);
  });

  it("caches the token until shortly before expiry", async () => {
    let now = 1_800_000_000_000;
    const fetchImpl = vi.fn().mockResolvedValueOnce(tokenResponse("t1")).mockResolvedValueOnce(tokenResponse("t2"));
    const provider = createTokenProvider({ account, fetchImpl, now: () => now });
    expect(await provider.getToken()).toBe("t1");
    now += 3_000_000; // 50 min after issue: still valid
    expect(await provider.getToken()).toBe("t1");
    now += 560_000; // 59 min 20 s after issue: inside the 60 s refresh margin
    expect(await provider.getToken()).toBe("t2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps a rejected key to E_AUTH_PLAY without leaking the assertion", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), {
          status: 400,
        }),
      );
    const err = await createTokenProvider({ account, fetchImpl }).getToken().catch((e) => e);
    expect(err.code).toBe("E_AUTH_PLAY");
    expect(err.message).toContain("invalid_grant: Invalid JWT Signature.");
    expect(err.message).not.toContain("eyJ");
  });

  it("rejects a malformed private key with E_CONFIG", async () => {
    const bad = { clientEmail: EMAIL, privateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" };
    await expect(createTokenProvider({ account: bad, fetchImpl: vi.fn() }).getToken()).rejects.toMatchObject({
      code: "E_CONFIG",
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/stores/google-play/auth.test.ts`
Expected: FAIL — cannot resolve `src/stores/google-play/auth.js`.

- [ ] **Step 4: Implement `src/stores/google-play/auth.ts`**

```ts
import { readFile } from "node:fs/promises";
import { SignJWT, importPKCS8 } from "jose";
import { z } from "zod";
import { StorelingoError } from "../../errors.js";

export const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
/** Fixed on purpose: a key file's own `token_uri` is never trusted. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENV = "STORELINGO_PLAY_SERVICE_ACCOUNT";
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 60_000;

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

const AccountSchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().includes("PRIVATE KEY"),
});

/** Reads the service account from STORELINGO_PLAY_SERVICE_ACCOUNT (a JSON key, or a path to one). */
export async function loadServiceAccount(env: NodeJS.ProcessEnv): Promise<ServiceAccount> {
  const value = env[ENV]?.trim();
  if (!value) {
    throw new StorelingoError(
      "E_CONFIG",
      `${ENV} is not set`,
      "Set it to the path of your Google Play service account JSON key (or to the JSON itself). See docs/google-play-setup.md.",
    );
  }
  let text = value;
  if (!value.startsWith("{")) {
    try {
      text = await readFile(value, "utf8");
    } catch {
      throw new StorelingoError(
        "E_CONFIG",
        `Cannot read the service account file named in ${ENV}`,
        "Check that the path exists and is readable.",
      );
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    raw = undefined;
  }
  const parsed = AccountSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StorelingoError(
      "E_CONFIG",
      `${ENV} does not contain a valid service account key`,
      "Download a JSON key for the service account in Google Cloud Console; it contains client_email and private_key.",
    );
  }
  return { clientEmail: parsed.data.client_email, privateKey: parsed.data.private_key };
}

export interface TokenProvider {
  getToken(): Promise<string>;
}

interface TokenBody {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export function createTokenProvider(opts: {
  account: ServiceAccount;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): TokenProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  let cached: { token: string; expiresAt: number } | undefined;

  return {
    async getToken() {
      if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;

      let key;
      try {
        key = await importPKCS8(opts.account.privateKey, "RS256");
      } catch {
        throw new StorelingoError("E_CONFIG", "The service account private_key is not a valid RSA key");
      }
      const iat = Math.floor(now() / 1000);
      const assertion = await new SignJWT({ scope: PLAY_SCOPE })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(opts.account.clientEmail)
        .setAudience(GOOGLE_TOKEN_URL)
        .setIssuedAt(iat)
        .setExpirationTime(iat + TOKEN_LIFETIME_S)
        .sign(key);

      let res: Response;
      try {
        res = await fetchImpl(GOOGLE_TOKEN_URL, {
          method: "POST",
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
          redirect: "error",
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch (err) {
        throw new StorelingoError(
          "E_AUTH_PLAY",
          `Could not reach Google's token endpoint: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const body = (await res.json().catch(() => ({}))) as TokenBody;
      if (!res.ok || !body.access_token) {
        const reason = [body.error, body.error_description].filter(Boolean).join(": ") || `HTTP ${res.status}`;
        throw new StorelingoError(
          "E_AUTH_PLAY",
          `Google rejected the service account (${reason})`,
          "Check the key file, that the service account is enabled, and that the Google Play Android Developer API is enabled for its Google Cloud project.",
        );
      }
      cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? TOKEN_LIFETIME_S) * 1000 };
      return cached.token;
    },
  };
}
```

- [ ] **Step 5: Run the test, then the gate**

Run: `npx vitest run test/stores/google-play/auth.test.ts` → PASS (9 tests). Then `npm test && npm run typecheck && npm run lint`.
Verify: `grep -c $'\xEF\xBB\xBF' src/stores/google-play/auth.ts` → 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/errors.ts src/stores/google-play/auth.ts test/stores/google-play/auth.test.ts
git commit -m "feat: add Google service-account auth for Play"
```

---

### Task 2: Google Play HTTP API client

**Files:**
- Create: `src/stores/google-play/client.ts`
- Test: `test/stores/google-play/client.test.ts`

**Interfaces:**
- Consumes: `StorelingoError` (incl. `E_IN_REVIEW`, `E_STORE` from Task 1), `withRetry`, `RetryableError` (src/util/retry.ts)
- Produces:
  - `PLAY_API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"`
  - `interface PlayListing { language: string; title?: string; shortDescription?: string; fullDescription?: string; video?: string }`
  - `interface PlayApi { insertEdit(): Promise<string>; listListings(editId: string): Promise<PlayListing[]>; updateListing(editId: string, listing: PlayListing): Promise<void>; validateEdit(editId: string): Promise<void>; commitEdit(editId: string): Promise<void>; deleteEdit(editId: string): Promise<void> }`
  - `createPlayApi(opts: { packageName: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }): PlayApi`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createPlayApi } from "../../../src/stores/google-play/client.js";

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app";
const json = (status: number, payload?: unknown) =>
  new Response(payload === undefined ? "" : JSON.stringify(payload), { status });
const api = (fetchImpl: typeof fetch) =>
  createPlayApi({ packageName: "com.example.app", getToken: async () => "tok-123", fetchImpl, sleep: async () => {} });

describe("createPlayApi", () => {
  it("creates an edit with auth, a timeout and no redirects", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(200, { id: "e1", expiryTimeSeconds: "1" }));
    expect(await api(fetchImpl).insertEdit()).toBe("e1");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/edits`);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer tok-123");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("lists listings, empty when Google returns none", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { kind: "androidpublisher#listingsListResponse", listings: [{ language: "en-US", title: "T" }] }))
      .mockResolvedValueOnce(json(200, { kind: "androidpublisher#listingsListResponse" }));
    const a = api(fetchImpl);
    expect(await a.listListings("e1")).toEqual([{ language: "en-US", title: "T" }]);
    expect(await a.listListings("e1")).toEqual([]);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/edits/e1/listings`);
  });

  it("PUTs the full listing to its language URL", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(200, {}));
    const listing = { language: "ru-RU", title: "Т", shortDescription: "к", fullDescription: "п" };
    await api(fetchImpl).updateListing("e1", listing);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/edits/e1/listings/ru-RU`);
    expect(init.method).toBe("PUT");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(listing);
  });

  it("validates, commits with ERROR_IF_IN_REVIEW and deletes, with empty bodies", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(200, { id: "e1" }));
    const a = api(fetchImpl);
    await a.validateEdit("e1");
    await a.commitEdit("e1");
    await a.deleteEdit("e1");
    const calls = fetchImpl.mock.calls as [string, RequestInit][];
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      `POST ${BASE}/edits/e1:validate`,
      `POST ${BASE}/edits/e1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
      `DELETE ${BASE}/edits/e1`,
    ]);
    expect(calls.every(([, i]) => i.body === undefined)).toBe(true);
  });

  it("retries a 5xx and then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { id: "e2" }));
    expect(await api(fetchImpl).insertEdit()).toBe("e2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps CHANGES_ALREADY_IN_REVIEW to E_IN_REVIEW without retrying", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(400, {
        error: {
          code: 400,
          status: "FAILED_PRECONDITION",
          message: "Changes are already in review.",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CHANGES_ALREADY_IN_REVIEW" }],
        },
      }),
    );
    await expect(api(fetchImpl).commitEdit("e1")).rejects.toMatchObject({ code: "E_IN_REVIEW" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps 403 to E_AUTH_PLAY and 404 to E_CONFIG, never including the token", async () => {
    const f403 = vi.fn().mockImplementation(async () =>
      json(403, { error: { code: 403, message: "The caller does not have permission" } }));
    const e403 = await api(f403).insertEdit().catch((e) => e);
    expect(e403.code).toBe("E_AUTH_PLAY");
    expect(e403.message).toContain("The caller does not have permission");
    expect(e403.message).not.toContain("tok-123");

    const f404 = vi.fn().mockImplementation(async () =>
      json(404, { error: { code: 404, message: "Package not found: com.example.app." } }));
    await expect(api(f404).insertEdit()).rejects.toMatchObject({ code: "E_CONFIG" });
  });

  it("maps other 4xx to E_STORE with Google's message", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(400, { error: { code: 400, message: "Title is too long." } }));
    await expect(api(fetchImpl).updateListing("e1", { language: "de-DE" })).rejects.toMatchObject({
      code: "E_STORE",
      message: "Google Play API error 400: Title is too long.",
    });
  });

  it("gives up after repeated network errors with E_STORE", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(api(fetchImpl).insertEdit()).rejects.toMatchObject({ code: "E_STORE" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("encodes path segments", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(200, {}));
    await api(fetchImpl).updateListing("e/1", { language: "../x" });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/edits/e%2F1/listings/..%2Fx`);
  });
});
```

Note: tests that make several calls use `vi.fn().mockImplementation(async () => json(...))`
so each call gets a fresh `Response` (a body can be read only once).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/stores/google-play/client.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/stores/google-play/client.ts`**

```ts
import { StorelingoError } from "../../errors.js";
import { RetryableError, withRetry } from "../../util/retry.js";

export const PLAY_API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

export interface PlayListing {
  language: string;
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
  video?: string;
}

export interface PlayApi {
  insertEdit(): Promise<string>;
  listListings(editId: string): Promise<PlayListing[]>;
  updateListing(editId: string, listing: PlayListing): Promise<void>;
  validateEdit(editId: string): Promise<void>;
  commitEdit(editId: string): Promise<void>;
  deleteEdit(editId: string): Promise<void>;
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: { reason?: string }[] };
}

function toError(status: number, text: string, packageName: string): StorelingoError {
  let parsed: GoogleErrorBody = {};
  try {
    parsed = JSON.parse(text) as GoogleErrorBody;
  } catch {
    // not JSON: fall back to the raw text
  }
  const message = (parsed.error?.message ?? text).slice(0, 500);
  if (parsed.error?.details?.some((d) => d.reason === "CHANGES_ALREADY_IN_REVIEW")) {
    return new StorelingoError(
      "E_IN_REVIEW",
      "Google Play already has changes in review for this app; nothing was changed",
      "Wait for the review to finish, or send or discard those changes in Play Console, then push again.",
    );
  }
  if (status === 401 || status === 403) {
    return new StorelingoError(
      "E_AUTH_PLAY",
      `Google Play denied access (${status}): ${message}`,
      "In Play Console → Users and permissions, give the service account access to this app with permission to edit the store listing.",
    );
  }
  if (status === 404) {
    return new StorelingoError(
      "E_CONFIG",
      `Google Play app ${packageName} not found or not accessible: ${message}`,
      "Check stores.play.packageName and that the service account has access to this app.",
    );
  }
  return new StorelingoError("E_STORE", `Google Play API error ${status}: ${message}`);
}

export function createPlayApi(opts: {
  packageName: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): PlayApi {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const app = `${PLAY_API_BASE}/${encodeURIComponent(opts.packageName)}`;
  const edit = (id: string) => `${app}/edits/${encodeURIComponent(id)}`;

  async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    return withRetry(
      async () => {
        const token = await opts.getToken();
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        if (body !== undefined) headers["content-type"] = "application/json";
        let res: Response;
        try {
          res = await fetchImpl(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
          });
        } catch (err) {
          throw new RetryableError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
        const text = await res.text();
        if (!res.ok) throw toError(res.status, text, opts.packageName);
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new StorelingoError("E_STORE", `Google Play returned a non-JSON response (${res.status})`);
        }
      },
      { sleep: opts.sleep },
    ).catch((err: unknown) => {
      if (err instanceof RetryableError) {
        throw new StorelingoError("E_STORE", `Google Play API kept failing: ${err.message}`);
      }
      throw err;
    });
  }

  return {
    async insertEdit() {
      const res = await request<{ id?: string }>("POST", `${app}/edits`, {});
      if (!res.id) throw new StorelingoError("E_STORE", "Google Play did not return an edit id");
      return res.id;
    },
    async listListings(editId) {
      const res = await request<{ listings?: PlayListing[] }>("GET", `${edit(editId)}/listings`);
      return res.listings ?? [];
    },
    async updateListing(editId, listing) {
      await request("PUT", `${edit(editId)}/listings/${encodeURIComponent(listing.language)}`, listing);
    },
    async validateEdit(editId) {
      await request("POST", `${edit(editId)}:validate`);
    },
    async commitEdit(editId) {
      await request("POST", `${edit(editId)}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`);
    },
    async deleteEdit(editId) {
      await request("DELETE", edit(editId));
    },
  };
}
```

- [ ] **Step 4: Run the test, then the gate**

Run: `npx vitest run test/stores/google-play/client.test.ts` → PASS (10 tests). Then `npm test && npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/stores/google-play/client.ts test/stores/google-play/client.test.ts
git commit -m "feat: add Google Play edits API client"
```

---

### Task 3: Store interface and the Play store adapter

**Files:**
- Create: `src/stores/types.ts`, `src/stores/google-play/store.ts`
- Test: `test/stores/google-play/store.test.ts`

**Interfaces:**
- Consumes: `StoreId` (src/fields/registry.ts), `PlayApi`, `PlayListing` (Task 2)
- Produces (`types.ts`):
  - `interface StoreListing { locale: string; fields: Record<string, string> }` — `locale` is the store's own code; `fields` keyed by field-registry keys (`title`, `short_description`, …)
  - `interface StoreSession { listings(): Promise<StoreListing[]>; update(listing: StoreListing): Promise<void>; commit(): Promise<void>; abort(): Promise<void> }` — `abort` never throws and is a no-op after `commit` or a previous `abort`
  - `interface StoreClient { readonly store: StoreId; open(): Promise<StoreSession> }`
- Produces (`store.ts`): `createPlayStore(api: PlayApi): StoreClient`

- [ ] **Step 1: Write `src/stores/types.ts`**

```ts
import type { StoreId } from "../fields/registry.js";

/** One locale's listing. `locale` is the store's own code; `fields` are keyed by field-registry keys. */
export interface StoreListing {
  locale: string;
  fields: Record<string, string>;
}

/** One unit of work against a store (for Google Play: one edit). */
export interface StoreSession {
  listings(): Promise<StoreListing[]>;
  /** Replaces the listing for `listing.locale` with exactly these fields. */
  update(listing: StoreListing): Promise<void>;
  /** Validates and publishes every update made in this session. */
  commit(): Promise<void>;
  /** Discards the session. Never throws; a no-op after commit() or a previous abort(). */
  abort(): Promise<void>;
}

export interface StoreClient {
  readonly store: StoreId;
  open(): Promise<StoreSession>;
}
```

- [ ] **Step 2: Write the failing test `test/stores/google-play/store.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import type { PlayApi, PlayListing } from "../../../src/stores/google-play/client.js";
import { createPlayStore } from "../../../src/stores/google-play/store.js";

function fakeApi(listings: PlayListing[] = [], opts: { deleteFails?: boolean } = {}) {
  const calls: string[] = [];
  const api: PlayApi = {
    insertEdit: vi.fn(async () => {
      calls.push("insert");
      return "e1";
    }),
    listListings: vi.fn(async (id: string) => {
      calls.push(`list ${id}`);
      return listings;
    }),
    updateListing: vi.fn(async (id: string, l: PlayListing) => {
      calls.push(`update ${id} ${l.language}`);
    }),
    validateEdit: vi.fn(async (id: string) => {
      calls.push(`validate ${id}`);
    }),
    commitEdit: vi.fn(async (id: string) => {
      calls.push(`commit ${id}`);
    }),
    deleteEdit: vi.fn(async (id: string) => {
      calls.push(`delete ${id}`);
      if (opts.deleteFails) throw new Error("network down");
    }),
  };
  return { api, calls };
}

describe("createPlayStore", () => {
  it("is a play store", () => {
    expect(createPlayStore(fakeApi().api).store).toBe("play");
  });

  it("maps Play listings to registry keys and drops empty values", async () => {
    const { api } = fakeApi([
      { language: "en-US", title: "T", shortDescription: "S", fullDescription: "F", video: "" },
      { language: "de-DE", title: "Gebet" },
    ]);
    const session = await createPlayStore(api).open();
    expect(await session.listings()).toEqual([
      { locale: "en-US", fields: { title: "T", short_description: "S", full_description: "F" } },
      { locale: "de-DE", fields: { title: "Gebet" } },
    ]);
  });

  it("sends updates with Play field names", async () => {
    const { api } = fakeApi();
    const session = await createPlayStore(api).open();
    await session.update({ locale: "ru-RU", fields: { title: "Т", full_description: "П", video: "https://youtu.be/x" } });
    expect(api.updateListing).toHaveBeenCalledWith("e1", {
      language: "ru-RU",
      title: "Т",
      fullDescription: "П",
      video: "https://youtu.be/x",
    });
  });

  it("commit validates then commits; a later abort does nothing", async () => {
    const { api, calls } = fakeApi();
    const session = await createPlayStore(api).open();
    await session.commit();
    await session.abort();
    expect(calls).toEqual(["insert", "validate e1", "commit e1"]);
  });

  it("abort deletes the edit once and never throws", async () => {
    const { api, calls } = fakeApi([], { deleteFails: true });
    const session = await createPlayStore(api).open();
    await expect(session.abort()).resolves.toBeUndefined();
    await session.abort();
    expect(calls).toEqual(["insert", "delete e1"]);
  });

  it("a failed commit leaves the session abortable", async () => {
    const { api, calls } = fakeApi();
    vi.mocked(api.commitEdit).mockRejectedValueOnce(new Error("in review"));
    const session = await createPlayStore(api).open();
    await expect(session.commit()).rejects.toThrow("in review");
    await session.abort();
    expect(calls).toEqual(["insert", "validate e1", "delete e1"]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/stores/google-play/store.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `src/stores/google-play/store.ts`**

```ts
import type { StoreClient, StoreListing, StoreSession } from "../types.js";
import type { PlayApi, PlayListing } from "./client.js";

type PlayTextField = "title" | "shortDescription" | "fullDescription" | "video";

/** Field-registry key → Google Play Listing field. */
const FIELD_MAP: readonly (readonly [string, PlayTextField])[] = [
  ["title", "title"],
  ["short_description", "shortDescription"],
  ["full_description", "fullDescription"],
  ["video", "video"],
];

function fromPlay(listing: PlayListing): StoreListing {
  const fields: Record<string, string> = {};
  for (const [key, playKey] of FIELD_MAP) {
    const value = listing[playKey];
    if (typeof value === "string" && value.trim() !== "") fields[key] = value;
  }
  return { locale: listing.language, fields };
}

function toPlay(listing: StoreListing): PlayListing {
  const out: PlayListing = { language: listing.locale };
  for (const [key, playKey] of FIELD_MAP) {
    const value = listing.fields[key];
    if (value !== undefined) out[playKey] = value;
  }
  return out;
}

export function createPlayStore(api: PlayApi): StoreClient {
  return {
    store: "play",
    async open(): Promise<StoreSession> {
      const editId = await api.insertEdit();
      let closed = false;
      return {
        async listings() {
          return (await api.listListings(editId)).map(fromPlay);
        },
        async update(listing) {
          await api.updateListing(editId, toPlay(listing));
        },
        async commit() {
          await api.validateEdit(editId);
          await api.commitEdit(editId);
          closed = true;
        },
        async abort() {
          if (closed) return;
          closed = true;
          try {
            await api.deleteEdit(editId);
          } catch {
            // Best effort: an unused edit also expires on Google's side.
          }
        },
      };
    },
  };
}
```

- [ ] **Step 5: Run the test, then the gate**

Run: `npx vitest run test/stores/google-play/store.test.ts` → PASS (6 tests). Then the full gate.

- [ ] **Step 6: Commit**

```bash
git add src/stores/types.ts src/stores/google-play/store.ts test/stores/google-play/store.test.ts
git commit -m "feat: add store interface and Google Play store adapter"
```

---

### Task 4: Listing diff

**Files:**
- Create: `src/stores/diff.ts`
- Test: `test/stores/diff.test.ts`

**Interfaces:**
- Consumes: `StoreListing` (Task 3)
- Produces:
  - `interface FieldChange { field: string; from: string | undefined; to: string }`
  - `interface ListingDiff { locale: string; isNew: boolean; changes: FieldChange[]; merged: StoreListing }`
  - `interface DiffProblem { locale: string; message: string }`
  - `computeDiff(local: StoreListing[], remote: StoreListing[], requiredForNew: readonly string[]): { diffs: ListingDiff[]; problems: DiffProblem[] }`
  - `formatDiff(diffs: ListingDiff[]): string[]`

Rules (spec §7.1): compare ignoring trailing newlines; only fields present locally can change; `merged` = remote fields overlaid with changed local fields (so a full PUT never clears an untouched field); a locale missing remotely is new and needs every `requiredForNew` field locally, otherwise it becomes a problem and is not diffed; remote-only locales are ignored.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { computeDiff, formatDiff } from "../../src/stores/diff.js";

const REQUIRED = ["title", "short_description", "full_description"];
const remote = [
  { locale: "en-US", fields: { title: "Prayer Times", short_description: "Accurate", full_description: "Long", video: "v" } },
  { locale: "fr-FR", fields: { title: "Heures" } },
];

describe("computeDiff", () => {
  it("finds nothing when values match ignoring trailing newlines", () => {
    const local = [{ locale: "en-US", fields: { title: "Prayer Times\n\n", short_description: "Accurate" } }];
    expect(computeDiff(local, remote, REQUIRED)).toEqual({ diffs: [], problems: [] });
  });

  it("reports changed fields and merges them over the remote listing", () => {
    const local = [{ locale: "en-US", fields: { title: "Prayer Times Pro\n" } }];
    expect(computeDiff(local, remote, REQUIRED)).toEqual({
      problems: [],
      diffs: [
        {
          locale: "en-US",
          isNew: false,
          changes: [{ field: "title", from: "Prayer Times", to: "Prayer Times Pro" }],
          merged: {
            locale: "en-US",
            fields: { title: "Prayer Times Pro", short_description: "Accurate", full_description: "Long", video: "v" },
          },
        },
      ],
    });
  });

  it("creates a new listing when every required field is present", () => {
    const local = [{ locale: "ru-RU", fields: { title: "Т", short_description: "К", full_description: "П" } }];
    const { diffs, problems } = computeDiff(local, remote, REQUIRED);
    expect(problems).toEqual([]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.isNew).toBe(true);
    expect(diffs[0]!.changes.map((c) => [c.field, c.from])).toEqual([
      ["title", undefined],
      ["short_description", undefined],
      ["full_description", undefined],
    ]);
  });

  it("refuses a new listing that lacks required fields", () => {
    const local = [{ locale: "ru-RU", fields: { title: "Т" } }];
    expect(computeDiff(local, remote, REQUIRED)).toEqual({
      diffs: [],
      problems: [{ locale: "ru-RU", message: "a new listing needs short_description, full_description" }],
    });
  });

  it("ignores remote-only locales", () => {
    expect(computeDiff([], remote, REQUIRED)).toEqual({ diffs: [], problems: [] });
  });
});

describe("formatDiff", () => {
  it("prints one line per change with short previews", () => {
    const long = "x".repeat(80);
    const lines = formatDiff([
      {
        locale: "en-US",
        isNew: false,
        changes: [{ field: "title", from: "Prayer Times", to: "Prayer Times Pro" }],
        merged: { locale: "en-US", fields: {} },
      },
      {
        locale: "ru-RU",
        isNew: true,
        changes: [{ field: "full_description", from: undefined, to: long }],
        merged: { locale: "ru-RU", fields: {} },
      },
    ]);
    expect(lines).toEqual([
      "en-US:",
      '  title: "Prayer Times" → "Prayer Times Pro"',
      "ru-RU (new listing):",
      `  full_description: (empty) → "${"x".repeat(57)}..."`,
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/stores/diff.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/stores/diff.ts`**

```ts
import type { StoreListing } from "./types.js";

export interface FieldChange {
  field: string;
  from: string | undefined;
  to: string;
}

export interface ListingDiff {
  locale: string;
  isNew: boolean;
  changes: FieldChange[];
  /** The complete listing to send: remote fields overlaid with the changed local ones. */
  merged: StoreListing;
}

export interface DiffProblem {
  locale: string;
  message: string;
}

const trimTrailingNewlines = (s: string) => s.replace(/\n+$/, "");

export function computeDiff(
  local: StoreListing[],
  remote: StoreListing[],
  requiredForNew: readonly string[],
): { diffs: ListingDiff[]; problems: DiffProblem[] } {
  const remoteByLocale = new Map(remote.map((r) => [r.locale, r]));
  const diffs: ListingDiff[] = [];
  const problems: DiffProblem[] = [];

  for (const listing of local) {
    const current = remoteByLocale.get(listing.locale);
    const isNew = current === undefined;
    if (isNew) {
      const missing = requiredForNew.filter((key) => !listing.fields[key]?.trim());
      if (missing.length > 0) {
        problems.push({ locale: listing.locale, message: `a new listing needs ${missing.join(", ")}` });
        continue;
      }
    }
    const merged: StoreListing = { locale: listing.locale, fields: { ...(current?.fields ?? {}) } };
    const changes: FieldChange[] = [];
    for (const [field, value] of Object.entries(listing.fields)) {
      const to = trimTrailingNewlines(value);
      const from = current?.fields[field];
      if (from !== undefined && trimTrailingNewlines(from) === to) continue;
      merged.fields[field] = to;
      changes.push({ field, from, to });
    }
    if (changes.length > 0) diffs.push({ locale: listing.locale, isNew, changes, merged });
  }
  return { diffs, problems };
}

const PREVIEW_CHARS = 60;

function preview(value: string | undefined): string {
  if (value === undefined) return "(empty)";
  const chars = [...value];
  const shown = chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS - 3).join("")}...` : value;
  return JSON.stringify(shown);
}

export function formatDiff(diffs: ListingDiff[]): string[] {
  const lines: string[] = [];
  for (const diff of diffs) {
    lines.push(`${diff.locale}${diff.isNew ? " (new listing)" : ""}:`);
    for (const change of diff.changes) {
      lines.push(`  ${change.field}: ${preview(change.from)} → ${preview(change.to)}`);
    }
  }
  return lines;
}
```

- [ ] **Step 4: Run the test, then the gate; commit**

Run: `npx vitest run test/stores/diff.test.ts` → PASS (6 tests); full gate.

```bash
git add src/stores/diff.ts test/stores/diff.test.ts
git commit -m "feat: add listing diff for push"
```

---

### Task 5: Read local listings

**Files:**
- Create: `src/stores/local.ts`
- Test: `test/stores/local.test.ts`

**Interfaces:**
- Consumes: `Config` (src/config/schema.ts), `fieldsFor`, `StoreId` (src/fields/registry.ts), `toStoreLocale` (src/locales/table.ts), `storeRoot`, `readField` (src/metadata/fastlane.ts), `StoreListing` (Task 3), test helper `makeProject` (test/helpers/project.ts)
- Produces: `readLocalListings(config: Config, cwd: string, store: StoreId): Promise<StoreListing[]>`

Rules: locales = source + targets mapped to the store's codes (unsupported ones skipped); fields = the store's fields of kind `text`, `keywords`, `url` (never `changelog`); a field is included only if its file exists and is non-blank, with trailing newlines removed; a locale with no such files is omitted.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { readLocalListings } from "../../src/stores/local.js";
import { makeProject } from "../helpers/project.js";

const P = "fastlane/metadata/android";
const A = "fastlane/metadata";
const playConfig = {
  sourceLocale: "en-US",
  targetLocales: ["ru", "ky"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic" },
};

describe("readLocalListings", () => {
  it("reads non-empty play fields for source and target locales", async () => {
    const { cwd, config } = await makeProject(
      {
        [`${P}/en-US/title.txt`]: "Prayer Times\n",
        [`${P}/en-US/short_description.txt`]: "Accurate",
        [`${P}/en-US/full_description.txt`]: "   \n",
        [`${P}/en-US/video.txt`]: "https://youtu.be/x",
        [`${P}/en-US/changelogs/5.txt`]: "Bug fixes",
        [`${P}/ru-RU/title.txt`]: "Время намаза",
        [`${P}/de-DE/title.txt`]: "not a configured target",
      },
      playConfig,
    );
    expect(await readLocalListings(config, cwd, "play")).toEqual([
      {
        locale: "en-US",
        fields: { title: "Prayer Times", short_description: "Accurate", video: "https://youtu.be/x" },
      },
      { locale: "ru-RU", fields: { title: "Время намаза" } },
    ]);
  });

  it("uses App Store codes and includes keywords", async () => {
    const { cwd, config } = await makeProject(
      {
        [`${A}/en-US/name.txt`]: "Prayer Times",
        [`${A}/en-US/keywords.txt`]: "quran,qibla",
        [`${A}/ru/name.txt`]: "Время намаза",
      },
      { ...playConfig, stores: { appstore: { appId: "1" } } },
    );
    expect(await readLocalListings(config, cwd, "appstore")).toEqual([
      { locale: "en-US", fields: { name: "Prayer Times", keywords: "quran,qibla" } },
      { locale: "ru", fields: { name: "Время намаза" } },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run test/stores/local.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/stores/local.ts`**

```ts
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
```

- [ ] **Step 4: Run the test, then the gate; commit**

Run: `npx vitest run test/stores/local.test.ts` → PASS (2 tests); full gate.

```bash
git add src/stores/local.ts test/stores/local.test.ts
git commit -m "feat: read local listings from fastlane folders"
```

---

### Task 6: `pull` command logic

**Files:**
- Create: `src/commands/pull.ts`, `test/helpers/fake-store.ts`
- Test: `test/commands/pull.test.ts`

**Interfaces:**
- Consumes: `Config`, `getField` (registry), `fromStoreLocale` (locales), `storeRoot`, `readField`, `writeField` (metadata), `StoreClient`, `StoreListing` (Task 3), `Logger` (src/log.ts), `createLogger`, `makeProject`
- Produces:
  - `interface PullReport { written: number; unchanged: number; skipped: string[]; unknownLocales: string[] }`
  - `runPull(opts: { config: Config; cwd: string; client: StoreClient; log: Logger; force?: boolean }): Promise<PullReport>`
  - test helper `fakeStore(initial: StoreListing[], opts?: { failOn?: "update" | "commit" }): { client: StoreClient; state: FakeStoreState }` with `FakeStoreState { remote: StoreListing[]; opened: number; aborted: number; committed: number; updates: StoreListing[] }`

Rules (spec §7.1): open a session, read listings, always `abort()` (pull never commits); skip and warn on language codes that are not `^[A-Za-z0-9-]{2,20}$` (never used as folder names); a code missing from storelingo's table is still written, and listed in `unknownLocales` with one warning; per field: equal to the existing file (ignoring trailing newlines) → `unchanged`; no file or blank file → write; a different non-blank file → write only with `force`, otherwise add `"<locale>/<file>"` to `skipped`; never touches the lock file.

- [ ] **Step 1: Write `test/helpers/fake-store.ts`**

```ts
import { StorelingoError } from "../../src/errors.js";
import type { StoreClient, StoreListing } from "../../src/stores/types.js";

export interface FakeStoreState {
  remote: StoreListing[];
  opened: number;
  aborted: number;
  committed: number;
  updates: StoreListing[];
}

/** In-memory Google Play-like store: updates become visible only after commit(). */
export function fakeStore(
  initial: StoreListing[],
  opts: { failOn?: "update" | "commit" } = {},
): { client: StoreClient; state: FakeStoreState } {
  const state: FakeStoreState = { remote: structuredClone(initial), opened: 0, aborted: 0, committed: 0, updates: [] };
  const client: StoreClient = {
    store: "play",
    async open() {
      state.opened++;
      const pending: StoreListing[] = [];
      let closed = false;
      return {
        async listings() {
          return structuredClone(state.remote);
        },
        async update(listing) {
          if (opts.failOn === "update") throw new StorelingoError("E_STORE", "Google Play API error 400: boom");
          pending.push(structuredClone(listing));
          state.updates.push(structuredClone(listing));
        },
        async commit() {
          if (opts.failOn === "commit") throw new StorelingoError("E_IN_REVIEW", "changes already in review");
          for (const listing of pending) {
            const i = state.remote.findIndex((r) => r.locale === listing.locale);
            if (i >= 0) state.remote[i] = listing;
            else state.remote.push(listing);
          }
          state.committed++;
          closed = true;
        },
        async abort() {
          if (closed) return;
          closed = true;
          state.aborted++;
        },
      };
    },
  };
  return { client, state };
}
```

- [ ] **Step 2: Write the failing test `test/commands/pull.test.ts`**

```ts
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPull } from "../../src/commands/pull.js";
import { createLogger } from "../../src/log.js";
import { fakeStore } from "../helpers/fake-store.js";
import { makeProject } from "../helpers/project.js";

const P = "fastlane/metadata/android";
const config = {
  sourceLocale: "en-US",
  targetLocales: ["ru"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic" },
};
const remote = [
  { locale: "en-US", fields: { title: "Prayer Times", short_description: "Accurate", full_description: "Long" } },
  { locale: "bg", fields: { title: "Молитва" } },
];

function capture() {
  const warnings: string[] = [];
  const log = createLogger({ verbose: false, secrets: [], out: () => {}, err: (l) => warnings.push(l) });
  return { log, warnings };
}

describe("runPull", () => {
  it("writes every field of every listing, including languages outside the table", async () => {
    const { cwd, config: cfg } = await makeProject({}, config);
    const { client, state } = fakeStore(remote);
    const { log, warnings } = capture();
    const report = await runPull({ config: cfg, cwd, client, log });

    expect(report).toEqual({ written: 4, unchanged: 0, skipped: [], unknownLocales: ["bg"] });
    expect(await readFile(join(cwd, P, "en-US", "title.txt"), "utf8")).toBe("Prayer Times");
    expect(await readFile(join(cwd, P, "bg", "title.txt"), "utf8")).toBe("Молитва");
    expect(warnings.join("\n")).toContain("bg");
    expect(state).toMatchObject({ opened: 1, aborted: 1, committed: 0 });
  });

  it("counts identical files as unchanged, ignoring trailing newlines", async () => {
    const { cwd, config: cfg } = await makeProject({ [`${P}/en-US/title.txt`]: "Prayer Times\n" }, config);
    const report = await runPull({ config: cfg, cwd, client: fakeStore(remote).client, log: capture().log });
    expect(report.unchanged).toBe(1);
    expect(report.written).toBe(3);
  });

  it("keeps a different local file unless --force", async () => {
    const files = { [`${P}/en-US/title.txt`]: "My local title" };
    const first = await makeProject(files, config);
    const kept = await runPull({ config: first.config, cwd: first.cwd, client: fakeStore(remote).client, log: capture().log });
    expect(kept.skipped).toEqual(["en-US/title.txt"]);
    expect(await readFile(join(first.cwd, P, "en-US", "title.txt"), "utf8")).toBe("My local title");

    const forced = await runPull({
      config: first.config,
      cwd: first.cwd,
      client: fakeStore(remote).client,
      log: capture().log,
      force: true,
    });
    expect(forced.skipped).toEqual([]);
    expect(await readFile(join(first.cwd, P, "en-US", "title.txt"), "utf8")).toBe("Prayer Times");
  });

  it("overwrites a blank local file without --force", async () => {
    const { cwd, config: cfg } = await makeProject({ [`${P}/en-US/title.txt`]: "  \n" }, config);
    const report = await runPull({ config: cfg, cwd, client: fakeStore(remote).client, log: capture().log });
    expect(report.skipped).toEqual([]);
    expect(await readFile(join(cwd, P, "en-US", "title.txt"), "utf8")).toBe("Prayer Times");
  });

  it("skips unsafe language codes", async () => {
    const { cwd, config: cfg } = await makeProject({}, config);
    const { log, warnings } = capture();
    const report = await runPull({
      config: cfg,
      cwd,
      client: fakeStore([{ locale: "../evil", fields: { title: "x" } }]).client,
      log,
    });
    expect(report.written).toBe(0);
    expect(warnings.join("\n")).toContain("../evil");
    await expect(access(join(cwd, "fastlane", "metadata", "evil"))).rejects.toThrow();
  });

  it("never touches the lock file", async () => {
    const { cwd, config: cfg } = await makeProject({}, config);
    await runPull({ config: cfg, cwd, client: fakeStore(remote).client, log: capture().log });
    await expect(access(join(cwd, "storelingo.lock.json"))).rejects.toThrow();
  });

  it("aborts the session even when reading listings fails", async () => {
    const { cwd, config: cfg } = await makeProject({}, config);
    const { client, state } = fakeStore(remote);
    const failing = {
      store: client.store,
      async open() {
        const session = await client.open();
        return { ...session, listings: async () => Promise.reject(new Error("boom")) };
      },
    };
    await expect(runPull({ config: cfg, cwd, client: failing, log: capture().log })).rejects.toThrow("boom");
    expect(state.aborted).toBe(1);
  });
});
```

The unused `writeFile` import must not be added; keep imports to what the file uses (lint).

- [ ] **Step 3: Run it to verify it fails** — `npx vitest run test/commands/pull.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/commands/pull.ts`**

```ts
import type { Config } from "../config/schema.js";
import { getField } from "../fields/registry.js";
import { fromStoreLocale } from "../locales/table.js";
import type { Logger } from "../log.js";
import { readField, storeRoot, writeField } from "../metadata/fastlane.js";
import type { StoreClient, StoreListing } from "../stores/types.js";
import { STORE_NAMES } from "./check.js";

export interface PullReport {
  written: number;
  unchanged: number;
  /** "<locale>/<file>" kept because the local file differs (use --force to overwrite). */
  skipped: string[];
  /** Store codes that are not in storelingo's language table. */
  unknownLocales: string[];
}

const SAFE_LOCALE = /^[A-Za-z0-9-]{2,20}$/;
const trimTrailingNewlines = (s: string) => s.replace(/\n+$/, "");

export async function runPull(opts: {
  config: Config;
  cwd: string;
  client: StoreClient;
  log: Logger;
  force?: boolean;
}): Promise<PullReport> {
  const { config, cwd, client, log } = opts;
  const root = storeRoot(config, cwd, client.store);
  const report: PullReport = { written: 0, unchanged: 0, skipped: [], unknownLocales: [] };

  const session = await client.open();
  let listings: StoreListing[];
  try {
    listings = await session.listings();
  } finally {
    await session.abort(); // pull never changes the store
  }

  for (const listing of listings) {
    if (!SAFE_LOCALE.test(listing.locale)) {
      log.warn(`skipped a listing with an unexpected language code ${JSON.stringify(listing.locale)}`);
      continue;
    }
    if (!fromStoreLocale(client.store, listing.locale)) report.unknownLocales.push(listing.locale);
    for (const [key, value] of Object.entries(listing.fields)) {
      const field = getField(client.store, key);
      const existing = await readField(root, listing.locale, field.file);
      if (existing !== undefined && trimTrailingNewlines(existing) === trimTrailingNewlines(value)) {
        report.unchanged++;
        continue;
      }
      if (existing !== undefined && existing.trim() !== "" && !opts.force) {
        report.skipped.push(`${listing.locale}/${field.file}`);
        continue;
      }
      await writeField(root, listing.locale, field.file, value);
      report.written++;
    }
  }

  if (report.unknownLocales.length > 0) {
    log.warn(
      `${STORE_NAMES[client.store]} languages not in storelingo's table (pulled, but cannot be translation targets): ${report.unknownLocales.join(", ")}`,
    );
  }
  return report;
}
```

- [ ] **Step 5: Run the test, then the gate; commit**

Run: `npx vitest run test/commands/pull.test.ts` → PASS (7 tests); full gate.

```bash
git add src/commands/pull.ts test/commands/pull.test.ts test/helpers/fake-store.ts
git commit -m "feat: add pull command logic"
```

---

### Task 7: `push` command logic

**Files:**
- Create: `src/commands/push.ts`
- Test: `test/commands/push.test.ts`

**Interfaces:**
- Consumes: `runCheck`, `STORE_NAMES` (src/commands/check.ts), `computeDiff`, `formatDiff` (Task 4), `readLocalListings` (Task 5), `StoreClient` (Task 3), `getField`, `StoreId` (registry), `toStoreLocale`, `storeRoot`, `resolveFieldPath`, `Logger`, `fakeStore` (Task 6), `makeProject`
- Produces:
  - `const REQUIRED_FOR_NEW: Record<StoreId, readonly string[]>` — play: `title, short_description, full_description`; appstore: `name, description, keywords`
  - `interface PushReport { status: "pushed" | "nothing" | "dry-run" | "cancelled" | "blocked"; locales: string[]; problems: string[] }`
  - `runPush(opts: { config: Config; cwd: string; client: StoreClient; log: Logger; dryRun?: boolean; confirm: (summary: string[]) => Promise<boolean> }): Promise<PushReport>`

Flow (spec §3, §7.1, §7.3): (1) `runCheck`; any error for this store → `blocked` with problems, no session opened. (2) For play, if the source locale has a changelog file, log once: "Changelogs (release notes) are not uploaded by storelingo yet; use `fastlane supply` for them." (3) Read local listings, open a session, read remote, `computeDiff`. Problems → abort, `blocked`. No diffs → abort, `nothing` (log "Nothing to push: …"). (4) Log every `formatDiff` line. `dryRun` → abort, `dry-run`. `confirm(summary)` false → abort, `cancelled`. (5) `update(merged)` for each diff, then `commit()`. Any thrown error → `abort()` then rethrow.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { runPush } from "../../src/commands/push.js";
import { createLogger } from "../../src/log.js";
import { fakeStore } from "../helpers/fake-store.js";
import { makeProject } from "../helpers/project.js";

const P = "fastlane/metadata/android";
const config = {
  sourceLocale: "en-US",
  targetLocales: ["ru"],
  stores: { play: { packageName: "com.example" } },
  translator: { provider: "anthropic" },
};
const source = {
  [`${P}/en-US/title.txt`]: "New title",
  [`${P}/en-US/short_description.txt`]: "S",
  [`${P}/en-US/full_description.txt`]: "F",
};
const remote = [
  { locale: "en-US", fields: { title: "Old title", short_description: "S", full_description: "F", video: "v" } },
];

function capture() {
  const out: string[] = [];
  const log = createLogger({ verbose: false, secrets: [], out: (l) => out.push(l), err: (l) => out.push(l) });
  return { log, out };
}
const yes = vi.fn(async () => true);

describe("runPush", () => {
  it("is blocked by check errors before touching the store", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/en-US/title.txt`]: "x".repeat(31) }, config);
    const { client, state } = fakeStore(remote);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(report.status).toBe("blocked");
    expect(report.problems.join("\n")).toContain("31 characters, limit is 30");
    expect(state.opened).toBe(0);
  });

  it("reports nothing to push when the store matches", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/en-US/title.txt`]: "Old title\n" }, config);
    const { client, state } = fakeStore(remote);
    const { log, out } = capture();
    const report = await runPush({ config: cfg, cwd, client, log, confirm: yes });
    expect(report).toEqual({ status: "nothing", locales: [], problems: [] });
    expect(out.join("\n")).toContain("Nothing to push");
    expect(state).toMatchObject({ aborted: 1, committed: 0 });
  });

  it("dry run prints the diff and changes nothing", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote);
    const { log, out } = capture();
    const confirm = vi.fn(async () => true);
    const report = await runPush({ config: cfg, cwd, client, log, dryRun: true, confirm });
    expect(report).toEqual({ status: "dry-run", locales: ["en-US"], problems: [] });
    expect(out).toContain('  title: "Old title" → "New title"');
    expect(confirm).not.toHaveBeenCalled();
    expect(state).toMatchObject({ updates: [], aborted: 1, committed: 0 });
  });

  it("does nothing when the user declines", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: async () => false });
    expect(report.status).toBe("cancelled");
    expect(state).toMatchObject({ updates: [], aborted: 1, committed: 0 });
  });

  it("pushes merged listings, including a new locale, and commits once", async () => {
    const { cwd, config: cfg } = await makeProject(
      {
        ...source,
        [`${P}/ru-RU/title.txt`]: "Время намаза",
        [`${P}/ru-RU/short_description.txt`]: "Точно",
        [`${P}/ru-RU/full_description.txt`]: "Длинно",
      },
      config,
    );
    const { client, state } = fakeStore(remote);
    const confirm = vi.fn(async () => true);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm });

    expect(report).toEqual({ status: "pushed", locales: ["en-US", "ru-RU"], problems: [] });
    expect(confirm).toHaveBeenCalledWith(expect.arrayContaining(["en-US:", "ru-RU (new listing):"]));
    expect(state.updates).toEqual([
      { locale: "en-US", fields: { title: "New title", short_description: "S", full_description: "F", video: "v" } },
      { locale: "ru-RU", fields: { title: "Время намаза", short_description: "Точно", full_description: "Длинно" } },
    ]);
    expect(state).toMatchObject({ committed: 1, aborted: 0 });
  });

  it("blocks a new locale that lacks required fields", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/ru-RU/title.txt`]: "Время" }, config);
    const { client, state } = fakeStore(remote);
    const report = await runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes });
    expect(report.status).toBe("blocked");
    expect(report.problems).toEqual(["ru-RU: a new listing needs short_description, full_description"]);
    expect(state).toMatchObject({ updates: [], aborted: 1 });
  });

  it("aborts and rethrows when an update fails", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote, { failOn: "update" });
    await expect(runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes })).rejects.toMatchObject({
      code: "E_STORE",
    });
    expect(state).toMatchObject({ committed: 0, aborted: 1 });
  });

  it("aborts and rethrows E_IN_REVIEW from commit", async () => {
    const { cwd, config: cfg } = await makeProject(source, config);
    const { client, state } = fakeStore(remote, { failOn: "commit" });
    await expect(runPush({ config: cfg, cwd, client, log: capture().log, confirm: yes })).rejects.toMatchObject({
      code: "E_IN_REVIEW",
    });
    expect(state.aborted).toBe(1);
  });

  it("notes that changelogs are not uploaded", async () => {
    const { cwd, config: cfg } = await makeProject({ ...source, [`${P}/en-US/changelogs/12.txt`]: "Fixes" }, config);
    const { log, out } = capture();
    await runPush({ config: cfg, cwd, client: fakeStore(remote).client, log, dryRun: true, confirm: yes });
    expect(out.join("\n")).toContain("fastlane supply");
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run test/commands/push.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/commands/push.ts`**

```ts
import type { Config } from "../config/schema.js";
import { getField, type StoreId } from "../fields/registry.js";
import { toStoreLocale } from "../locales/table.js";
import type { Logger } from "../log.js";
import { resolveFieldPath, storeRoot } from "../metadata/fastlane.js";
import { computeDiff, formatDiff } from "../stores/diff.js";
import { readLocalListings } from "../stores/local.js";
import type { StoreClient } from "../stores/types.js";
import { STORE_NAMES, runCheck } from "./check.js";

export const REQUIRED_FOR_NEW: Record<StoreId, readonly string[]> = {
  play: ["title", "short_description", "full_description"],
  appstore: ["name", "description", "keywords"],
};

export interface PushReport {
  status: "pushed" | "nothing" | "dry-run" | "cancelled" | "blocked";
  locales: string[];
  problems: string[];
}

export async function runPush(opts: {
  config: Config;
  cwd: string;
  client: StoreClient;
  log: Logger;
  dryRun?: boolean;
  confirm: (summary: string[]) => Promise<boolean>;
}): Promise<PushReport> {
  const { config, cwd, client, log } = opts;
  const store = client.store;

  const checkErrors = (await runCheck(config, cwd)).filter((i) => i.store === store && i.level === "error");
  if (checkErrors.length > 0) {
    return {
      status: "blocked",
      locales: [],
      problems: checkErrors.map((i) => `${i.locale}${i.field ? `/${i.field}` : ""}: ${i.message}`),
    };
  }

  if (store === "play") {
    const sourceStoreLocale = toStoreLocale(store, config.sourceLocale);
    const changelog =
      sourceStoreLocale &&
      (await resolveFieldPath(storeRoot(config, cwd, store), sourceStoreLocale, getField(store, "changelog")));
    if (changelog) log.info("Changelogs (release notes) are not uploaded by storelingo yet; use `fastlane supply` for them.");
  }

  const local = await readLocalListings(config, cwd, store);
  const session = await client.open();
  try {
    const remote = await session.listings();
    const { diffs, problems } = computeDiff(local, remote, REQUIRED_FOR_NEW[store]);
    if (problems.length > 0) {
      await session.abort();
      return { status: "blocked", locales: [], problems: problems.map((p) => `${p.locale}: ${p.message}`) };
    }
    if (diffs.length === 0) {
      await session.abort();
      log.info(`Nothing to push: ${STORE_NAMES[store]} already matches your files.`);
      return { status: "nothing", locales: [], problems: [] };
    }

    const summary = formatDiff(diffs);
    for (const line of summary) log.info(line);
    const locales = diffs.map((d) => d.locale);
    if (opts.dryRun) {
      await session.abort();
      return { status: "dry-run", locales, problems: [] };
    }
    if (!(await opts.confirm(summary))) {
      await session.abort();
      return { status: "cancelled", locales, problems: [] };
    }

    for (const diff of diffs) await session.update(diff.merged);
    await session.commit();
    return { status: "pushed", locales, problems: [] };
  } catch (err) {
    await session.abort();
    throw err;
  }
}
```

- [ ] **Step 4: Run the test, then the gate; commit**

Run: `npx vitest run test/commands/push.test.ts` → PASS (9 tests); full gate.

```bash
git add src/commands/push.ts test/commands/push.test.ts
git commit -m "feat: add push command logic with diff and confirmation"
```

---

### Task 8: CLI wiring for `pull` and `push`

**Files:**
- Modify: `src/cli/main.ts`
- Test: `test/cli/main.test.ts` (add a `describe("pull/push")` block; keep existing tests)

**Interfaces:**
- Consumes: `runPull` (Task 6), `runPush` (Task 7), `StoreClient` (Task 3), `loadServiceAccount`, `createTokenProvider` (Task 1), `createPlayApi` (Task 2), `createPlayStore` (Task 3), `fakeStore` (Task 6)
- Produces: `CliDeps` gains
  - `makeStore?: (store: StoreId, config: Config, env: NodeJS.ProcessEnv) => Promise<StoreClient>`
  - `confirm?: (message: string) => Promise<boolean>`
  - `isTTY?: boolean` (default `process.stdin.isTTY === true`)

Behaviour:
- `pull [--store <store>] [--force]`; `push [--store <store>] [--dry-run] [--yes]`.
- Store selection, before any network call: `--store appstore` → `E_USAGE` "App Store pull/push arrives in v0.3"; any other value except `play` → `E_USAGE` "--store must be play or appstore"; no `stores.play` in config → `E_CONFIG` "stores.play is not configured"; when `--store` is omitted and `stores.appstore` exists → info line "App Store pull/push is not supported yet (planned for v0.3); using Google Play only."
- push confirmation, decided before any network call: `--yes` → always confirm; else if `deps.confirm` → use it; else if TTY → `@inquirer/prompts` `confirm({ message, default: false })`; else, unless `--dry-run`, throw `E_USAGE` "push needs --yes when not running in an interactive terminal (or use --dry-run)". Message: "Upload these changes to Google Play?".
- Default `makeStore`: `loadServiceAccount(env)` → `createTokenProvider({ account })` → `createPlayApi({ packageName: config.stores.play.packageName, getToken: () => tokens.getToken() })` → `createPlayStore(api)`.
- Output and exit codes:
  - pull: "Pulled from Google Play: wrote N, unchanged U, kept S different local file(s) (use --force to overwrite)." then each skipped path as an info line; exit 0.
  - push pushed: "Pushed N listing(s) to Google Play: <locales>. Google reviews listing changes before they go live." exit 0.
  - push nothing / dry-run ("Dry run: nothing was changed.") / cancelled ("Cancelled: nothing was changed.") → exit 0.
  - push blocked: each problem via `log.error`, then "Push blocked: fix the problems above (nothing was changed)." → exit 1.
  - Thrown `StorelingoError`s (E_IN_REVIEW, E_AUTH_PLAY, E_STORE, …) use the existing top-level handler.
- `.version(...)` reads `package.json`: `createRequire(import.meta.url)("../../package.json").version` (works from `src/cli` in tests and `dist/cli` after build).

- [ ] **Step 1: Write the failing tests** — append to `test/cli/main.test.ts`:

```ts
import { createRequire } from "node:module";
import type { StoreId } from "../../src/fields/registry.js";
import { fakeStore } from "../helpers/fake-store.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
const remoteListings = [
  { locale: "en-US", fields: { title: "Old", short_description: "Accurate", full_description: "Long" } },
];

function storeDeps(cwd: string, extra: Partial<CliDeps> = {}) {
  const fake = fakeStore(remoteListings);
  const makeStore = vi.fn(async (_s: StoreId) => fake.client);
  const d = deps(cwd, { makeStore, isTTY: false, ...extra });
  return { ...d, fake, makeStore };
}

describe("pull/push", () => {
  it("prints the version from package.json", async () => {
    const { d, out } = deps(await makeTmpDir());
    expect(await run(d, "--version")).toBe(0);
    expect(out.join("\n")).toContain(pkg.version);
  });

  it("pull writes files and summarizes", async () => {
    const { cwd } = await makeProject({ "storelingo.config.json": JSON.stringify(config) }, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "pull")).toBe(0);
    expect(await readFile(join(cwd, P, "en-US", "title.txt"), "utf8")).toBe("Old");
    expect(s.out.join("\n")).toContain("Pulled from Google Play: wrote 3");
  });

  it("push without --yes outside a terminal exits 2 before any network call", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push")).toBe(2);
    expect(s.err.join("\n")).toContain("--yes");
    expect(s.makeStore).not.toHaveBeenCalled();
  });

  it("push --yes uploads and reports", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--yes")).toBe(0);
    expect(s.out.join("\n")).toContain("Pushed 1 listing(s) to Google Play: en-US");
    expect(s.fake.state.committed).toBe(1);
  });

  it("push --dry-run works without a terminal and changes nothing", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--dry-run")).toBe(0);
    expect(s.out.join("\n")).toContain("Dry run: nothing was changed.");
    expect(s.fake.state.committed).toBe(0);
  });

  it("push uses deps.confirm and respects a no", async () => {
    const { cwd } = await makeProject(files, config);
    const confirm = vi.fn(async () => false);
    const s = storeDeps(cwd, { confirm });
    expect(await run(s.d, "push")).toBe(0);
    expect(confirm).toHaveBeenCalledWith("Upload these changes to Google Play?");
    expect(s.out.join("\n")).toContain("Cancelled: nothing was changed.");
  });

  it("push blocked by check errors exits 1", async () => {
    const { cwd } = await makeProject({ ...files, [`${P}/en-US/title.txt`]: "x".repeat(31) }, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--yes")).toBe(1);
    expect(s.err.join("\n")).toContain("Push blocked");
  });

  it("--store appstore is not supported yet", async () => {
    const { cwd } = await makeProject(files, config);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--store", "appstore", "--yes")).toBe(2);
    expect(s.err.join("\n")).toContain("v0.3");
  });

  it("E_IN_REVIEW from the store exits 1 with its message", async () => {
    const { cwd } = await makeProject(files, config);
    const fake = fakeStore(remoteListings, { failOn: "commit" });
    const s = storeDeps(cwd, { makeStore: vi.fn(async () => fake.client) });
    expect(await run(s.d, "push", "--yes")).toBe(1);
    expect(s.err.join("\n")).toContain("error [E_IN_REVIEW]");
  });

  it("push without stores.play is a config error", async () => {
    const appOnly = { ...config, stores: { appstore: { appId: "1" } } };
    const { cwd } = await makeProject({ "storelingo.config.json": JSON.stringify(appOnly) }, appOnly);
    const s = storeDeps(cwd);
    expect(await run(s.d, "push", "--yes")).toBe(2);
    expect(s.err.join("\n")).toContain("stores.play is not configured");
  });
});
```

Adjust imports at the top of the file as needed (`vi` from vitest). `deps()` already exists in this file; extend its `Partial<CliDeps>` usage only — do not change its existing defaults.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/cli/main.test.ts` → the new tests FAIL (unknown command 'pull' etc.).

- [ ] **Step 3: Implement in `src/cli/main.ts`**

Add imports:
```ts
import { confirm as promptConfirm } from "@inquirer/prompts";
import { createRequire } from "node:module";
import { runPull } from "../commands/pull.js";
import { runPush } from "../commands/push.js";
import type { StoreId } from "../fields/registry.js";
import { createTokenProvider, loadServiceAccount } from "../stores/google-play/auth.js";
import { createPlayApi } from "../stores/google-play/client.js";
import { createPlayStore } from "../stores/google-play/store.js";
import type { StoreClient } from "../stores/types.js";
```

Extend `CliDeps`:
```ts
  makeStore?: (store: StoreId, config: Config, env: NodeJS.ProcessEnv) => Promise<StoreClient>;
  confirm?: (message: string) => Promise<boolean>;
  isTTY?: boolean;
```

Module-level helpers:
```ts
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
    throw new StorelingoError("E_CONFIG", "stores.play is not configured", "Add stores.play.packageName to storelingo.config.json.");
  }
  if (option === undefined && config.stores.appstore) {
    log.info("App Store pull/push is not supported yet (planned for v0.3); using Google Play only.");
  }
  return "play";
}
```

Replace `.version("0.1.0")` with `.version(pkg.version)`.

Add the two commands before the `try { await program.parseAsync(argv)`:
```ts
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
      if (opts.yes) ask = async () => true;
      else if (deps.confirm) {
        const confirmFn = deps.confirm;
        ask = async () => confirmFn(message);
      }
      else if (isTTY) ask = async () => promptConfirm({ message, default: false });
      else if (opts.dryRun) ask = async () => false;
      else {
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
```
Import `STORE_NAMES` from `../commands/check.js` alongside `runCheck`.

- [ ] **Step 4: Run the tests, build, smoke-test, gate**

Run: `npx vitest run test/cli/main.test.ts` → all PASS. Then `npm run build && node dist/bin.js --help && node dist/bin.js --version` (help lists `pull` and `push`; version matches package.json). Then the full gate.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts test/cli/main.test.ts
git commit -m "feat: add pull and push commands to the CLI"
```

---

### Task 9: Hardening, docs and version 0.2.0

**Files:**
- Modify: `src/translate/providers/openai-compatible.ts` (+ its test), `src/commands/init.ts` (+ its test), `README.md`, `README.ru.md`, `CHANGELOG.md`, `package.json`, `docs/superpowers/followups-2026-11-06-v0.1.md`
- Create: `docs/google-play-setup.md`, `docs/google-play-setup.ru.md`

Items:
1. **Redirects** (parked v0.1 item): add `redirect: "error"` to the fetch in `openai-compatible.ts`; test that the request init has `redirect: "error"`.
2. **init symlinks** (parked v0.1 item): before writing `storelingo.config.json` and `.gitignore`, call `assertSafePath(resolve(cwd), <file>)` from `src/metadata/fastlane.ts`. Test: a symlinked `.gitignore` → `E_CONFIG` and its target untouched (skip on win32/EPERM like the other symlink tests), plus a portable test that `init` still works in a normal directory (already covered — keep it green).
3. **Docs** — `docs/google-play-setup.md` and a Russian `docs/google-play-setup.ru.md`, step by step:
   - Create or pick a Google Cloud project; enable the "Google Play Android Developer API".
   - Create a service account; create a JSON key and download it. Keep it out of git (`init` already ignores `play-service-account*.json`).
   - In Play Console → Users and permissions → invite the service account e-mail; give it access to the app with permission to edit the store listing. Note that permissions can take a while to take effect.
   - `export STORELINGO_PLAY_SERVICE_ACCOUNT=/path/to/play-service-account.json` (Windows PowerShell: `$env:STORELINGO_PLAY_SERVICE_ACCOUNT = "C:\path\play-service-account.json"`).
   - First run: `npx storelingo pull`, then `translate`, `check`, `push --dry-run`, `push`.
   - Troubleshooting table: `E_AUTH_PLAY`, `E_CONFIG` (package not found), `E_IN_REVIEW`, `E_STORE`.
4. **README.md / README.ru.md**: add `pull` and `push` to Commands (flags, exit codes, the TTY/`--yes` rule, `--store` v0.2 = play only), a "Google Play" section that links the setup guide and states: one atomic edit per push; never cancels changes already in review (`ERROR_IF_IN_REVIEW`); Google reviews listing changes; changelogs are not uploaded yet (use `fastlane supply`); pulled translations without a lock entry are treated as manual edits by `translate`. Add `STORELINGO_PLAY_SERVICE_ACCOUNT` to the env-var table. Update the roadmap (v0.2 done → next v0.3 App Store). Every claim must match `src/`.
5. **CHANGELOG.md**: `## 0.2.0 — unreleased` with pull, push, the two hardening items.
6. **package.json**: `"version": "0.2.0"`.
7. **followups file**: move the two fixed parked items (redirects, init symlinks) to a "Done in v0.2" section.

- [ ] **Step 1:** TDD for items 1 and 2 (RED → GREEN), commit `fix: refuse redirects to translator hosts and symlinks in init`.
- [ ] **Step 2:** Docs, CHANGELOG, version (items 3–7). `npm run build && node dist/bin.js --version` prints `0.2.0`; `npm pack --dry-run` lists only `dist/**`, READMEs, LICENSE, package.json. Full gate. Commit `docs: Google Play setup guide and v0.2 docs`.
