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
