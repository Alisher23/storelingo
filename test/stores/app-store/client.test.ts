import { describe, expect, it, vi } from "vitest";
import { ASC_API_BASE, createAscApi } from "../../../src/stores/app-store/client.js";

const json = (status: number, payload?: unknown, headers?: Record<string, string>) =>
  new Response(payload === undefined ? "" : JSON.stringify(payload), { status, headers });
const api = (fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void> = async () => {}) =>
  createAscApi({ getToken: async () => "tok-123", fetchImpl, sleep });
const errBody = (status: string, title: string, detail: string) => ({ errors: [{ status, code: "X", title, detail }] });

describe("createAscApi", () => {
  it("lists app infos with auth, a timeout and no redirects", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(200, { data: [{ type: "appInfos", id: "i1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] }));
    expect(await api(fetchImpl).listAppInfos("123")).toEqual([
      { id: "i1", attributes: { state: "PREPARE_FOR_SUBMISSION" } },
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ASC_API_BASE}/v1/apps/123/appInfos?limit=200`);
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer tok-123");
    expect(init.headers.accept).toBe("application/json");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("follows links.next within the API origin only", async () => {
    const next = `${ASC_API_BASE}/v1/apps/123/appInfos?cursor=abc&limit=200`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { data: [{ id: "a", attributes: {} }], links: { next } }))
      .mockResolvedValueOnce(json(200, { data: [{ id: "b", attributes: {} }] }));
    const res = await api(fetchImpl).listAppInfos("123");
    expect(res.map((r) => r.id)).toEqual(["a", "b"]);
    expect(fetchImpl.mock.calls[1]![0]).toBe(next);

    const evil = vi.fn().mockImplementation(async () =>
      json(200, { data: [{ id: "a", attributes: {} }], links: { next: "https://evil.example/v1/x" } }));
    expect((await api(evil).listAppInfos("123")).map((r) => r.id)).toEqual(["a"]);
    expect(evil).toHaveBeenCalledTimes(1);
  });

  it("filters versions by platform", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(200, { data: [] }));
    await api(fetchImpl).listVersions("123", "IOS");
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain(`${ASC_API_BASE}/v1/apps/123/appStoreVersions?`);
    expect(url).toContain("filter%5Bplatform%5D=IOS");
    expect(url).toContain("limit=200");
  });

  it("lists localizations", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json(200, { data: [{ id: "l1", attributes: { locale: "en-US", name: "N" } }] }));
    const a = api(fetchImpl);
    expect(await a.listAppInfoLocalizations("i1")).toEqual([{ id: "l1", attributes: { locale: "en-US", name: "N" } }]);
    await a.listVersionLocalizations("v1");
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${ASC_API_BASE}/v1/appInfos/i1/appInfoLocalizations?limit=200`);
    expect(fetchImpl.mock.calls[1]![0]).toBe(`${ASC_API_BASE}/v1/appStoreVersions/v1/appStoreVersionLocalizations?limit=200`);
  });

  it("POSTs new localizations with the exact body shape", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(201, { data: { id: "n" } }));
    const a = api(fetchImpl);
    await a.createAppInfoLocalization("info1", { locale: "ru", name: "Время" });
    await a.createVersionLocalization("ver1", { locale: "ru", description: "D" });
    const [u1, i1] = fetchImpl.mock.calls[0]!;
    expect(u1).toBe(`${ASC_API_BASE}/v1/appInfoLocalizations`);
    expect(i1.method).toBe("POST");
    expect(i1.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(i1.body)).toEqual({
      data: {
        type: "appInfoLocalizations",
        attributes: { locale: "ru", name: "Время" },
        relationships: { appInfo: { data: { type: "appInfos", id: "info1" } } },
      },
    });
    const [u2, i2] = fetchImpl.mock.calls[1]!;
    expect(u2).toBe(`${ASC_API_BASE}/v1/appStoreVersionLocalizations`);
    expect(JSON.parse(i2.body)).toEqual({
      data: {
        type: "appStoreVersionLocalizations",
        attributes: { locale: "ru", description: "D" },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "ver1" } } },
      },
    });
  });

  it("PATCHes existing localizations", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json(200, { data: {} }));
    const a = api(fetchImpl);
    await a.updateVersionLocalization("loc1", { description: "D" });
    await a.updateAppInfoLocalization("loc2", { name: "N" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${ASC_API_BASE}/v1/appStoreVersionLocalizations/loc1`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      data: { type: "appStoreVersionLocalizations", id: "loc1", attributes: { description: "D" } },
    });
    expect(fetchImpl.mock.calls[1]![0]).toBe(`${ASC_API_BASE}/v1/appInfoLocalizations/loc2`);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body)).toEqual({
      data: { type: "appInfoLocalizations", id: "loc2", attributes: { name: "N" } },
    });
  });

  it("maps 401 and 403 to E_AUTH_ASC", async () => {
    const f401 = vi.fn().mockImplementation(async () => json(401, errBody("401", "NOT_AUTHORIZED", "bad token")));
    const e401 = await api(f401).listAppInfos("1").catch((e) => e);
    expect(e401.code).toBe("E_AUTH_ASC");
    expect(e401.message).toBe("App Store Connect rejected the API key (401): bad token");
    const f403 = vi.fn().mockImplementation(async () => json(403, errBody("403", "FORBIDDEN", "no role")));
    const e403 = await api(f403).listAppInfos("1").catch((e) => e);
    expect(e403.code).toBe("E_AUTH_ASC");
    expect(e403.message).toContain("no role");
  });

  it("maps 404 on listAppInfos and listVersions to E_CONFIG", async () => {
    const f = vi.fn().mockImplementation(async () => json(404, errBody("404", "NOT_FOUND", "no such app")));
    await expect(api(f).listAppInfos("9")).rejects.toMatchObject({ code: "E_CONFIG" });
    await expect(api(f).listVersions("9", "IOS")).rejects.toMatchObject({ code: "E_CONFIG" });
    await expect(api(f).listVersionLocalizations("v")).rejects.toMatchObject({ code: "E_STORE" });
  });

  it("maps 409 to E_STORE with the detail", async () => {
    const f = vi.fn().mockImplementation(async () => json(409, errBody("409", "STATE_ERROR", "version is locked")));
    await expect(api(f).updateVersionLocalization("l", { description: "x" })).rejects.toMatchObject({
      code: "E_STORE",
      message: expect.stringContaining("version is locked"),
    });
  });

  it("redacts the bearer token from error messages", async () => {
    const f = vi.fn().mockImplementation(async () => json(400, errBody("400", "BAD", "echo tok-123 here")));
    const err = await api(f).updateVersionLocalization("l", {}).catch((e) => e);
    expect(err.code).toBe("E_STORE");
    expect(err.message).toContain("***");
    expect(err.message).not.toContain("tok-123");
  });

  it("retries a GET 5xx and then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { data: [] }));
    expect(await api(f).listAppInfos("1")).toEqual([]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honours a numeric retry-after on 429", async () => {
    const sleep = vi.fn(async () => {});
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(429, undefined, { "retry-after": "2" }))
      .mockResolvedValueOnce(json(200, { data: [] }));
    await api(f, sleep).listAppInfos("1");
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up on a persistently failing GET with E_STORE", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(api(f).listAppInfos("1")).rejects.toMatchObject({
      code: "E_STORE",
      message: expect.stringContaining("App Store Connect API kept failing"),
    });
    expect(f).toHaveBeenCalledTimes(5);
  });

  it("retries a PATCH on 503", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { data: {} }));
    await api(f).updateAppInfoLocalization("l", { name: "N" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("never retries a POST: a 503 becomes an unknown-status E_STORE", async () => {
    const f = vi.fn().mockImplementation(async () => json(503, {}));
    const err = await api(f).createVersionLocalization("v", { locale: "ru" }).catch((e) => e);
    expect(err.code).toBe("E_STORE");
    expect(err.message).toContain("status is unknown");
    expect(err.hint).toContain("storelingo push --dry-run");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("rejects bad path segments before any request", async () => {
    const f = vi.fn().mockImplementation(async () => json(200, {}));
    const a = api(f);
    await expect(a.updateAppInfoLocalization("..", {})).rejects.toMatchObject({
      code: "E_STORE",
      message: 'invalid App Store Connect path segment: ".."',
    });
    await expect(a.listAppInfos("")).rejects.toMatchObject({ code: "E_STORE" });
    await expect(a.listVersionLocalizations(".")).rejects.toMatchObject({ code: "E_STORE" });
    expect(f).not.toHaveBeenCalled();
  });
});
