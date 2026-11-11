import { describe, expect, it, vi } from "vitest";
import type {
  AppInfoAttrs,
  AppInfoLocalizationAttrs,
  AscApi,
  AscResource,
  VersionAttrs,
  VersionLocalizationAttrs,
} from "../../../src/stores/app-store/client.js";
import { createAppStoreStore } from "../../../src/stores/app-store/store.js";

interface Setup {
  infos?: AscResource<AppInfoAttrs>[];
  versions?: AscResource<VersionAttrs>[];
  infoLocs?: Record<string, AscResource<AppInfoLocalizationAttrs>[]>;
  versionLocs?: Record<string, AscResource<VersionLocalizationAttrs>[]>;
}

function fakeApi(setup: Setup) {
  const api: AscApi = {
    listAppInfos: vi.fn(async () => setup.infos ?? []),
    listAppInfoLocalizations: vi.fn(async (id: string) => setup.infoLocs?.[id] ?? []),
    createAppInfoLocalization: vi.fn(async () => {}),
    updateAppInfoLocalization: vi.fn(async () => {}),
    listVersions: vi.fn(async () => setup.versions ?? []),
    listVersionLocalizations: vi.fn(async (id: string) => setup.versionLocs?.[id] ?? []),
    createVersionLocalization: vi.fn(async () => {}),
    updateVersionLocalization: vi.fn(async () => {}),
  };
  return api;
}

const info = (id: string, state: string): AscResource<AppInfoAttrs> => ({ id, attributes: { state } });
const version = (id: string, appVersionState: string): AscResource<VersionAttrs> => ({
  id,
  attributes: { appVersionState },
});
const opts = { appId: "123", platform: "IOS" as const };

const editableSetup = (): Setup => ({
  infos: [info("i-live", "READY_FOR_DISTRIBUTION"), info("i-ed", "PREPARE_FOR_SUBMISSION")],
  versions: [version("v-live", "READY_FOR_DISTRIBUTION"), version("v-ed", "PREPARE_FOR_SUBMISSION")],
  infoLocs: {
    "i-ed": [{ id: "il-en", attributes: { locale: "en-US", name: "Name", subtitle: "Sub", privacyPolicyUrl: null } }],
    "i-live": [{ id: "il-live", attributes: { locale: "en-US", name: "Old" } }],
  },
  versionLocs: {
    "v-ed": [
      {
        id: "vl-en",
        attributes: {
          locale: "en-US",
          description: "Line1\r\nLine2",
          keywords: "a,b",
          promotionalText: "Promo",
          whatsNew: null,
        },
      },
    ],
    "v-live": [{ id: "vl-live", attributes: { locale: "en-US", description: "Old" } }],
  },
});

const liveSetup = (): Setup => ({
  infos: [info("i-live", "READY_FOR_DISTRIBUTION")],
  versions: [version("v-live", "READY_FOR_DISTRIBUTION")],
  infoLocs: { "i-live": [{ id: "il-live", attributes: { locale: "en-US", name: "Live name" } }] },
  versionLocs: { "v-live": [{ id: "vl-live", attributes: { locale: "en-US", description: "Live desc" } }] },
});

describe("createAppStoreStore", () => {
  it("is the appstore store and not atomic", async () => {
    const store = createAppStoreStore(fakeApi(editableSetup()), opts);
    expect(store.store).toBe("appstore");
    const session = await store.open();
    expect(session.atomic).toBe(false);
  });

  it("merges editable info and version listings with registry keys", async () => {
    const session = await createAppStoreStore(fakeApi(editableSetup()), opts).open();
    expect(await session.listings()).toEqual([
      {
        locale: "en-US",
        fields: { name: "Name", subtitle: "Sub", description: "Line1\nLine2", keywords: "a,b", promotional_text: "Promo" },
      },
    ]);
    expect(session.notes).toEqual([]);
    for (const f of [
      "name",
      "subtitle",
      "privacy_url",
      "description",
      "keywords",
      "promotional_text",
      "release_notes",
      "marketing_url",
      "support_url",
    ]) {
      expect(session.isWritable?.(f)).toBe(true);
    }
    expect(session.isWritable?.("bogus")).toBe(false);
  });

  it("reads live resources when nothing is editable and restricts writes", async () => {
    const session = await createAppStoreStore(fakeApi(liveSetup()), opts).open();
    expect(await session.listings()).toEqual([
      { locale: "en-US", fields: { name: "Live name", description: "Live desc" } },
    ]);
    expect(session.isWritable?.("description")).toBe(false);
    expect(session.isWritable?.("promotional_text")).toBe(true);
    expect(session.isWritable?.("name")).toBe(false);
    expect(session.notes).toHaveLength(2);
  });

  it("includes version-only locales after info locales", async () => {
    const setup = editableSetup();
    setup.versionLocs!["v-ed"]!.push({ id: "vl-de", attributes: { locale: "de-DE", description: "D" } });
    const session = await createAppStoreStore(fakeApi(setup), opts).open();
    expect((await session.listings()).map((l) => l.locale)).toEqual(["en-US", "de-DE"]);
  });

  it("PATCHes existing info and version localizations", async () => {
    const api = fakeApi(editableSetup());
    const session = await createAppStoreStore(api, opts).open();
    await session.update({ locale: "en-US", fields: { name: "N", description: "D", promotional_text: "P" } });
    expect(api.updateAppInfoLocalization).toHaveBeenCalledTimes(1);
    expect(api.updateAppInfoLocalization).toHaveBeenCalledWith("il-en", { name: "N" });
    expect(api.updateVersionLocalization).toHaveBeenCalledTimes(1);
    expect(api.updateVersionLocalization).toHaveBeenCalledWith("vl-en", { description: "D", promotionalText: "P" });
    expect(api.createAppInfoLocalization).not.toHaveBeenCalled();
    expect(api.createVersionLocalization).not.toHaveBeenCalled();
  });

  it("POSTs localizations for a new locale", async () => {
    const api = fakeApi(editableSetup());
    const session = await createAppStoreStore(api, opts).open();
    await session.update({ locale: "ru", fields: { name: "Имя", description: "Описание" } });
    expect(api.createAppInfoLocalization).toHaveBeenCalledWith("i-ed", { locale: "ru", name: "Имя" });
    expect(api.createVersionLocalization).toHaveBeenCalledWith("v-ed", { locale: "ru", description: "Описание" });
    expect(api.updateAppInfoLocalization).not.toHaveBeenCalled();
    expect(api.updateVersionLocalization).not.toHaveBeenCalled();
  });

  it("live-only: sends just promotional text to the live version", async () => {
    const api = fakeApi(liveSetup());
    const session = await createAppStoreStore(api, opts).open();
    await session.update({ locale: "en-US", fields: { promotional_text: "P", description: "ignored", name: "x" } });
    expect(api.updateVersionLocalization).toHaveBeenCalledTimes(1);
    expect(api.updateVersionLocalization).toHaveBeenCalledWith("vl-live", { promotionalText: "P" });
    expect(api.updateAppInfoLocalization).not.toHaveBeenCalled();
    expect(api.createAppInfoLocalization).not.toHaveBeenCalled();
    expect(api.createVersionLocalization).not.toHaveBeenCalled();
  });

  it("commit and abort are no-ops", async () => {
    const api = fakeApi(editableSetup());
    const session = await createAppStoreStore(api, opts).open();
    const before = vi.mocked(api.listAppInfos).mock.calls.length;
    await expect(session.commit()).resolves.toBeUndefined();
    await expect(session.abort()).resolves.toBeUndefined();
    expect(vi.mocked(api.listAppInfos).mock.calls.length).toBe(before);
    expect(api.updateAppInfoLocalization).not.toHaveBeenCalled();
    expect(api.createAppInfoLocalization).not.toHaveBeenCalled();
  });
});
