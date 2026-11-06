import type { StoreClient, StoreListing, StoreSession } from "../types.js";
import { normalizeText } from "../../util/text.js";
import type { PlayApi, PlayListing } from "./client.js";

type PlayTextField = "title" | "shortDescription" | "fullDescription" | "video";

/** Field-registry key → Google Play Listing field. */
const FIELD_MAP: readonly (readonly [string, PlayTextField])[] = [
  ["title", "title"],
  ["short_description", "shortDescription"],
  ["full_description", "fullDescription"],
  ["video", "video"],
];

function fromPlay(listing: PlayListing): StoreListing {
  const fields: Record<string, string> = {};
  for (const [key, playKey] of FIELD_MAP) {
    const value = listing[playKey];
    if (typeof value === "string" && value.trim() !== "") fields[key] = normalizeText(value);
  }
  return { locale: listing.language, fields };
}

function toPlay(listing: StoreListing): PlayListing {
  const out: PlayListing = { language: listing.locale };
  for (const [key, playKey] of FIELD_MAP) {
    const value = listing.fields[key];
    if (value !== undefined) out[playKey] = value;
  }
  return out;
}

export function createPlayStore(api: PlayApi): StoreClient {
  return {
    store: "play",
    async open(): Promise<StoreSession> {
      const editId = await api.insertEdit();
      let closed = false;
      return {
        async listings() {
          return (await api.listListings(editId)).map(fromPlay);
        },
        async update(listing) {
          await api.updateListing(editId, toPlay(listing));
        },
        async commit() {
          await api.validateEdit(editId);
          await api.commitEdit(editId);
          closed = true;
        },
        async abort() {
          if (closed) return;
          closed = true;
          try {
            await api.deleteEdit(editId);
          } catch {
            // Best effort: an unused edit also expires on Google's side.
          }
        },
      };
    },
  };
}
