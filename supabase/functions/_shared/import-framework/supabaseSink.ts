// supabase/functions/_shared/import-framework/supabaseSink.ts
//
// TargetSink on the real tables, via the CALLER's JWT client (RLS applies) and ALWAYS filtered by
// user_id = account owner. Tables/columns come from EntityDefinitions only (allow-list): a request can
// never name a table or column. No upsert-by-id exists here, so a crafted id can never touch a row of
// another tenant. Writes carry external_source = "fw:<scope>" + external_id = source key, which also
// gives the existing unique index (user_id, external_source, external_id) as a second idempotency net.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { valuesEqual } from "./engine.ts";
import { SinkTransientError } from "./types.ts";
import type { EntityDefinitions, RemoveOutcome, RestoreOutcome, SinkWrite, TargetSink, Values } from "./types.ts";

/** Per-table extras this module sets on insert / knows about. Mirrors what the Import Wizard writes. */
const TABLE_CONFIG: Record<string, { insertExtras: Values; softDeleteColumn?: string }> = {
  customers: { insertExtras: { lifecycle_stage: "active", source: "import" }, softDeleteColumn: "deleted_at" },
  jobs: { insertExtras: {} },
};

type PgErr = { message: string; code?: string };
/** SQLSTATE classes 22 (data), 23 (integrity), 42 (rights/syntax) are permanent; everything else is retried. */
const permanent = (e: PgErr): boolean => !!e.code && /^(22|23|42)/.test(e.code);
const escLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createSupabaseSink(client: SupabaseClient, ownerId: string, defs: EntityDefinitions, scopeKey: string): TargetSink {
  const externalSource = `fw:${scopeKey}`.slice(0, 60);
  const table = (entity: string): string => {
    const t = defs[entity]?.table;
    if (!t || !TABLE_CONFIG[t]) throw new Error(`Entity "${entity}" is not importable.`);
    return t;
  };
  const columns = (entity: string): Set<string> => {
    const d = defs[entity];
    return new Set(["id", ...Object.keys(d.fields), ...Object.values(d.references ?? {}).map((r) => r.target)]);
  };
  const safeCols = (entity: string, cols: readonly string[]): string => {
    const ok = columns(entity);
    const bad = cols.find((c) => !ok.has(c));
    if (bad) throw new Error(`Column "${bad}" is not importable.`);
    return [...new Set(["id", ...cols])].join(",");
  };
  const check = (e: PgErr | null): void => { if (e && !permanent(e)) throw new SinkTransientError(e.message); };

  return {
    async get(entity, id, cols) {
      const { data, error } = await client.from(table(entity)).select(safeCols(entity, cols)).eq("id", id).eq("user_id", ownerId).maybeSingle();
      check(error); if (error) throw new Error(error.message);
      return (data as unknown as Values | null) ?? null;
    },
    async findByKey(entity, key) {
      const { data, error } = await client.from(table(entity)).select("*").eq("user_id", ownerId).eq("external_source", externalSource).eq("external_id", key).maybeSingle();
      check(error); if (error) throw new Error(error.message);
      const row = data as unknown as (Values & { id: string }) | null;
      return row ? { id: row.id, values: row } : null;
    },
    async findByField(entity, field, value) {
      if (!(defs[entity].matchKeys ?? []).includes(field)) throw new Error(`"${field}" is not a match key.`);
      const t = table(entity);
      let q = client.from(t).select("id").eq("user_id", ownerId);
      const sd = TABLE_CONFIG[t].softDeleteColumn;
      if (sd) q = q.is(sd, null);
      q = typeof value === "string" ? q.ilike(field, escLike(value)) : q.eq(field, value as never);
      const { data, error } = await q.limit(1);
      check(error); if (error) throw new Error(error.message);
      const row = (data as unknown as { id: string }[] | null)?.[0];
      return row ? { id: row.id } : null;
    },
    async create(entity, id, key, values): Promise<SinkWrite> {
      const t = table(entity);
      safeCols(entity, Object.keys(values));
      const { error } = await client.from(t).insert({ ...TABLE_CONFIG[t].insertExtras, ...values, id, user_id: ownerId, external_source: externalSource, external_id: key });
      if (!error) return { ok: true };
      check(error);
      return { ok: false, code: error.code === "23505" ? "conflict" : "invalid", message: error.message.slice(0, 200) };
    },
    async update(entity, id, patch): Promise<SinkWrite> {
      safeCols(entity, Object.keys(patch));
      const { data, error } = await client.from(table(entity)).update(patch).eq("id", id).eq("user_id", ownerId).select("id");
      if (!error) return (data ?? []).length === 1 ? { ok: true } : { ok: false, code: "invalid", message: "record not found" };
      check(error);
      return { ok: false, code: error.code === "23505" ? "conflict" : "invalid", message: error.message.slice(0, 200) };
    },
    async restore(entity, id, expect, restore): Promise<RestoreOutcome> {
      const cols = [...new Set([...Object.keys(expect), ...Object.keys(restore)])];
      const cur = await this.get(entity, id, cols);
      if (!cur) return "missing";
      if (Object.keys(restore).every((c) => valuesEqual(cur[c], restore[c]))) return "restored";
      if (!Object.keys(expect).every((c) => valuesEqual(cur[c], expect[c]))) return "modified";
      const { error } = await client.from(table(entity)).update(restore).eq("id", id).eq("user_id", ownerId);
      check(error); if (error) throw new Error(error.message);
      return "restored";
    },
    async remove(entity, id): Promise<RemoveOutcome> {
      const { data, error } = await client.from(table(entity)).delete().eq("id", id).eq("user_id", ownerId).select("id");
      if (!error) return (data ?? []).length === 1 ? "deleted" : "missing";
      if (error.code === "23503") return "blocked"; // other records still reference it
      check(error);
      return "blocked";
    },
  };
}
