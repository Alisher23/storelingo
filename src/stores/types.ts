import type { StoreId } from "../fields/registry.js";

/** One locale's listing. `locale` is the store's own code; `fields` are keyed by field-registry keys. */
export interface StoreListing {
  locale: string;
  fields: Record<string, string>;
}

/** One unit of work against a store (for Google Play: one edit). */
export interface StoreSession {
  listings(): Promise<StoreListing[]>;
  /** Replaces the listing for `listing.locale` with exactly these fields. */
  update(listing: StoreListing): Promise<void>;
  /** Validates and publishes every update made in this session. */
  commit(): Promise<void>;
  /** Discards the session. Never throws; a no-op after commit() or a previous abort(). */
  abort(): Promise<void>;
  /** False when updates apply immediately and one by one (no commit/rollback). Default: true. */
  readonly atomic?: boolean;
  /** Whether this session can write the field; undefined means every field is writable. */
  isWritable?(field: string): boolean;
  /** Why a non-writable field is skipped, shown as `skipped (<reason>)`; undefined falls back to a generic reason. */
  skipReason?(field: string): string | undefined;
  /** Human-readable facts about this session to show before the diff (e.g. "no editable version"). */
  readonly notes?: readonly string[];
}

export interface StoreClient {
  readonly store: StoreId;
  open(): Promise<StoreSession>;
}
