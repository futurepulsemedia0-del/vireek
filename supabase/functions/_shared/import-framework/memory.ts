// supabase/functions/_shared/import-framework/memory.ts
//
// In-memory ImportStore + TargetSink. Used by the unit tests (with fault-injection hooks) and handy for
// local experiments. Tenant-bound exactly like the real implementations: a store/sink built for tenant A
// can never see tenant B's runs, items, effects or records.

import { StoreError, SinkTransientError } from "./types.ts";
import type {
  BatchSave, EffectRecord, ImportStore, ItemRecord, NewRun, RemoveOutcome, RestoreOutcome, RollbackState, RowErrorRecord,
  RunRecord, SinkWrite, TargetSink, Values,
} from "./types.ts";

export interface MemoryBackend {
  runs: Map<string, RunRecord>;
  items: Map<string, ItemRecord>;
  effects: Map<string, EffectRecord & { tenantId: string }>;
  errors: (RowErrorRecord & { runId: string; tenantId: string })[];
  seq: number;
}
export const createMemoryBackend = (): MemoryBackend => ({ runs: new Map(), items: new Map(), effects: new Map(), errors: [], seq: 0 });

export interface StoreHooks { beforeSaveBatch?: (b: BatchSave) => void | Promise<void> }

export function createMemoryStore(db: MemoryBackend, tenantId: string, hooks: StoreHooks = {}): ImportStore {
  const mine = (id: string): RunRecord | null => { const r = db.runs.get(id); return r && r.tenantId === tenantId ? r : null; };
  const itemKey = (scope: string, entity: string, key: string) => `${tenantId}|${scope}|${entity}|${key}`;
  const effKey = (runId: string, entity: string, key: string) => `${runId}|${entity}|${key}`;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    createRun(n: NewRun) {
      for (const r of db.runs.values()) if (r.tenantId === tenantId && r.scopeKey === n.scopeKey && (r.status === "running" || r.status === "paused")) throw new StoreError("RUN_IN_PROGRESS", "open run exists");
      const stamp = new Date(1_700_000_000_000 + ++db.seq * 1000).toISOString();
      const run: RunRecord = { ...clone(n), id: `run-${db.seq}`, tenantId, status: "running", checkpoint: { entityIndex: 0, cursor: null }, counters: {}, failure: null, createdAt: stamp, updatedAt: stamp, finishedAt: null, leaseOwner: null, leaseExpiresAt: null, rollbackSummary: null };
      db.runs.set(run.id, run);
      return Promise.resolve(clone(run));
    },
    getRun: (id) => Promise.resolve(mine(id) ? clone(mine(id)!) : null),
    findOpenRun: (scope) => Promise.resolve(clone([...db.runs.values()].find((r) => r.tenantId === tenantId && r.scopeKey === scope && (r.status === "running" || r.status === "paused")) ?? null)),
    listRuns: (scope) => Promise.resolve(clone([...db.runs.values()].filter((r) => r.tenantId === tenantId && r.scopeKey === scope).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)))),
    updateRun(id, patch) {
      const r = mine(id); if (!r) throw new StoreError("NOT_FOUND", "run");
      Object.assign(r, clone(patch), { updatedAt: new Date(1_700_000_000_000 + ++db.seq * 1000).toISOString() });
      return Promise.resolve();
    },
    acquireLease(id, owner, ttlMs, nowMs) {
      const r = mine(id); if (!r) return Promise.resolve(false);
      const live = r.leaseOwner && r.leaseOwner !== owner && r.leaseExpiresAt && Date.parse(r.leaseExpiresAt) > nowMs;
      if (live) return Promise.resolve(false);
      r.leaseOwner = owner; r.leaseExpiresAt = new Date(nowMs + ttlMs).toISOString();
      return Promise.resolve(true);
    },
    releaseLease(id, owner) { const r = mine(id); if (r && r.leaseOwner === owner) { r.leaseOwner = null; r.leaseExpiresAt = null; } return Promise.resolve(); },
    getItems(scope, entity, keys) {
      const out = new Map<string, ItemRecord>();
      for (const k of keys) { const it = db.items.get(itemKey(scope, entity, k)); if (it) out.set(k, clone(it)); }
      return Promise.resolve(out);
    },
    getEffects(runId, entity, keys) {
      const out = new Map<string, EffectRecord>();
      if (!mine(runId)) return Promise.resolve(out);
      for (const k of keys) { const e = db.effects.get(effKey(runId, entity, k)); if (e && e.tenantId === tenantId) out.set(k, clone(e)); }
      return Promise.resolve(out);
    },
    addEffects(effects) {
      for (const e of effects) {
        if (!mine(e.runId)) throw new StoreError("NOT_FOUND", "run");
        const k = effKey(e.runId, e.entity, e.sourceKey);
        if (!db.effects.has(k)) db.effects.set(k, { ...clone(e), tenantId });
      }
      return Promise.resolve();
    },
    async saveBatch(b) {
      await hooks.beforeSaveBatch?.(b);
      const r = mine(b.runId);
      if (!r) throw new StoreError("NOT_FOUND", "run");
      if (r.leaseOwner !== b.owner || !r.leaseExpiresAt || Date.parse(r.leaseExpiresAt) <= b.nowMs) throw new StoreError("LEASE_LOST", "lease lost");
      for (const it of b.items) db.items.set(itemKey(r.scopeKey, it.entity, it.sourceKey), clone(it));
      for (const e of b.errors) if (db.errors.filter((x) => x.runId === b.runId).length < 1000) db.errors.push({ ...clone(e), runId: b.runId, tenantId });
      r.checkpoint = clone(b.checkpoint); r.counters = clone(b.counters);
      r.leaseExpiresAt = new Date(b.nowMs + b.leaseTtlMs).toISOString();
    },
    listPendingEffects(runId, entity, limit) {
      if (!mine(runId)) return Promise.resolve([]);
      return Promise.resolve(clone([...db.effects.values()].filter((e) => e.runId === runId && e.tenantId === tenantId && e.entity === entity && e.rollbackState === null).slice(0, limit)));
    },
    resetBlockedEffects(runId) { for (const e of db.effects.values()) if (e.runId === runId && e.tenantId === tenantId && e.rollbackState === "blocked") e.rollbackState = null; return Promise.resolve(); },
    countRollbackStates(runId) {
      const es = [...db.effects.values()].filter((e) => e.runId === runId && e.tenantId === tenantId);
      return Promise.resolve({ blocked: es.filter((e) => e.rollbackState === "blocked").length, kept_modified: es.filter((e) => e.rollbackState === "kept_modified").length });
    },
    markRolledBack(runId, rows: { entity: string; sourceKey: string; state: RollbackState; invalidate: boolean }[]) {
      const r = mine(runId); if (!r) throw new StoreError("NOT_FOUND", "run");
      for (const x of rows) {
        const e = db.effects.get(effKey(runId, x.entity, x.sourceKey));
        if (e) e.rollbackState = x.state;
        if (x.invalidate) db.items.delete(itemKey(r.scopeKey, x.entity, x.sourceKey));
      }
      return Promise.resolve();
    },
  };
}

// ------------------------------------------------------------------ target sink

export interface MemoryTargetDb {
  records: Map<string, { key: string | null; values: Values }>;
  /** entity -> columns that are unique per tenant (emulates partial unique indexes). */
  unique: Record<string, string[]>;
  /** Fault injection. */
  transientFailures: number;
  rejectKeys: Set<string>;
  blockedIds: Set<string>;
  creates: number;
}
export const createMemoryTargetDb = (unique: Record<string, string[]> = {}): MemoryTargetDb => ({ records: new Map(), unique, transientFailures: 0, rejectKeys: new Set(), blockedIds: new Set(), creates: 0 });

export function createMemorySink(db: MemoryTargetDb, tenantId: string): TargetSink {
  const k = (entity: string, id: string) => `${tenantId}|${entity}|${id}`;
  const own = (entity: string) => [...db.records.entries()].filter(([key]) => key.startsWith(`${tenantId}|${entity}|`));
  const flaky = () => { if (db.transientFailures > 0) { db.transientFailures--; throw new SinkTransientError("simulated outage"); } };
  const pickCols = (v: Values, cols: readonly string[]): Values => Object.fromEntries(cols.map((c) => [c, v[c] ?? null]));
  const eq = (a: unknown, b: unknown) => (a == null && b == null) || String(a) === String(b);
  return {
    get(entity, id, columns) { flaky(); const r = db.records.get(k(entity, id)); return Promise.resolve(r ? { id, ...pickCols(r.values, columns) } : null); },
    findByKey(entity, key) { flaky(); const hit = own(entity).find(([, r]) => r.key === key); return Promise.resolve(hit ? { id: hit[0].split("|")[2], values: { ...hit[1].values } } : null); },
    findByField(entity, field, value) {
      flaky();
      const hit = own(entity).find(([, r]) => typeof r.values[field] === "string" && typeof value === "string" ? String(r.values[field]).toLowerCase() === value.toLowerCase() : r.values[field] === value);
      return Promise.resolve(hit ? { id: hit[0].split("|")[2] } : null);
    },
    create(entity, id, key, values): Promise<SinkWrite> {
      flaky();
      if (db.rejectKeys.has(key)) return Promise.resolve({ ok: false, code: "invalid", message: "rejected" });
      if (db.records.has(k(entity, id))) return Promise.resolve({ ok: false, code: "conflict", message: "pk" });
      for (const col of db.unique[entity] ?? []) {
        const v = values[col];
        if (v != null && own(entity).some(([, r]) => eq(r.values[col], v))) return Promise.resolve({ ok: false, code: "conflict", message: col });
      }
      db.creates++;
      db.records.set(k(entity, id), { key, values: { ...values } });
      return Promise.resolve({ ok: true });
    },
    update(entity, id, patch): Promise<SinkWrite> {
      flaky();
      const r = db.records.get(k(entity, id));
      if (!r) return Promise.resolve({ ok: false, code: "invalid", message: "missing" });
      Object.assign(r.values, patch);
      return Promise.resolve({ ok: true });
    },
    restore(entity, id, expect, restore): Promise<RestoreOutcome> {
      flaky();
      const r = db.records.get(k(entity, id));
      if (!r) return Promise.resolve("missing");
      if (Object.keys(restore).every((c) => eq(r.values[c], restore[c]))) return Promise.resolve("restored");
      if (!Object.keys(expect).every((c) => eq(r.values[c], expect[c]))) return Promise.resolve("modified");
      for (const [c, v] of Object.entries(restore)) { if (v === null) delete r.values[c]; else r.values[c] = v; }
      return Promise.resolve("restored");
    },
    remove(entity, id): Promise<RemoveOutcome> {
      flaky();
      if (!db.records.has(k(entity, id))) return Promise.resolve("missing");
      if (db.blockedIds.has(id)) return Promise.resolve("blocked");
      db.records.delete(k(entity, id));
      return Promise.resolve("deleted");
    },
  };
}
