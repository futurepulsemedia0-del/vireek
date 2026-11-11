// supabase/functions/_shared/import-framework/supabaseStore.ts
//
// ImportStore on Postgres (migration 20290210000000_import_framework.sql). Built on the CALLER's JWT
// client, so RLS + can_run_data_imports() + the module gate apply to every statement; every query is
// ALSO filtered by the tenant explicitly (defence in depth). No service-role key is used anywhere.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { StoreError } from "./types.ts";
import type {
  BatchSave, Checkpoint, Counters, EffectRecord, ImportStore, ItemRecord, MappingConfig, NewRun, RollbackState, RollbackSummary, RunRecord, RunStatus, Values,
} from "./types.ts";

const CHUNK = 200;
type Err = { message: string; code?: string } | null;
const fail = (e: NonNullable<Err>): never => {
  if (/LEASE_LOST/.test(e.message)) throw new StoreError("LEASE_LOST", "lease lost");
  if (/NOT_FOUND/.test(e.message)) throw new StoreError("NOT_FOUND", "not found");
  if (e.code === "23505") throw new StoreError("RUN_IN_PROGRESS", "open run exists");
  throw new StoreError("UNAVAILABLE", e.message);
};

interface RunRow {
  id: string; user_id: string; scope_key: string; adapter_id: string; adapter_version: string; source_fingerprint: string; mapping_hash: string;
  mapping: MappingConfig; actor_id: string | null; status: RunStatus; checkpoint: Checkpoint; counters: Counters; failure: string | null;
  lease_owner: string | null; lease_expires_at: string | null; rollback_summary: RollbackSummary | null; created_at: string; updated_at: string; finished_at: string | null;
}
const toRun = (r: RunRow): RunRecord => ({
  id: r.id, tenantId: r.user_id, scopeKey: r.scope_key, adapterId: r.adapter_id, adapterVersion: r.adapter_version, sourceFingerprint: r.source_fingerprint,
  mappingHash: r.mapping_hash, mapping: r.mapping, actorId: r.actor_id, status: r.status, checkpoint: r.checkpoint, counters: r.counters, failure: r.failure,
  createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at, leaseOwner: r.lease_owner, leaseExpiresAt: r.lease_expires_at, rollbackSummary: r.rollback_summary,
});
interface EffRow { run_id: string; entity: string; source_key: string; action: "created" | "updated"; target_id: string; before_values: Values | null; after_values: Values | null; rollback_state: RollbackState | null }
const toEff = (r: EffRow): EffectRecord => ({ runId: r.run_id, entity: r.entity, sourceKey: r.source_key, action: r.action, targetId: r.target_id, before: r.before_values, after: r.after_values, rollbackState: r.rollback_state });

export function createSupabaseStore(client: SupabaseClient, ownerId: string): ImportStore {
  const runs = () => client.from("import_fw_runs");
  async function one(id: string): Promise<RunRecord | null> {
    const { data, error } = await runs().select("*").eq("id", id).eq("user_id", ownerId).maybeSingle();
    if (error) fail(error);
    return data ? toRun(data as unknown as RunRow) : null;
  }
  return {
    async createRun(n: NewRun) {
      const { data, error } = await runs().insert({
        user_id: ownerId, scope_key: n.scopeKey, adapter_id: n.adapterId, adapter_version: n.adapterVersion, source_fingerprint: n.sourceFingerprint,
        mapping_hash: n.mappingHash, mapping: n.mapping, actor_id: n.actorId,
      }).select("*").single();
      if (error) fail(error);
      return toRun(data as unknown as RunRow);
    },
    getRun: one,
    async findOpenRun(scopeKey) {
      const { data, error } = await runs().select("*").eq("user_id", ownerId).eq("scope_key", scopeKey).in("status", ["running", "paused"]).limit(1);
      if (error) fail(error);
      const r = (data as unknown as RunRow[] | null)?.[0];
      return r ? toRun(r) : null;
    },
    async listRuns(scopeKey) {
      const { data, error } = await runs().select("*").eq("user_id", ownerId).eq("scope_key", scopeKey).order("created_at", { ascending: false }).limit(100);
      if (error) fail(error);
      return ((data ?? []) as unknown as RunRow[]).map(toRun);
    },
    async updateRun(id, patch) {
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.failure !== undefined) row.failure = patch.failure;
      if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt;
      if (patch.rollbackSummary !== undefined) row.rollback_summary = patch.rollbackSummary;
      if (patch.checkpoint !== undefined) row.checkpoint = patch.checkpoint;
      if (patch.counters !== undefined) row.counters = patch.counters;
      const { error } = await runs().update(row).eq("id", id).eq("user_id", ownerId);
      if (error) fail(error);
    },
    async acquireLease(id, owner, ttlMs) {
      const { data, error } = await client.rpc("import_fw_acquire_lease", { p_run_id: id, p_owner: owner, p_ttl_ms: ttlMs });
      if (error) fail(error);
      return data === true;
    },
    async releaseLease(id, owner) {
      const { error } = await runs().update({ lease_owner: null, lease_expires_at: null }).eq("id", id).eq("user_id", ownerId).eq("lease_owner", owner);
      if (error) fail(error);
    },
    async getItems(scopeKey, entity, keys) {
      const out = new Map<string, ItemRecord>();
      for (let i = 0; i < keys.length; i += CHUNK) {
        const { data, error } = await client.from("import_fw_items").select("entity,source_key,fingerprint,target_id,status,run_id,position")
          .eq("user_id", ownerId).eq("scope_key", scopeKey).eq("entity", entity).in("source_key", keys.slice(i, i + CHUNK));
        if (error) fail(error);
        for (const r of (data ?? []) as unknown as { entity: string; source_key: string; fingerprint: string; target_id: string | null; status: ItemRecord["status"]; run_id: string; position: number }[]) {
          out.set(r.source_key, { entity: r.entity, sourceKey: r.source_key, fingerprint: r.fingerprint, targetId: r.target_id, status: r.status, runId: r.run_id, position: r.position });
        }
      }
      return out;
    },
    async getEffects(runId, entity, keys) {
      const out = new Map<string, EffectRecord>();
      for (let i = 0; i < keys.length; i += CHUNK) {
        const { data, error } = await client.from("import_fw_effects").select("*").eq("user_id", ownerId).eq("run_id", runId).eq("entity", entity).in("source_key", keys.slice(i, i + CHUNK));
        if (error) fail(error);
        for (const r of (data ?? []) as unknown as EffRow[]) out.set(r.source_key, toEff(r));
      }
      return out;
    },
    async addEffects(effects) {
      for (let i = 0; i < effects.length; i += CHUNK) {
        const rows = effects.slice(i, i + CHUNK).map((e) => ({ run_id: e.runId, user_id: ownerId, entity: e.entity, source_key: e.sourceKey, action: e.action, target_id: e.targetId, before_values: e.before, after_values: e.after }));
        const { error } = await client.from("import_fw_effects").upsert(rows, { onConflict: "run_id,entity,source_key", ignoreDuplicates: true });
        if (error) fail(error);
      }
    },
    async saveBatch(b: BatchSave) {
      const { error } = await client.rpc("import_fw_save_batch", {
        p_run_id: b.runId, p_owner: b.owner,
        p_items: b.items.map((i) => ({ entity: i.entity, source_key: i.sourceKey, fingerprint: i.fingerprint, target_id: i.targetId, status: i.status, position: i.position })),
        p_errors: b.errors.map((e) => ({ entity: e.entity, source_key: e.sourceKey, position: e.position, code: e.code, message: e.message })),
        p_checkpoint: b.checkpoint, p_counters: b.counters, p_ttl_ms: b.leaseTtlMs,
      });
      if (error) fail(error);
    },
    async listPendingEffects(runId, entity, limit) {
      const { data, error } = await client.from("import_fw_effects").select("*").eq("user_id", ownerId).eq("run_id", runId).eq("entity", entity).is("rollback_state", null).limit(limit);
      if (error) fail(error);
      return ((data ?? []) as unknown as EffRow[]).map(toEff);
    },
    async resetBlockedEffects(runId) {
      const { error } = await client.from("import_fw_effects").update({ rollback_state: null }).eq("user_id", ownerId).eq("run_id", runId).eq("rollback_state", "blocked");
      if (error) fail(error);
    },
    async countRollbackStates(runId) {
      const count = async (state: RollbackState): Promise<number> => {
        const { count: n, error } = await client.from("import_fw_effects").select("*", { count: "exact", head: true }).eq("user_id", ownerId).eq("run_id", runId).eq("rollback_state", state);
        if (error) fail(error);
        return n ?? 0;
      };
      return { blocked: await count("blocked"), kept_modified: await count("kept_modified") };
    },
    async markRolledBack(runId, rows) {
      const run = await one(runId);
      if (!run) throw new StoreError("NOT_FOUND", "run");
      const groups = new Map<string, { entity: string; state: RollbackState; invalidate: boolean; keys: string[] }>();
      for (const r of rows) {
        const g = `${r.entity}|${r.state}|${r.invalidate}`;
        const cur = groups.get(g) ?? { entity: r.entity, state: r.state, invalidate: r.invalidate, keys: [] };
        cur.keys.push(r.sourceKey); groups.set(g, cur);
      }
      for (const g of groups.values()) for (let i = 0; i < g.keys.length; i += CHUNK) {
        const keys = g.keys.slice(i, i + CHUNK);
        const u = await client.from("import_fw_effects").update({ rollback_state: g.state }).eq("user_id", ownerId).eq("run_id", runId).eq("entity", g.entity).in("source_key", keys);
        if (u.error) fail(u.error);
        if (g.invalidate) {
          const d = await client.from("import_fw_items").delete().eq("user_id", ownerId).eq("scope_key", run.scopeKey).eq("entity", g.entity).in("source_key", keys);
          if (d.error) fail(d.error);
        }
      }
    },
  };
}
