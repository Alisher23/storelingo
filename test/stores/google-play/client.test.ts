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

  it("retries when the response body fails mid-read", async () => {
    const broken = () =>
      new Response(new ReadableStream({ start(c) { c.error(new Error("reset")); } }), { status: 200 });
    const fetchImpl = vi.fn().mockResolvedValueOnce(broken()).mockResolvedValueOnce(json(200, { id: "e4" }));
    expect(await api(fetchImpl).insertEdit()).toBe("e4");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry commit: a 503 becomes E_STORE with unknown status", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(503, {}));
    await expect(api(fetchImpl).commitEdit("e1")).rejects.toMatchObject({
      code: "E_STORE",
      message: expect.stringContaining("status is unknown"),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects empty, dot and dot-dot path segments before any request", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(200, {}));
    const a = api(fetchImpl);
    await expect(a.updateListing("e1", { language: ".." })).rejects.toMatchObject({
      code: "E_STORE",
      message: "invalid Google Play path segment",
    });
    await expect(a.listListings("")).rejects.toMatchObject({ code: "E_STORE" });
    await expect(a.listListings(".")).rejects.toMatchObject({ code: "E_STORE" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() =>
      createPlayApi({ packageName: "..", getToken: async () => "tok-123", fetchImpl, sleep: async () => {} }),
    ).toThrow(expect.objectContaining({ code: "E_STORE" }));
  });

  it("redacts the bearer token from error messages", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(400, { error: { code: 400, message: "Bad credential tok-123 here" } }));
    const err = await api(fetchImpl).insertEdit().catch((e) => e);
    expect(err.message).toContain("***");
    expect(err.message).not.toContain("tok-123");
  });

  it("honours a numeric retry-after on 429", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(json(200, { id: "e5" }));
    const a = createPlayApi({ packageName: "com.example.app", getToken: async () => "tok-123", fetchImpl, sleep });
    expect(await a.insertEdit()).toBe("e5");
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});
