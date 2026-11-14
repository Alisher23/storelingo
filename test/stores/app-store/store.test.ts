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

  it("promotional text without an editable version needs the locale on the live version", async () => {
    const setup = liveSetup();
    setup.infoLocs!["i-live"]!.push({ id: "il-ru", attributes: { locale: "ru", name: "Имя" } });
    const session = await createAppStoreStore(fakeApi(setup), opts).open();
    expect(session.isWritable?.("promotional_text", "en-US")).toBe(true);
    expect(session.isWritable?.("promotional_text", "ru")).toBe(false);
    expect(session.isWritable?.("promotional_text")).toBe(true);
    expect(session.skipReason?.("promotional_text", "ru")).toBe("this language doesn't exist on the live version yet");
    expect(session.skipReason?.("promotional_text", "en-US")).toBeUndefined();
  });

  it("promotional text for a new locale stays writable when a version is editable", async () => {
    const session = await createAppStoreStore(fakeApi(editableSetup()), opts).open();
    expect(session.isWritable?.("promotional_text", "ru")).toBe(true);
  });

  describe("edge cases", () => {
    it("no app info and no version: no listings, nothing writable, notes present", async () => {
      const session = await createAppStoreStore(fakeApi({}), opts).open();
      expect(await session.listings()).toEqual([]);
      for (const f of ["name", "description", "promotional_text", "release_notes"]) {
        expect(session.isWritable?.(f, "en-US")).toBe(false);
      }
      expect(session.notes).toContain("No App Store version yet: version texts can't be updated until a version exists.");
      expect(session.notes?.some((n) => n.includes("No editable app info"))).toBe(true);
    });

    it("app info only: listings carry info fields, version fields are not writable", async () => {
      const setup: Setup = {
        infos: [info("i-ed", "PREPARE_FOR_SUBMISSION")],
        infoLocs: { "i-ed": [{ id: "il-en", attributes: { locale: "en-US", name: "N", subtitle: "S" } }] },
      };
      const session = await createAppStoreStore(fakeApi(setup), opts).open();
      expect(await session.listings()).toEqual([{ locale: "en-US", fields: { name: "N", subtitle: "S" } }]);
      expect(session.isWritable?.("name", "en-US")).toBe(true);
      expect(session.isWritable?.("description", "en-US")).toBe(false);
      expect(session.isWritable?.("promotional_text", "en-US")).toBe(false);
    });

    it("version only: listings carry version fields, info fields are not writable", async () => {
      const setup: Setup = {
        versions: [version("v-ed", "PREPARE_FOR_SUBMISSION")],
        versionLocs: { "v-ed": [{ id: "vl-en", attributes: { locale: "en-US", description: "D", keywords: "k" } }] },
      };
      const session = await createAppStoreStore(fakeApi(setup), opts).open();
      expect(await session.listings()).toEqual([{ locale: "en-US", fields: { description: "D", keywords: "k" } }]);
      expect(session.isWritable?.("description", "en-US")).toBe(true);
      expect(session.isWritable?.("name", "en-US")).toBe(false);
      expect(session.notes?.some((n) => n.includes("No editable app info"))).toBe(true);
    });

    it("drops whitespace-only remote values", async () => {
      const setup = editableSetup();
      setup.infoLocs!["i-ed"] = [{ id: "il-en", attributes: { locale: "en-US", name: "  ", subtitle: "Sub" } }];
      setup.versionLocs!["v-ed"] = [
        { id: "vl-en", attributes: { locale: "en-US", description: "\n\t ", keywords: "a" } },
      ];
      const session = await createAppStoreStore(fakeApi(setup), opts).open();
      expect(await session.listings()).toEqual([{ locale: "en-US", fields: { subtitle: "Sub", keywords: "a" } }]);
    });
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

  it("does not POST a version localization when there is no editable version", async () => {
    const setup = liveSetup();
    setup.infoLocs!["i-live"]!.push({ id: "il-ru", attributes: { locale: "ru", name: "Имя" } });
    const api = fakeApi(setup);
    const session = await createAppStoreStore(api, opts).open();
    await session.update({ locale: "ru", fields: { promotional_text: "Промо" } });
    expect(api.createVersionLocalization).not.toHaveBeenCalled();
    expect(api.updateVersionLocalization).not.toHaveBeenCalled();
  });

  describe("several editable resources", () => {
    it("prefers PREPARE_FOR_SUBMISSION", async () => {
      const setup = editableSetup();
      setup.versions = [version("v-rej", "REJECTED"), version("v-ed", "PREPARE_FOR_SUBMISSION")];
      setup.infos = [info("i-rej", "REJECTED"), info("i-ed", "PREPARE_FOR_SUBMISSION")];
      const api = fakeApi(setup);
      const session = await createAppStoreStore(api, opts).open();
      await session.update({ locale: "en-US", fields: { name: "N", description: "D" } });
      expect(api.updateAppInfoLocalization).toHaveBeenCalledWith("il-en", { name: "N" });
      expect(api.updateVersionLocalization).toHaveBeenCalledWith("vl-en", { description: "D" });
    });

    it("throws E_STORE when it is still ambiguous", async () => {
      const setup = editableSetup();
      setup.versions = [version("v-a", "REJECTED"), version("v-b", "METADATA_REJECTED")];
      await expect(createAppStoreStore(fakeApi(setup), opts).open()).rejects.toMatchObject({
        code: "E_STORE",
        message: "Several editable App Store versions found; finish or remove the extra one in App Store Connect",
      });
      const infos = editableSetup();
      infos.infos = [info("i-a", "REJECTED"), info("i-b", "DEVELOPER_REJECTED")];
      await expect(createAppStoreStore(fakeApi(infos), opts).open()).rejects.toMatchObject({ code: "E_STORE" });
    });
  });

  describe("first version of an app", () => {
    const firstSetup = (): Setup => ({
      ...editableSetup(),
      versions: [version("v-ed", "PREPARE_FOR_SUBMISSION")],
    });

    it("does not write release notes and says why", async () => {
      const api = fakeApi(firstSetup());
      const session = await createAppStoreStore(api, opts).open();
      expect(session.isWritable?.("release_notes")).toBe(false);
      expect(session.isWritable?.("description")).toBe(true);
      expect(session.notes).toContain(
        "First version of the app: release notes are not sent (Apple shows them only for updates).",
      );
      expect(session.skipReason?.("release_notes")).toBe("Apple shows release notes only for updates");
      await session.update({ locale: "en-US", fields: { release_notes: "New", description: "D" } });
      expect(api.updateVersionLocalization).toHaveBeenCalledWith("vl-en", { description: "D" });
    });

    it("keeps release notes writable when another version exists", async () => {
      const session = await createAppStoreStore(fakeApi(editableSetup()), opts).open();
      expect(session.isWritable?.("release_notes")).toBe(true);
      expect(session.notes).toEqual([]);
    });
  });

  describe("notes and skip reasons", () => {
    it("says a version is missing when there is none at all", async () => {
      const setup = { ...editableSetup(), versions: [] };
      const session = await createAppStoreStore(fakeApi(setup), opts).open();
      expect(session.notes).toContain(
        "No App Store version yet: version texts can't be updated until a version exists.",
      );
      expect(session.notes?.some((n) => n.includes("only promotional text"))).toBe(false);
    });

    it("keeps the promotional-text note when only a live version exists", async () => {
      const session = await createAppStoreStore(fakeApi(liveSetup()), opts).open();
      expect(session.notes?.some((n) => n.includes("only promotional text can be updated"))).toBe(true);
    });

    it("gives a reason per field kind", async () => {
      const session = await createAppStoreStore(fakeApi(liveSetup()), opts).open();
      expect(session.skipReason?.("name")).toBe("no editable app info in App Store Connect");
      expect(session.skipReason?.("description")).toBe("no editable version in App Store Connect");
      expect(session.skipReason?.("bogus")).toBeUndefined();
      const ok = await createAppStoreStore(fakeApi(editableSetup()), opts).open();
      expect(ok.skipReason?.("name")).toBeUndefined();
    });
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
