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
  let pem = env.STORELINGO_ASC_PRIVATE_KEY as string; // untrimmed: preserve the PEM verbatim
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
  if (!pem.includes("\n") && pem.includes("\n")) pem = pem.split("\n").join("\n");
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
