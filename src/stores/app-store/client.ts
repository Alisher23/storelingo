import { StorelingoError } from "../../errors.js";
import { RetryableError, withRetry } from "../../util/retry.js";

export const ASC_API_BASE = "https://api.appstoreconnect.apple.com";

export type AscPlatform = "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS";

export interface AscResource<A> {
  id: string;
  attributes: A;
}

export interface AppInfoAttrs {
  state?: string | null;
}

export interface AppInfoLocalizationAttrs {
  locale: string;
  name?: string | null;
  subtitle?: string | null;
  privacyPolicyUrl?: string | null;
}

export interface VersionAttrs {
  appVersionState?: string | null;
  versionString?: string | null;
}

export interface VersionLocalizationAttrs {
  locale: string;
  description?: string | null;
  keywords?: string | null;
  promotionalText?: string | null;
  whatsNew?: string | null;
  marketingUrl?: string | null;
  supportUrl?: string | null;
}

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

interface AscErrorBody {
  errors?: { status?: string; code?: string; title?: string; detail?: string }[];
}

interface AscListBody<A> {
  data?: AscResource<A>[];
  links?: { next?: string };
}

const MAX_PAGES = 50;
const CREATE_UNKNOWN_HINT = "Run `storelingo push --dry-run` to see whether the localization was created.";

/** Replaces every occurrence of the bearer token so it never reaches an error message. */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

/** Validates a URL path segment before it is encoded; rejects empty, "." and "..". */
function segment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new StorelingoError("E_STORE", `invalid App Store Connect path segment: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}

/** Parses a numeric Retry-After header (seconds) into milliseconds. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Number(raw) * 1000;
}

function toError(status: number, text: string, token: string, missingAppId?: string): StorelingoError {
  let parsed: AscErrorBody = {};
  try {
    parsed = JSON.parse(text) as AscErrorBody;
  } catch {
    // not JSON: fall back to the raw text
  }
  const first = parsed.errors?.[0];
  const detail = scrub(first?.detail ?? text, token).slice(0, 500);
  const title = scrub(first?.title ?? "", token).slice(0, 500);
  if (status === 401) {
    return new StorelingoError(
      "E_AUTH_ASC",
      `App Store Connect rejected the API key (401): ${detail}`,
      "Check STORELINGO_ASC_ISSUER_ID, STORELINGO_ASC_KEY_ID and the .p8 key; the key must not be revoked.",
    );
  }
  if (status === 403) {
    return new StorelingoError(
      "E_AUTH_ASC",
      `App Store Connect denied access (403): ${detail}`,
      "Use a team key with the App Manager role (or Admin).",
    );
  }
  if (status === 404 && missingAppId !== undefined) {
    return new StorelingoError(
      "E_CONFIG",
      `App Store app ${missingAppId} not found or not accessible: ${detail}`,
      "Check stores.appstore.appId (the numeric Apple ID).",
    );
  }
  if (status === 409) {
    return new StorelingoError("E_STORE", `App Store Connect refused the change (409): ${title} — ${detail}`);
  }
  return new StorelingoError("E_STORE", `App Store Connect API error ${status}: ${title} — ${detail}`);
}

export function createAscApi(opts: {
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): AscApi {
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function request<T>(
    method: string,
    url: string,
    body?: unknown,
    { retry = true, missingAppId }: { retry?: boolean; missingAppId?: string } = {},
  ): Promise<T> {
    const attempt = async (): Promise<T> => {
      const token = await opts.getToken();
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      let text: string;
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        });
        text = await res.text();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new RetryableError(`Network error: ${scrub(reason, token)}`);
      }
      if (res.status === 429) throw new RetryableError("HTTP 429", retryAfterMs(res));
      if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
      if (!res.ok) throw toError(res.status, text, token, missingAppId);
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new StorelingoError("E_STORE", `App Store Connect returned a non-JSON response (${res.status})`);
      }
    };
    if (!retry) return attempt();
    return withRetry(attempt, { sleep: opts.sleep }).catch((err: unknown) => {
      if (err instanceof RetryableError) {
        throw new StorelingoError("E_STORE", `App Store Connect API kept failing: ${err.message}`);
      }
      throw err;
    });
  }

  async function create(url: string, body: unknown): Promise<void> {
    try {
      await request("POST", url, body, { retry: false });
    } catch (err) {
      if (err instanceof RetryableError) {
        if (err.message === "HTTP 429") {
          // 429 is returned before the request is processed: nothing was created.
          throw new StorelingoError(
            "E_STORE",
            "App Store Connect rate limit (429): nothing was created; try again in a minute",
          );
        }
        throw new StorelingoError(
          "E_STORE",
          `App Store Connect create request status is unknown (${err.message})`,
          CREATE_UNKNOWN_HINT,
        );
      }
      throw err;
    }
  }

  async function list<A>(path: string, params: Record<string, string>, missingAppId?: string): Promise<AscResource<A>[]> {
    const query = new URLSearchParams({ ...params, limit: "200" });
    let url: string | undefined = `${ASC_API_BASE}${path}?${query.toString()}`;
    const out: AscResource<A>[] = [];
    const seen = new Set<string>();
    for (let pages = 0; url; pages++) {
      if (pages >= MAX_PAGES || seen.has(url)) {
        throw new StorelingoError("E_STORE", "App Store Connect pagination did not finish");
      }
      seen.add(url);
      const page: AscListBody<A> = await request<AscListBody<A>>("GET", url, undefined, {
        missingAppId: pages === 0 ? missingAppId : undefined,
      });
      for (const r of page.data ?? []) out.push({ id: r.id, attributes: r.attributes });
      const next: string | undefined = page.links?.next;
      if (typeof next === "string" && !next.startsWith(`${ASC_API_BASE}/`)) {
        throw new StorelingoError("E_STORE", "App Store Connect returned a pagination link to another host");
      }
      url = typeof next === "string" ? next : undefined;
    }
    return out;
  }

  return {
    async listAppInfos(appId) {
      const id = segment(appId);
      return list<AppInfoAttrs>(`/v1/apps/${id}/appInfos`, {}, appId);
    },
    async listAppInfoLocalizations(appInfoId) {
      return list<AppInfoLocalizationAttrs>(`/v1/appInfos/${segment(appInfoId)}/appInfoLocalizations`, {});
    },
    async createAppInfoLocalization(appInfoId, attributes) {
      segment(appInfoId);
      await create(`${ASC_API_BASE}/v1/appInfoLocalizations`, {
        data: {
          type: "appInfoLocalizations",
          attributes,
          relationships: { appInfo: { data: { type: "appInfos", id: appInfoId } } },
        },
      });
    },
    async updateAppInfoLocalization(id, attributes) {
      await request("PATCH", `${ASC_API_BASE}/v1/appInfoLocalizations/${segment(id)}`, {
        data: { type: "appInfoLocalizations", id, attributes },
      });
    },
    async listVersions(appId, platform) {
      const id = segment(appId);
      return list<VersionAttrs>(`/v1/apps/${id}/appStoreVersions`, { "filter[platform]": platform }, appId);
    },
    async listVersionLocalizations(versionId) {
      return list<VersionLocalizationAttrs>(
        `/v1/appStoreVersions/${segment(versionId)}/appStoreVersionLocalizations`,
        {},
      );
    },
    async createVersionLocalization(versionId, attributes) {
      segment(versionId);
      await create(`${ASC_API_BASE}/v1/appStoreVersionLocalizations`, {
        data: {
          type: "appStoreVersionLocalizations",
          attributes,
          relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
        },
      });
    },
    async updateVersionLocalization(id, attributes) {
      await request("PATCH", `${ASC_API_BASE}/v1/appStoreVersionLocalizations/${segment(id)}`, {
        data: { type: "appStoreVersionLocalizations", id, attributes },
      });
    },
  };
}
