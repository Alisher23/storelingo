import { StorelingoError } from "../../src/errors.js";
import type { StoreId } from "../../src/fields/registry.js";
import type { StoreClient, StoreListing } from "../../src/stores/types.js";

export interface FakeStoreState {
  remote: StoreListing[];
  opened: number;
  aborted: number;
  committed: number;
  updates: StoreListing[];
}

/** In-memory Google Play-like store: updates become visible only after commit(). */
export function fakeStore(
  initial: StoreListing[],
  opts: {
    failOn?: "update" | "commit";
    store?: StoreId;
    atomic?: boolean;
    writable?: (field: string, locale?: string) => boolean;
    skipReason?: (field: string, locale?: string) => string | undefined;
    notes?: string[];
    failOnLocale?: string;
  } = {},
): { client: StoreClient; state: FakeStoreState } {
  const state: FakeStoreState = { remote: structuredClone(initial), opened: 0, aborted: 0, committed: 0, updates: [] };
  const client: StoreClient = {
    store: opts.store ?? "play",
    async open() {
      state.opened++;
      const pending: StoreListing[] = [];
      let closed = false;
      return {
        ...(opts.atomic !== undefined ? { atomic: opts.atomic } : {}),
        ...(opts.writable ? { isWritable: opts.writable } : {}),
        ...(opts.skipReason ? { skipReason: opts.skipReason } : {}),
        ...(opts.notes ? { notes: opts.notes } : {}),
        async listings() {
          return structuredClone(state.remote);
        },
        async update(listing) {
          if (opts.failOn === "update") throw new StorelingoError("E_STORE", "Google Play API error 400: boom");
          if (opts.failOnLocale === listing.locale) {
            throw new StorelingoError("E_STORE", `API error 400: boom for ${listing.locale}`);
          }
          pending.push(structuredClone(listing));
          state.updates.push(structuredClone(listing));
        },
        async commit() {
          if (opts.failOn === "commit") throw new StorelingoError("E_IN_REVIEW", "changes already in review");
          for (const listing of pending) {
            const i = state.remote.findIndex((r) => r.locale === listing.locale);
            if (i >= 0) state.remote[i] = listing;
            else state.remote.push(listing);
          }
          state.committed++;
          closed = true;
        },
        async abort() {
          if (closed) return;
          closed = true;
          state.aborted++;
        },
      };
    },
  };
  return { client, state };
}
