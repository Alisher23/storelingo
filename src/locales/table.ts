import type { StoreId } from "../fields/registry.js";

export interface LocaleDef {
  /** storelingo's own code, used in config. */
  code: string;
  /** English name, used in prompts. */
  name: string;
  /** Google Play listing language code, if supported. */
  play?: string;
  /** App Store Connect locale code, if supported. */
  appstore?: string;
}

/**
 * Languages supported by at least one store. Data only — add a row to
 * support a new language. Sources: Play Console "Add translations" list,
 * App Store Connect "Localizations" list.
 */
export const LOCALES: readonly LocaleDef[] = [
  { code: "ar", name: "Arabic", play: "ar", appstore: "ar-SA" },
  { code: "az", name: "Azerbaijani", play: "az-AZ" },
  { code: "ca", name: "Catalan", play: "ca", appstore: "ca" },
  { code: "cs", name: "Czech", play: "cs-CZ", appstore: "cs" },
  { code: "da", name: "Danish", play: "da-DK", appstore: "da" },
  { code: "de", name: "German", play: "de-DE", appstore: "de-DE" },
  { code: "el", name: "Greek", play: "el-GR", appstore: "el" },
  { code: "en-AU", name: "English (Australia)", play: "en-AU", appstore: "en-AU" },
  { code: "en-CA", name: "English (Canada)", play: "en-CA", appstore: "en-CA" },
  { code: "en-GB", name: "English (United Kingdom)", play: "en-GB", appstore: "en-GB" },
  { code: "en-US", name: "English (United States)", play: "en-US", appstore: "en-US" },
  { code: "es-ES", name: "Spanish (Spain)", play: "es-ES", appstore: "es-ES" },
  { code: "es-419", name: "Spanish (Latin America)", play: "es-419", appstore: "es-MX" },
  { code: "fa", name: "Persian", play: "fa" },
  { code: "fi", name: "Finnish", play: "fi-FI", appstore: "fi" },
  { code: "fr-CA", name: "French (Canada)", play: "fr-CA", appstore: "fr-CA" },
  { code: "fr-FR", name: "French (France)", play: "fr-FR", appstore: "fr-FR" },
  { code: "he", name: "Hebrew", play: "iw-IL", appstore: "he" },
  { code: "hi", name: "Hindi", play: "hi-IN", appstore: "hi" },
  { code: "hr", name: "Croatian", play: "hr", appstore: "hr" },
  { code: "hu", name: "Hungarian", play: "hu-HU", appstore: "hu" },
  { code: "id", name: "Indonesian", play: "id", appstore: "id" },
  { code: "it", name: "Italian", play: "it-IT", appstore: "it" },
  { code: "ja", name: "Japanese", play: "ja-JP", appstore: "ja" },
  { code: "kk", name: "Kazakh", play: "kk" },
  { code: "ko", name: "Korean", play: "ko-KR", appstore: "ko" },
  { code: "ky", name: "Kyrgyz", play: "ky-KG" },
  { code: "ms", name: "Malay", play: "ms", appstore: "ms" },
  { code: "nl", name: "Dutch", play: "nl-NL", appstore: "nl-NL" },
  { code: "no", name: "Norwegian", play: "no-NO", appstore: "no" },
  { code: "pl", name: "Polish", play: "pl-PL", appstore: "pl" },
  { code: "pt-BR", name: "Portuguese (Brazil)", play: "pt-BR", appstore: "pt-BR" },
  { code: "pt-PT", name: "Portuguese (Portugal)", play: "pt-PT", appstore: "pt-PT" },
  { code: "ro", name: "Romanian", play: "ro", appstore: "ro" },
  { code: "ru", name: "Russian", play: "ru-RU", appstore: "ru" },
  { code: "sk", name: "Slovak", play: "sk", appstore: "sk" },
  { code: "sv", name: "Swedish", play: "sv-SE", appstore: "sv" },
  { code: "th", name: "Thai", play: "th", appstore: "th" },
  { code: "tr", name: "Turkish", play: "tr-TR", appstore: "tr" },
  { code: "uk", name: "Ukrainian", play: "uk", appstore: "uk" },
  { code: "uz", name: "Uzbek", play: "uz" },
  { code: "vi", name: "Vietnamese", play: "vi", appstore: "vi" },
  { code: "zh-Hans", name: "Chinese (Simplified)", play: "zh-CN", appstore: "zh-Hans" },
  { code: "zh-Hant", name: "Chinese (Traditional)", play: "zh-TW", appstore: "zh-Hant" },
];

export function findLocale(code: string): LocaleDef | undefined {
  return LOCALES.find((l) => l.code === code);
}

export function toStoreLocale(store: StoreId, code: string): string | undefined {
  return findLocale(code)?.[store];
}

export function fromStoreLocale(store: StoreId, storeCode: string): string | undefined {
  return LOCALES.find((l) => l[store] === storeCode)?.code;
}
