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
      "Set it to the path of your Google Play service account JSON key (or to the JSON itself). See https://github.com/Alisher23/storelingo/blob/main/docs/google-play-setup.md.",
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
