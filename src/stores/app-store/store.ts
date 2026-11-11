import type { StoreClient, StoreListing, StoreSession } from "../types.js";
import { normalizeText } from "../../util/text.js";
import type {
  AppInfoLocalizationAttrs,
  AscApi,
  AscPlatform,
  AscResource,
  VersionLocalizationAttrs,
} from "./client.js";

export const EDITABLE_VERSION_STATES: readonly string[] = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
];
export const EDITABLE_INFO_STATES: readonly string[] = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED"];
export const LIVE_STATE = "READY_FOR_DISTRIBUTION";

/** Field-registry key → appInfoLocalizations attribute. */
const INFO_FIELDS = [
  ["name", "name"],
  ["subtitle", "subtitle"],
  ["privacy_url", "privacyPolicyUrl"],
] as const;

/** Field-registry key → appStoreVersionLocalizations attribute. */
const VERSION_FIELDS = [
  ["description", "description"],
  ["keywords", "keywords"],
  ["promotional_text", "promotionalText"],
  ["release_notes", "whatsNew"],
  ["marketing_url", "marketingUrl"],
  ["support_url", "supportUrl"],
] as const;

const NO_VERSION_NOTE =
  "No editable App Store version: only promotional text can be updated. Create a new version in App Store Connect to change the rest.";
const NO_INFO_NOTE =
  "No editable app info: name, subtitle and privacy URL can't be changed until a new version is being prepared.";

function pick<A>(items: AscResource<A>[], stateOf: (a: A) => string | null | undefined, states: readonly string[]) {
  return items.find((r) => {
    const s = stateOf(r.attributes);
    return typeof s === "string" && states.includes(s);
  });
}

function localeMap<A extends { locale: string }>(items: AscResource<A>[]): Map<string, AscResource<A>> {
  const map = new Map<string, AscResource<A>>();
  for (const item of items) if (!map.has(item.attributes.locale)) map.set(item.attributes.locale, item);
  return map;
}

function collect<A extends object>(
  attrs: A | undefined,
  map: readonly (readonly [string, keyof A])[],
  into: Record<string, string>,
): void {
  if (!attrs) return;
  for (const [key, attr] of map) {
    const value = attrs[attr];
    if (typeof value === "string" && value.trim() !== "") into[key] = normalizeText(value);
  }
}

export function createAppStoreStore(api: AscApi, opts: { appId: string; platform: AscPlatform }): StoreClient {
  return {
    store: "appstore",
    async open(): Promise<StoreSession> {
      const infos = await api.listAppInfos(opts.appId);
      const editableInfo = pick(infos, (a) => a.state, EDITABLE_INFO_STATES);
      const liveInfo = pick(infos, (a) => a.state, [LIVE_STATE]);
      const readInfo = editableInfo ?? liveInfo;

      const versions = await api.listVersions(opts.appId, opts.platform);
      const editableVersion = pick(versions, (a) => a.appVersionState, EDITABLE_VERSION_STATES);
      const liveVersion = pick(versions, (a) => a.appVersionState, [LIVE_STATE]);
      const readVersion = editableVersion ?? liveVersion;

      const infoLocs = localeMap<AppInfoLocalizationAttrs>(
        readInfo ? await api.listAppInfoLocalizations(readInfo.id) : [],
      );
      const versionLocs = localeMap<VersionLocalizationAttrs>(
        readVersion ? await api.listVersionLocalizations(readVersion.id) : [],
      );

      const notes: string[] = [];
      if (!editableVersion) notes.push(NO_VERSION_NOTE);
      if (!editableInfo) notes.push(NO_INFO_NOTE);

      const infoKeys: readonly string[] = INFO_FIELDS.map(([k]) => k);
      const isWritable = (field: string): boolean => {
        if (infoKeys.includes(field)) return !!editableInfo;
        if (field === "promotional_text") return !!readVersion;
        return VERSION_FIELDS.some(([k]) => k === field) && !!editableVersion;
      };

      return {
        atomic: false,
        notes,
        isWritable,
        async listings() {
          const locales = [...infoLocs.keys()];
          for (const locale of versionLocs.keys()) if (!infoLocs.has(locale)) locales.push(locale);
          return locales.map((locale): StoreListing => {
            const fields: Record<string, string> = {};
            collect(infoLocs.get(locale)?.attributes, INFO_FIELDS, fields);
            collect(versionLocs.get(locale)?.attributes, VERSION_FIELDS, fields);
            return { locale, fields };
          });
        },
        async update(listing) {
          const infoAttrs: Record<string, string> = {};
          const versionAttrs: Record<string, string> = {};
          for (const [key, attr] of INFO_FIELDS) {
            const value = listing.fields[key];
            if (value !== undefined && isWritable(key)) infoAttrs[attr] = value;
          }
          for (const [key, attr] of VERSION_FIELDS) {
            const value = listing.fields[key];
            if (value !== undefined && isWritable(key)) versionAttrs[attr] = value;
          }
          if (editableInfo && Object.keys(infoAttrs).length > 0) {
            const existing = infoLocs.get(listing.locale);
            if (existing) await api.updateAppInfoLocalization(existing.id, infoAttrs);
            else await api.createAppInfoLocalization(editableInfo.id, { locale: listing.locale, ...infoAttrs });
          }
          if (readVersion && Object.keys(versionAttrs).length > 0) {
            const existing = versionLocs.get(listing.locale);
            if (existing) await api.updateVersionLocalization(existing.id, versionAttrs);
            else await api.createVersionLocalization(readVersion.id, { locale: listing.locale, ...versionAttrs });
          }
        },
        async commit() {},
        async abort() {},
      };
    },
  };
}
