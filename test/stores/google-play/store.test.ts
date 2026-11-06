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

  it("normalizes remote text to LF without a BOM", async () => {
    const { api } = fakeApi([{ language: "en-US", title: "\uFEFFT", fullDescription: "a\r\nb\rc" }]);
    const session = await createPlayStore(api).open();
    expect(await session.listings()).toEqual([{ locale: "en-US", fields: { title: "T", full_description: "a\nb\nc" } }]);
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
