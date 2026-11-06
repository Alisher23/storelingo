export type StoreId = "play" | "appstore";
export const STORES: readonly StoreId[] = ["play", "appstore"];

export type FieldKind = "text" | "keywords" | "url" | "changelog";

export interface FieldDef {
  store: StoreId;
  key: string;
  /** Path inside the locale folder. For `changelog` it is the directory name. */
  file: string;
  maxChars: number | null;
  translatable: boolean;
  required: boolean;
  kind: FieldKind;
}

const text = (store: StoreId, key: string, maxChars: number, required: boolean): FieldDef => ({
  store,
  key,
  file: `${key}.txt`,
  maxChars,
  translatable: true,
  required,
  kind: "text",
});

const url = (store: StoreId, key: string): FieldDef => ({
  store,
  key,
  file: `${key}.txt`,
  maxChars: null,
  translatable: false,
  required: false,
  kind: "url",
});

/**
 * Store listing fields. Limits are data so contributors can update them
 * without touching logic. Sources: Play Console Help, App Store Connect Help.
 */
export const FIELDS: readonly FieldDef[] = [
  text("play", "title", 30, true),
  text("play", "short_description", 80, true),
  text("play", "full_description", 4000, true),
  {
    store: "play",
    key: "changelog",
    file: "changelogs",
    maxChars: 500,
    translatable: true,
    required: false,
    kind: "changelog",
  },
  url("play", "video"),

  text("appstore", "name", 30, true),
  text("appstore", "subtitle", 30, false),
  {
    store: "appstore",
    key: "keywords",
    file: "keywords.txt",
    maxChars: 100,
    translatable: true,
    required: true,
    kind: "keywords",
  },
  text("appstore", "promotional_text", 170, false),
  text("appstore", "description", 4000, true),
  text("appstore", "release_notes", 4000, false),
  url("appstore", "marketing_url"),
  url("appstore", "support_url"),
  url("appstore", "privacy_url"),
];

export function fieldsFor(store: StoreId): FieldDef[] {
  return FIELDS.filter((f) => f.store === store);
}

export function getField(store: StoreId, key: string): FieldDef {
  const field = FIELDS.find((f) => f.store === store && f.key === key);
  if (!field) throw new Error(`Unknown field ${store}/${key}`);
  return field;
}
