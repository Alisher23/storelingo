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
