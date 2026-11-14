import { StorelingoError } from "../../errors.js";
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

const NO_EDITABLE_VERSION_NOTE =
  "No editable App Store version: only promotional text can be updated. Create a new version in App Store Connect to change the rest.";
const NO_VERSION_NOTE = "No App Store version yet: version texts can't be updated until a version exists.";
const NO_USABLE_VERSION_NOTE =
  "No editable or live App Store version: version texts can't be updated until a version is editable.";
const FIRST_VERSION_NOTE = "First version of the app: release notes are not sent (Apple shows them only for updates).";
const NO_INFO_NOTE =
  "No editable app info: name, subtitle and privacy URL can't be changed until a new version is being prepared.";

/** The resource in one of `states`; with several, PREPARE_FOR_SUBMISSION wins, otherwise it is ambiguous. */
function pickEditable<A>(
  items: AscResource<A>[],
  stateOf: (a: A) => string | null | undefined,
  states: readonly string[],
  what: string,
): AscResource<A> | undefined {
  const found = items.filter((r) => {
    const s = stateOf(r.attributes);
    return typeof s === "string" && states.includes(s);
  });
  if (found.length <= 1) return found[0];
  const preferred = found.filter((r) => stateOf(r.attributes) === "PREPARE_FOR_SUBMISSION");
  if (preferred.length === 1) return preferred[0];
  throw new StorelingoError(
    "E_STORE",
    `Several editable App Store ${what} found; finish or remove the extra one in App Store Connect`,
  );
}

function pickLive<A>(items: AscResource<A>[], stateOf: (a: A) => string | null | undefined) {
  return items.find((r) => stateOf(r.attributes) === LIVE_STATE);
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
      const editableInfo = pickEditable(infos, (a) => a.state, EDITABLE_INFO_STATES, "app infos");
      const liveInfo = pickLive(infos, (a) => a.state);
      const readInfo = editableInfo ?? liveInfo;

      const versions = await api.listVersions(opts.appId, opts.platform);
      const editableVersion = pickEditable(versions, (a) => a.appVersionState, EDITABLE_VERSION_STATES, "versions");
      const liveVersion = pickLive(versions, (a) => a.appVersionState);
      // Apple takes "What's New" only for updates, so the very first version of an app can't have release notes.
      const firstVersion = !!editableVersion && versions.length === 1;
      const readVersion = editableVersion ?? liveVersion;

      const infoLocs = localeMap<AppInfoLocalizationAttrs>(
        readInfo ? await api.listAppInfoLocalizations(readInfo.id) : [],
      );
      const versionLocs = localeMap<VersionLocalizationAttrs>(
        readVersion ? await api.listVersionLocalizations(readVersion.id) : [],
      );

      const notes: string[] = [];
      if (!editableVersion) {
        if (liveVersion) notes.push(NO_EDITABLE_VERSION_NOTE);
        else notes.push(versions.length === 0 ? NO_VERSION_NOTE : NO_USABLE_VERSION_NOTE);
      }
      if (firstVersion) notes.push(FIRST_VERSION_NOTE);
      if (!editableInfo) notes.push(NO_INFO_NOTE);

      const infoKeys: readonly string[] = INFO_FIELDS.map(([k]) => k);
      const isWritable = (field: string, locale?: string): boolean => {
        if (infoKeys.includes(field)) return !!editableInfo;
        if (field === "promotional_text") {
          // Without an editable version the text goes to the live version, which can't get a new language.
          if (editableVersion) return true;
          return !!readVersion && (locale === undefined || versionLocs.has(locale));
        }
        if (field === "release_notes" && firstVersion) return false;
        return VERSION_FIELDS.some(([k]) => k === field) && !!editableVersion;
      };
      const skipReason = (field: string, locale?: string): string | undefined => {
        if (isWritable(field, locale)) return undefined;
        if (field === "promotional_text" && readVersion) return "this language doesn't exist on the live version yet";
        if (infoKeys.includes(field)) return "no editable app info in App Store Connect";
        if (field === "release_notes" && firstVersion) return "Apple shows release notes only for updates";
        if (VERSION_FIELDS.some(([k]) => k === field)) return "no editable version in App Store Connect";
        return undefined;
      };

      return {
        atomic: false,
        notes,
        isWritable,
        skipReason,
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
            if (value !== undefined && isWritable(key, listing.locale)) infoAttrs[attr] = value;
          }
          for (const [key, attr] of VERSION_FIELDS) {
            const value = listing.fields[key];
            if (value !== undefined && isWritable(key, listing.locale)) versionAttrs[attr] = value;
          }
          if (editableInfo && Object.keys(infoAttrs).length > 0) {
            const existing = infoLocs.get(listing.locale);
            if (existing) await api.updateAppInfoLocalization(existing.id, infoAttrs);
            else await api.createAppInfoLocalization(editableInfo.id, { locale: listing.locale, ...infoAttrs });
          }
          if (readVersion && Object.keys(versionAttrs).length > 0) {
            const existing = versionLocs.get(listing.locale);
            if (existing) await api.updateVersionLocalization(existing.id, versionAttrs);
            // Creating a localization is only allowed on the editable version, never on the live one.
            else if (editableVersion) {
              await api.createVersionLocalization(editableVersion.id, { locale: listing.locale, ...versionAttrs });
            }
          }
        },
        async commit() {},
        async abort() {},
      };
    },
  };
}
