// supabase/functions/_shared/bi/reader.ts
//
// The ONE way BI features read account data: whitelisted columns from the Data Platform catalog,
// always scoped to the account owner id, always in a stable (updated_at, id) order so paging never
// skips or repeats a row. Used by the BI gateway (live access) and the export runner (files).

import { DATASETS, createPseudonymizer, selectList, transformRow, type DatasetKey, type PiiMode, type Pseudonymize } from "../data-platform/catalog.ts";
import { cursorFilter, type Cursor } from "../data-platform/warehouse.ts";
import type { Filter } from "./odata.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export type ReadMode =
  | { mode: "keyset"; cursor: Cursor }
  | { mode: "offset"; column: string; asc: boolean; offset: number };

export interface ReadOptions {
  ownerId: string;
  dataset: DatasetKey;
  filters?: readonly Filter[];
  read: ReadMode;
  limit: number;
}

// deno-lint-ignore no-explicit-any
function applyFilters(q: any, filters: readonly Filter[] | undefined) {
  for (const f of filters ?? []) {
    q = f.op === "eq" ? q.eq(f.column, f.value) : f.op === "ge" ? q.gte(f.column, f.value) : f.op === "gt" ? q.gt(f.column, f.value) : f.op === "le" ? q.lte(f.column, f.value) : q.lt(f.column, f.value);
  }
  return q;
}

/** One page of raw source rows (catalog columns only). */
export async function readRows(db: Db, o: ReadOptions): Promise<Record<string, unknown>[]> {
  const def = DATASETS[o.dataset];
  let q = applyFilters(db.from(def.source).select(selectList(o.dataset)).eq("user_id", o.ownerId), o.filters);
  if (o.read.mode === "keyset") {
    q = q.or(cursorFilter(o.read.cursor)).order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(o.limit);
  } else {
    q = q.order(o.read.column, { ascending: o.read.asc }).order("id", { ascending: true }).range(o.read.offset, o.read.offset + o.limit - 1);
  }
  const { data, error } = await q;
  if (error) throw new Error(`Could not read ${o.dataset}: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

export async function countRows(db: Db, ownerId: string, dataset: DatasetKey, filters?: readonly Filter[]): Promise<number> {
  const { count, error } = await applyFilters(db.from(DATASETS[dataset].source).select("id", { count: "exact", head: true }).eq("user_id", ownerId), filters);
  if (error) throw new Error(`Could not count ${dataset}: ${error.message}`);
  return count ?? 0;
}

export interface Shaper {
  /** Applies the personal-data mode. `meta: false` drops the warehouse bookkeeping columns. */
  shape(dataset: DatasetKey, row: Record<string, unknown>, meta: boolean): Promise<Record<string, unknown>>;
}

/** Same keyed pseudonymiser as the warehouse sync, so BI joins match warehouse tables. */
export async function createShaper(encryptionKey: string, ownerId: string, piiMode: PiiMode, now: () => Date = () => new Date()): Promise<Shaper> {
  const pseudonymize: Pseudonymize = await createPseudonymizer(encryptionKey, ownerId);
  return {
    async shape(dataset, row, meta) {
      const out = await transformRow(dataset, row, { accountId: ownerId, piiMode, pseudonymize, syncedAt: now().toISOString() });
      if (!meta) {
        delete out.account_id;
        delete out._vireek_synced_at;
        delete out._vireek_deleted;
      }
      return out;
    },
  };
}
