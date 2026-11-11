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

  it("accepts literal \n sequences (CI secrets)", async () => {
    const escaped = privateKey.trim().split("\n").join("\n");
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
