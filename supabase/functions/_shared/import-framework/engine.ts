// supabase/functions/_shared/import-framework/engine.ts
//
// The engine: dry-run, commit (idempotent + resumable) and rollback.
//
// Guarantees (each is covered by engine.test.ts):
//  * DRY-RUN has no side effects: it only reads (source, ledger, target) and returns a report.
//  * IDEMPOTENT: every source row has a stable key; a ledger item stores the fingerprint of what was
//    last applied, so re-running an unchanged file changes nothing and a changed row becomes ONE update.
//    New records get a DETERMINISTIC id (tenant+scope+entity+key), so even a lost ledger cannot create
//    a duplicate: the retried create hits the same primary key / external id.
//  * RESUMABLE: progress is a (entityIndex, cursor) checkpoint saved atomically with the batch's items.
//    A crash mid-batch re-reads that batch; the write-ahead effects make the retry exact.
//  * ROLLBACK is exact: effects are written BEFORE the target is touched, deletions are refused for
//    rows edited since the import, and the ledger item is dropped so a later run re-evaluates the row.
//  * TENANT SAFE: the engine never sees another tenant's data; store and sink are tenant-bound objects.

import { deterministicUuid, fingerprintOf } from "./hash.ts";
import { entityOrder, mapRecord, mappingHash, validateMapping } from "./mapping.ts";
import { ReportBuilder, emptyCounters } from "./report.ts";
import type { ValidationReport } from "./report.ts";
import {
  ImportError, SinkTransientError, StoreError,
} from "./types.ts";
import type {
  Checkpoint, Counters, DedupeStrategy, EffectRecord, EntityDefinitions, ImportStore, Issue, ItemRecord, MappingConfig,
  RollbackState, RollbackSummary, RowErrorRecord, RunRecord, RunStatus, SourceAdapter, SourceRecord, TargetSink, Values,
} from "./types.ts";

const LEASE_TTL_MS = 120_000;
const BREAKER_MIN_ROWS = 50;
const READ_CONCURRENCY = 8;

export interface RunOptions {
  tenantId: string;
  actorId: string | null;
  /** Names one migration ("acme-2027-q1"). All runs with the same scope share one idempotency ledger. */
  scopeKey: string;
  adapter: SourceAdapter;
  mapping: MappingConfig;
  defs: EntityDefinitions;
  sink: TargetSink;
  store: ImportStore;
  mode: "dry_run" | "commit";
  resumeRunId?: string;
  batchSize?: number;
  /** Absolute epoch ms. When reached the run pauses (commit) or the report is marked incomplete (dry-run). */
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  workerId?: string;
  sampleLimit?: number;
}
export interface RunOutcome {
  runId: string | null;
  status: RunStatus | "dry_run";
  complete: boolean;
  checkpoint: Checkpoint;
  failure: string | null;
  report: ValidationReport;
}

const zeroSummary = (): RollbackSummary => ({ deleted: 0, restored: 0, keptModified: 0, blocked: 0, missing: 0 });
const hasErr = (issues: Issue[]): boolean => issues.some((i) => i.severity === "error");
const isoNow = (n: () => number): string => new Date(n()).toISOString();
const newWorkerId = (prefix: string): string => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export function valuesEqual(a: unknown, b: unknown): boolean { return same(a, b); }
function same(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof b === "number" || typeof a === "number") return Number(a) === Number(b);
  if (typeof a === "string" && typeof b === "string" && /^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b)) return Date.parse(a) === Date.parse(b);
  return String(a) === String(b);
}
const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Which columns would change, per the dedupe strategy. */
export function computePatch(cur: Values, next: Values, strategy: DedupeStrategy): Values {
  const patch: Values = {};
  if (strategy === "skip") return patch;
  for (const [k, v] of Object.entries(next)) {
    if (same(cur[k], v)) continue;
    if (strategy === "fill_blanks" && !blank(cur[k])) continue;
    patch[k] = v;
  }
  return patch;
}
const pick = (src: Values, keys: string[]): Values => Object.fromEntries(keys.map((k) => [k, src[k] ?? null]));

async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (!(e instanceof SinkTransientError) || attempt >= 2) throw e;
      await sleep(100 * 2 ** attempt);
    }
  }
}

/** Every sink call is retried on transient failures (3 attempts, exponential backoff). */
function retrying(sink: TargetSink, sleep: (ms: number) => Promise<void>): TargetSink {
  return {
    get: (...a) => withRetry(() => sink.get(...a), sleep),
    findByKey: (...a) => withRetry(() => sink.findByKey(...a), sleep),
    findByField: (...a) => withRetry(() => sink.findByField(...a), sleep),
    create: (...a) => withRetry(() => sink.create(...a), sleep),
    update: (...a) => withRetry(() => sink.update(...a), sleep),
    restore: (...a) => withRetry(() => sink.restore(...a), sleep),
    remove: (...a) => withRetry(() => sink.remove(...a), sleep),
  };
}

interface Work {
  rec: SourceRecord;
  key: string | null;
  values: Values;
  refs: Record<string, string>;
  issues: Issue[];
  action: "create" | "update" | "unchanged" | "skipped" | "error";
  fp: string;
  targetId: string | null;
  patch?: Values;
  before?: Values;
  effect?: EffectRecord;
  applied?: boolean;
  noItem?: boolean;
}

// ===================================================================== run

export async function runImport(o: RunOptions): Promise<RunOutcome> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const commit = o.mode === "commit";
  const batchSize = Math.min(1000, Math.max(1, Math.floor(o.batchSize ?? 200)));
  const worker = o.workerId ?? newWorkerId("w");
  const sink = retrying(o.sink, sleep);
  const srcFp = o.adapter.fingerprint();
  const mv = validateMapping(o.mapping, o.defs, o.adapter);
  const mappingIssues = mv.issues;
  const mHash = mv.ok ? mappingHash(o.mapping) : "";
  const base = { schemaVersion: 1 as const, generatedAt: isoNow(now), adapter: { id: o.adapter.id, version: o.adapter.version }, scopeKey: o.scopeKey, sourceFingerprint: srcFp, mappingHash: mHash, mode: o.mode };
  if (!mv.ok) {
    if (commit) throw new ImportError("MAPPING_INVALID", "The mapping is invalid.", mappingIssues);
    const b = new ReportBuilder({}, 0);
    return { runId: null, status: "dry_run", complete: true, checkpoint: { entityIndex: 0, cursor: null }, failure: null,
      report: { ...base, complete: true, mappingIssues, entities: {}, totals: b.totals(), samples: [], samplesTruncated: false, canCommit: false, blockers: ["MAPPING_INVALID"] } };
  }
  const dedupe: DedupeStrategy = o.mapping.options?.dedupe ?? "fill_blanks";
  const tz = o.mapping.options?.timezone ?? "UTC";
  const maxRatio = o.mapping.options?.maxErrorRatio ?? 0.25;
  const allowPositional = o.mapping.options?.allowPositionalKeys === true;
  const order = entityOrder(o.mapping, o.defs);

  // ---- run bookkeeping (commit only)
  let run: RunRecord | null = null;
  if (commit) {
    if (o.resumeRunId) {
      run = await o.store.getRun(o.resumeRunId);
      if (!run) throw new ImportError("RUN_NOT_FOUND", "Run not found.");
      if (run.scopeKey !== o.scopeKey) throw new ImportError("RUN_NOT_FOUND", "Run not found.");
      if (run.status !== "paused" && run.status !== "running") throw new ImportError("RUN_NOT_RESUMABLE", `A run in status "${run.status}" cannot be resumed.`);
    } else {
      const open = await o.store.findOpenRun(o.scopeKey);
      if (open) {
        const leaseLive = open.leaseOwner !== null && open.leaseExpiresAt !== null && Date.parse(open.leaseExpiresAt) > now();
        if (leaseLive) throw new ImportError("RUN_BUSY", "Another import for this migration is running right now.");
        if (open.sourceFingerprint === srcFp && open.mappingHash === mHash) run = open;
        else await o.store.updateRun(open.id, { status: "failed", failure: "SUPERSEDED", finishedAt: isoNow(now) });
      }
    }
    if (run && run.sourceFingerprint !== srcFp) throw new ImportError("SOURCE_CHANGED", "The source file changed since this run started; start a new run instead.");
    if (run && run.mappingHash !== mHash) throw new ImportError("MAPPING_CHANGED", "The mapping changed since this run started; start a new run instead.");
    if (!run) {
      try {
        run = await o.store.createRun({ scopeKey: o.scopeKey, adapterId: o.adapter.id, adapterVersion: o.adapter.version, sourceFingerprint: srcFp, mappingHash: mHash, mapping: o.mapping, actorId: o.actorId });
      } catch (e) {
        if (e instanceof StoreError && e.code === "RUN_IN_PROGRESS") throw new ImportError("RUN_BUSY", "Another import for this migration is running right now.");
        throw e;
      }
    }
    if (!(await o.store.acquireLease(run.id, worker, LEASE_TTL_MS, now()))) throw new ImportError("RUN_BUSY", "Another worker holds this run.");
  }

  const rb = new ReportBuilder(run?.counters ?? {}, o.sampleLimit ?? 200);
  let cp: Checkpoint = run?.checkpoint ?? { entityIndex: 0, cursor: null };
  // Last state that was durably saved with a batch. Only this may be persisted when a run stops abnormally.
  let saved: { cp: Checkpoint; counters: Counters } = { cp, counters: JSON.parse(JSON.stringify(rb.counters)) as Counters };
  const targets = new Map<string, Map<string, string>>();
  const seen = new Map<string, Set<string>>();
  const matchSeen = new Map<string, Map<string, string>>();
  let complete = true;
  let failure: string | null = null;
  let status: RunStatus | "dry_run" = commit ? "running" : "dry_run";

  const setTarget = (entity: string, key: string, id: string) => { let m = targets.get(entity); if (!m) targets.set(entity, (m = new Map())); m.set(key, id); };

  async function processBatch(entity: string, records: SourceRecord[]): Promise<{ items: ItemRecord[]; errors: RowErrorRecord[] }> {
    const def = o.defs[entity];
    const em = o.mapping.entities[entity];
    const summable = Object.entries(def.fields).filter(([, f]) => f.summable).map(([k]) => k);
    const seenKeys = seen.get(entity) ?? (seen.set(entity, new Set()), seen.get(entity)!);

    // 1. map + in-file duplicate checks (sequential: order matters)
    const work: Work[] = records.map((rec) => {
      const m = mapRecord(em, def, rec.data, tz);
      const w: Work = { rec, key: m.key, values: m.values, refs: m.refs, issues: m.issues, action: "error", fp: "", targetId: null };
      if (w.key === null && !hasErr(w.issues)) {
        if (allowPositional) { w.key = `row-${rec.position}`; w.issues.push({ severity: "warning", code: "KEY_POSITIONAL", message: "No source key: the row position is used, so re-imports of a changed file are not idempotent." }); }
        else w.issues.push({ severity: "error", code: "KEY_MISSING", field: "key", message: "The row has no source key." });
      }
      if (w.key !== null && !hasErr(w.issues)) {
        if (seenKeys.has(w.key)) { w.action = "skipped"; w.issues.push({ severity: "warning", code: "DUPLICATE_KEY", message: "Another row in the file has the same key; this one was skipped (first row wins)." }); }
        else {
          seenKeys.add(w.key);
          for (const mk of def.matchKeys ?? []) {
            const v = w.values[mk];
            if (v === undefined || v === null) continue;
            const mm = matchSeen.get(`${entity}.${mk}`) ?? (matchSeen.set(`${entity}.${mk}`, new Map()), matchSeen.get(`${entity}.${mk}`)!);
            const vk = String(v).toLowerCase();
            const other = mm.get(vk);
            if (other !== undefined && other !== w.key) w.issues.push({ severity: "error", code: "MATCH_KEY_DUPLICATE_IN_FILE", field: mk, message: `Another row with a different key uses the same ${mk}.` });
            else mm.set(vk, w.key);
          }
        }
      }
      return w;
    });

    const live = work.filter((w) => w.action !== "skipped" && w.key !== null && !hasErr(w.issues));
    const keys = live.map((w) => w.key!);
    const items = keys.length ? await o.store.getItems(o.scopeKey, entity, keys) : new Map<string, ItemRecord>();
    const effects = commit && keys.length ? await o.store.getEffects(run!.id, entity, keys) : new Map<string, EffectRecord>();

    // 2. cross-entity references -> target ids
    const need = new Map<string, Set<string>>();
    for (const w of live) for (const [f, srcKey] of Object.entries(w.refs)) {
      const r = def.references![f];
      if (!targets.get(r.entity)?.has(srcKey)) { let s = need.get(r.entity); if (!s) need.set(r.entity, (s = new Set())); s.add(srcKey); }
    }
    for (const [refEntity, ks] of need) {
      const found = await o.store.getItems(o.scopeKey, refEntity, [...ks]);
      for (const [k, it] of found) if (it.targetId && it.status !== "error") setTarget(refEntity, k, it.targetId);
    }
    for (const w of live) for (const [f, srcKey] of Object.entries(w.refs)) {
      const r = def.references![f];
      const id = targets.get(r.entity)?.get(srcKey);
      if (id) w.values[r.target] = id;
      else w.issues.push({ severity: "error", code: "REF_NOT_FOUND", field: f, message: `Refers to a ${r.entity} record that was not imported (missing, rejected or skipped).` });
    }

    // 3. decide the action per row (reads only)
    await mapLimit(live, READ_CONCURRENCY, async (w) => {
      if (hasErr(w.issues)) { w.action = "error"; return; }
      const key = w.key!;
      w.fp = fingerprintOf({ v: w.values, d: dedupe });
      const item = items.get(key);
      const eff = effects.get(key);
      if (item && item.runId === (run?.id ?? "") && item.status !== "error" && item.position < w.rec.position) {
        w.action = "skipped"; w.issues.push({ severity: "warning", code: "DUPLICATE_KEY", message: "Another row in the file has the same key; this one was skipped (first row wins)." }); return;
      }
      if (eff?.action === "created") { w.action = "create"; w.targetId = eff.targetId; w.effect = eff; return; }
      if (item && item.status !== "error" && item.fingerprint === w.fp && !eff) { w.action = "unchanged"; w.targetId = item.targetId; return; }
      let targetId = item && item.status !== "error" ? item.targetId : null;
      if (!targetId) targetId = (await sink.findByKey(entity, key))?.id ?? null;
      if (!targetId) {
        const id = deterministicUuid(o.tenantId, o.scopeKey, entity, key);
        for (const mk of def.matchKeys ?? []) {
          const v = w.values[mk];
          if (v === undefined || v === null) continue;
          const hit = await sink.findByField(entity, mk, v);
          if (hit && hit.id !== id) w.issues.push({ severity: "error", code: "MATCH_KEY_CONFLICT", field: mk, message: `An existing record already uses this ${mk}; merge or fix it before importing.` });
        }
        w.action = hasErr(w.issues) ? "error" : "create"; w.targetId = id; return;
      }
      w.targetId = targetId;
      const cur = await sink.get(entity, targetId, Object.keys(w.values));
      if (!cur) { w.action = "unchanged"; w.noItem = true; w.issues.push({ severity: "warning", code: "TARGET_MISSING", message: "The previously imported record no longer exists; it was not re-created." }); return; }
      const patch = computePatch(cur, w.values, dedupe);
      if (eff?.action === "updated") { w.action = "update"; w.effect = eff; w.patch = patch; w.applied = Object.keys(patch).length === 0; return; }
      if (Object.keys(patch).length === 0) { w.action = "unchanged"; return; }
      w.action = "update"; w.patch = patch; w.before = pick(cur, Object.keys(patch));
    });

    // 4. apply (commit) — write-ahead effects first
    const apply = work.filter((w) => w.action === "create" || (w.action === "update" && !w.applied));
    if (commit && apply.length) {
      await o.store.addEffects(apply.filter((w) => !w.effect).map((w): EffectRecord => ({
        runId: run!.id, entity, sourceKey: w.key!, action: w.action === "create" ? "created" : "updated", targetId: w.targetId!,
        before: w.action === "update" ? w.before ?? {} : null, after: w.action === "update" ? w.patch! : w.values, rollbackState: null,
      })));
      await mapLimit(apply, READ_CONCURRENCY, async (w) => {
        if (w.action === "create") {
          const r = await sink.create(entity, w.targetId!, w.key!, w.values);
          if (!r.ok) {
            const exists = r.code === "conflict" ? await sink.get(entity, w.targetId!, ["id"]) : null;
            if (!exists) { w.issues.push({ severity: "error", code: r.code === "conflict" ? "TARGET_CONFLICT" : "TARGET_REJECTED", message: "The record was rejected by the database (duplicate or invalid data)." }); w.action = "error"; }
          }
        } else {
          const r = await sink.update(entity, w.targetId!, w.patch!);
          if (!r.ok) { w.issues.push({ severity: "error", code: "TARGET_REJECTED", message: "The update was rejected by the database." }); w.action = "error"; }
        }
      });
    }

    // 5. account
    const outItems: ItemRecord[] = [];
    const outErrors: RowErrorRecord[] = [];
    for (const w of work) {
      const outcome = w.action === "create" ? "created" : w.action === "update" ? "updated" : w.action === "unchanged" ? "unchanged" : w.action === "skipped" ? "skipped" : "errors";
      rb.row(entity, outcome, w.rec.position, w.key, w.issues, w.values, summable);
      if (w.key !== null && w.targetId && (outcome === "created" || outcome === "updated" || outcome === "unchanged")) setTarget(entity, w.key, w.targetId);
      if (!commit || w.key === null) {
        if (commit && w.action === "error") for (const i of w.issues.filter((x) => x.severity === "error")) outErrors.push({ entity, sourceKey: null, position: w.rec.position, code: i.code, message: i.message });
        continue;
      }
      if (w.action === "error") {
        for (const i of w.issues.filter((x) => x.severity === "error")) outErrors.push({ entity, sourceKey: w.key, position: w.rec.position, code: i.code, message: i.message });
        if (w.fp) outItems.push({ entity, sourceKey: w.key, fingerprint: w.fp, targetId: null, status: "error", runId: run!.id, position: w.rec.position });
      } else if (w.action !== "skipped" && !w.noItem) {
        outItems.push({ entity, sourceKey: w.key, fingerprint: w.fp, targetId: w.targetId, status: outcome as "created" | "updated" | "unchanged", runId: run!.id, position: w.rec.position });
      }
    }
    return { items: outItems, errors: outErrors };
  }

  try {
    outer: for (let ei = cp.entityIndex; ei < order.length; ei++) {
      const entity = order[ei];
      let cursor = ei === cp.entityIndex ? cp.cursor : null;
      for (;;) {
        if (o.deadlineMs !== undefined && now() >= o.deadlineMs) { complete = false; break outer; }
        const page = await o.adapter.read(entity, cursor, batchSize);
        const { items, errors } = await processBatch(entity, page.records);
        cursor = page.nextCursor;
        const next: Checkpoint = cursor === null ? { entityIndex: ei + 1, cursor: null } : { entityIndex: ei, cursor };
        if (commit) {
          await o.store.saveBatch({ runId: run!.id, owner: worker, items, errors, checkpoint: next, counters: rb.counters, leaseTtlMs: LEASE_TTL_MS, nowMs: now() });
          saved = { cp: next, counters: JSON.parse(JSON.stringify(rb.counters)) as Counters };
        }
        cp = next;
        const t = rb.totals();
        if (commit && t.rows >= BREAKER_MIN_ROWS && t.errors / t.rows > maxRatio) { failure = "ERROR_RATIO_EXCEEDED"; complete = false; break outer; }
        if (cursor === null) break;
      }
    }
    if (commit) {
      if (failure) status = "failed";
      else if (!complete) status = "paused";
      else status = rb.totals().errors > 0 ? "completed_with_errors" : "completed";
    }
  } catch (e) {
    if (e instanceof StoreError && e.code === "LEASE_LOST") throw e;
    if (!commit) throw e;
    complete = false;
    failure = e instanceof SinkTransientError ? "SINK_UNAVAILABLE" : e instanceof ImportError ? e.code : "INTERNAL_ERROR";
    status = "paused";
    cp = saved.cp;
    console.error(JSON.stringify({ event: "import_framework_paused", runId: run?.id, failure, error: (e as Error).message }));
  }

  if (commit && run) {
    const finished = status === "completed" || status === "completed_with_errors" || status === "failed";
    const abnormal = failure !== null && failure !== "ERROR_RATIO_EXCEEDED";
    await o.store.updateRun(run.id, { status: status as RunStatus, failure, checkpoint: abnormal ? saved.cp : cp, counters: abnormal ? saved.counters : rb.counters, ...(finished ? { finishedAt: isoNow(now) } : {}) });
    await o.store.releaseLease(run.id, worker);
  }

  const totals = rb.totals();
  const blockers: string[] = [];
  if (!complete) blockers.push(commit ? "RUN_NOT_FINISHED" : "REPORT_INCOMPLETE");
  if (totals.rows === 0) blockers.push("NO_ROWS");
  if (totals.rows > 0 && totals.errors / totals.rows > maxRatio) blockers.push("ERROR_RATIO_EXCEEDED");
  return {
    runId: run?.id ?? null, status, complete, checkpoint: cp, failure,
    report: { ...base, complete, mappingIssues, entities: rb.entityReports(), totals, samples: rb.samples, samplesTruncated: rb.samplesTruncated, canCommit: blockers.length === 0, blockers },
  };
}

// ===================================================================== rollback

export interface RollbackOptions {
  tenantId: string; scopeKey: string; runId: string; defs: EntityDefinitions; sink: TargetSink; store: ImportStore;
  force?: boolean; deadlineMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; workerId?: string; batchSize?: number;
}
export interface RollbackOutcome { runId: string; status: RunStatus; complete: boolean; summary: RollbackSummary }

export async function rollbackRun(o: RollbackOptions): Promise<RollbackOutcome> {
  const now = o.now ?? Date.now;
  const worker = o.workerId ?? newWorkerId("rb");
  const sink = retrying(o.sink, o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))));
  const run = await o.store.getRun(o.runId);
  if (!run || run.scopeKey !== o.scopeKey) throw new ImportError("RUN_NOT_FOUND", "Run not found.");
  if (run.status === "rolled_back") throw new ImportError("NOT_ROLLBACKABLE", "This run was already rolled back.");
  if (!o.force) {
    const newer = (await o.store.listRuns(o.scopeKey)).find((r) => r.id !== run.id && Date.parse(r.createdAt) > Date.parse(run.createdAt) && r.status !== "rolled_back");
    if (newer) throw new ImportError("NEWER_RUN_EXISTS", "A newer run exists for this migration; roll that back first (newest first).");
  }
  if (!(await o.store.acquireLease(run.id, worker, LEASE_TTL_MS, now()))) throw new ImportError("RUN_BUSY", "This run is busy.");

  const resuming = run.status === "rolling_back";
  const summary: RollbackSummary = resuming && run.rollbackSummary ? { ...run.rollbackSummary } : zeroSummary();
  if (!resuming) await o.store.resetBlockedEffects(run.id);
  await o.store.updateRun(run.id, { status: "rolling_back" });

  const entities = entityOrder(run.mapping, o.defs).reverse(); // children first
  let complete = true;
  try {
    outer: for (const entity of entities) {
      for (;;) {
        if (o.deadlineMs !== undefined && now() >= o.deadlineMs) { complete = false; break outer; }
        const batch = await o.store.listPendingEffects(run.id, entity, o.batchSize ?? 200);
        if (batch.length === 0) break;
        const results = await mapLimit(batch, READ_CONCURRENCY, async (e): Promise<{ state: RollbackState; invalidate: boolean; kind: keyof RollbackSummary }> => {
          if (e.action === "created") {
            const cols = Object.keys(e.after ?? {});
            const cur = cols.length ? await sink.get(entity, e.targetId, cols) : await sink.get(entity, e.targetId, ["id"]);
            if (!cur) return { state: "done", invalidate: true, kind: "missing" };
            if (cols.some((c) => !same(cur[c], (e.after ?? {})[c]))) return { state: "kept_modified", invalidate: false, kind: "keptModified" };
            const r = await sink.remove(entity, e.targetId);
            return r === "blocked" ? { state: "blocked", invalidate: false, kind: "blocked" } : { state: "done", invalidate: true, kind: r === "deleted" ? "deleted" : "missing" };
          }
          const r = await sink.restore(entity, e.targetId, e.after ?? {}, e.before ?? {});
          return r === "modified" ? { state: "kept_modified", invalidate: false, kind: "keptModified" } : { state: "done", invalidate: true, kind: r === "restored" ? "restored" : "missing" };
        });
        for (const r of results) summary[r.kind]++;
        await o.store.markRolledBack(run.id, batch.map((e, i) => ({ entity, sourceKey: e.sourceKey, state: results[i].state, invalidate: results[i].invalidate })));
        await o.store.updateRun(run.id, { rollbackSummary: summary });
      }
    }
  } finally {
    await o.store.releaseLease(run.id, worker);
  }
  if (complete) { const c = await o.store.countRollbackStates(run.id); summary.blocked = c.blocked; summary.keptModified = c.kept_modified; }
  const status: RunStatus = !complete ? "rolling_back" : summary.blocked + summary.keptModified > 0 ? "rolled_back_partial" : "rolled_back";
  await o.store.updateRun(run.id, { status, rollbackSummary: summary, ...(complete ? { finishedAt: isoNow(now) } : {}) });
  return { runId: run.id, status, complete, summary };
}

export { emptyCounters };
export type { Counters };
