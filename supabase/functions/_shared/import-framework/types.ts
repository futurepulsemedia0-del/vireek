// supabase/functions/_shared/import-framework/types.ts
//
// Contracts for the generic import framework. Pure types + two error classes: no I/O, no Deno APIs.
// See docs/platform/18-ma-readiness.md for the design rationale.

export type Values = Record<string, unknown>;
export type DedupeStrategy = "skip" | "fill_blanks" | "overwrite";

export type Severity = "error" | "warning" | "info";
export interface Issue { severity: Severity; code: string; field?: string; message: string }

// ------------------------------------------------------------------ source side

export type RawRow = Record<string, string | number | boolean | null | undefined>;
/** `position` is a human-meaningful row number (CSV: spreadsheet row, header = 1). */
export interface SourceRecord { position: number; data: RawRow }
export interface SourcePage { records: SourceRecord[]; nextCursor: string | null }

/**
 * A read-only view of ONE source snapshot. Adapters never write, never hold secrets in their output,
 * and must be deterministic: the same snapshot yields the same pages for the same cursors.
 */
export interface SourceAdapter {
  readonly id: string;
  readonly version: string;
  entities(): readonly string[];
  columns(entity: string): readonly string[];
  /** Identity of the snapshot (content hash / export id). A resume is refused when it changes. */
  fingerprint(): string;
  /** `cursor` is opaque to the engine; null = start. `nextCursor` null = no more pages. */
  read(entity: string, cursor: string | null, limit: number): Promise<SourcePage>;
}

// ------------------------------------------------------------------ mapping config (JSON, versioned)

export type Transform =
  | { op: "trim" | "lower" | "upper" | "collapse_space" | "phone_e164" | "email" | "money" | "money_cents" | "number" | "integer" | "boolean" | "date" | "timestamp" }
  | { op: "enum"; map: Record<string, string>; fallback?: string | null }
  | { op: "truncate"; max: number };

export type Scalar = string | number | boolean | null;

export interface FieldRule {
  /** Source column(s). Several columns are joined (default separator " "). Exclusive with `value`. */
  from?: string | string[];
  /** Constant. Exclusive with `from`. */
  value?: Scalar;
  join?: string;
  transforms?: Transform[];
  required?: boolean;
  default?: Scalar;
}
export interface KeyRule { from: string | string[]; join?: string; transforms?: Transform[] }
export interface EntityMapping { key?: KeyRule; fields: Record<string, FieldRule> }
export interface MappingOptions {
  dedupe?: DedupeStrategy;
  /** IANA zone used to read wall-clock timestamps. Default "UTC". */
  timezone?: string;
  /** Allow `row-<position>` keys when the source has no stable id (re-imports of a CHANGED file are then NOT idempotent). */
  allowPositionalKeys?: boolean;
  /** Circuit breaker, 0..1, evaluated once >= 50 rows were processed. Default 0.25. */
  maxErrorRatio?: number;
}
export interface MappingConfig {
  version: 1;
  source: string;
  options?: MappingOptions;
  entities: Record<string, EntityMapping>;
}

// ------------------------------------------------------------------ target side

export interface EntityFieldDef {
  type: "string" | "number" | "integer" | "boolean" | "date" | "timestamp";
  required?: boolean;
  maxLength?: number;
  /** Included in the control totals of the validation report. */
  summable?: boolean;
}
export interface EntityDefinition {
  name: string;
  /** Physical table (used by the Supabase sink). */
  table: string;
  fields: Record<string, EntityFieldDef>;
  dependsOn?: readonly string[];
  /** Mapped field -> { entity it points at, target column that receives the resolved id }. */
  references?: Record<string, { entity: string; target: string; required?: boolean }>;
  /** Fields that are unique per tenant in the target (e.g. customer phone/email): conflicts are reported up front. */
  matchKeys?: readonly string[];
  validate?: (values: Values) => Issue[];
}
export type EntityDefinitions = Record<string, EntityDefinition>;

export type SinkWrite = { ok: true } | { ok: false; code: "conflict" | "invalid"; message: string };
export type RemoveOutcome = "deleted" | "blocked" | "missing";
export type RestoreOutcome = "restored" | "modified" | "missing";

/**
 * The ONLY door to the target tables. Implementations MUST scope every call to one tenant and must
 * never upsert by id without that scope. Transient failures (network, 5xx, timeouts) throw
 * SinkTransientError; permanent ones are returned as values.
 */
export interface TargetSink {
  get(entity: string, id: string, columns: readonly string[]): Promise<Values | null>;
  findByKey(entity: string, key: string): Promise<{ id: string; values: Values } | null>;
  findByField(entity: string, field: string, value: unknown): Promise<{ id: string } | null>;
  create(entity: string, id: string, key: string, values: Values): Promise<SinkWrite>;
  update(entity: string, id: string, patch: Values): Promise<SinkWrite>;
  /** Apply `restore` only when every column in `expect` still has that value (nobody edited it since). */
  restore(entity: string, id: string, expect: Values, restore: Values): Promise<RestoreOutcome>;
  remove(entity: string, id: string): Promise<RemoveOutcome>;
}

// ------------------------------------------------------------------ persistence (ledger)

export type RunStatus =
  | "running" | "paused" | "completed" | "completed_with_errors" | "failed"
  | "rolling_back" | "rolled_back" | "rolled_back_partial";

export interface Checkpoint { entityIndex: number; cursor: string | null }
export interface EntityCounters { rows: number; created: number; updated: number; unchanged: number; skipped: number; errors: number; warnings: number }
export type Counters = Record<string, EntityCounters>;
export interface RollbackSummary { deleted: number; restored: number; keptModified: number; blocked: number; missing: number }

export interface NewRun {
  scopeKey: string;
  adapterId: string;
  adapterVersion: string;
  sourceFingerprint: string;
  mappingHash: string;
  mapping: MappingConfig;
  actorId: string | null;
}
export interface RunRecord extends NewRun {
  id: string;
  tenantId: string;
  status: RunStatus;
  checkpoint: Checkpoint;
  counters: Counters;
  failure: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  rollbackSummary: RollbackSummary | null;
}

export interface ItemRecord {
  entity: string;
  sourceKey: string;
  fingerprint: string;
  targetId: string | null;
  status: "created" | "updated" | "unchanged" | "error";
  runId: string;
  position: number;
}
export type RollbackState = "done" | "blocked" | "kept_modified";
export interface EffectRecord {
  runId: string;
  entity: string;
  sourceKey: string;
  action: "created" | "updated";
  targetId: string;
  before: Values | null;
  after: Values | null;
  rollbackState: RollbackState | null;
}
/** Deliberately carries NO source values (PII minimisation): position + code + a generic message only. */
export interface RowErrorRecord { entity: string; sourceKey: string | null; position: number; code: string; message: string }

export interface BatchSave {
  runId: string;
  owner: string;
  items: ItemRecord[];
  errors: RowErrorRecord[];
  checkpoint: Checkpoint;
  counters: Counters;
  leaseTtlMs: number;
  nowMs: number;
}

export interface ImportStore {
  /** Throws StoreError("RUN_IN_PROGRESS") when the scope already has a running/paused run. */
  createRun(n: NewRun): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  findOpenRun(scopeKey: string): Promise<RunRecord | null>;
  /** Newest first. */
  listRuns(scopeKey: string): Promise<RunRecord[]>;
  updateRun(id: string, patch: Partial<Pick<RunRecord, "status" | "failure" | "finishedAt" | "rollbackSummary" | "checkpoint" | "counters">>): Promise<void>;
  acquireLease(id: string, owner: string, ttlMs: number, nowMs: number): Promise<boolean>;
  releaseLease(id: string, owner: string): Promise<void>;
  getItems(scopeKey: string, entity: string, keys: string[]): Promise<Map<string, ItemRecord>>;
  getEffects(runId: string, entity: string, keys: string[]): Promise<Map<string, EffectRecord>>;
  /** Write-ahead: persisted BEFORE the target is touched. Existing (run, entity, key) rows are kept as they are. */
  addEffects(effects: EffectRecord[]): Promise<void>;
  /** ONE transaction: items + row errors + checkpoint + counters + lease extension. Throws StoreError("LEASE_LOST"). */
  saveBatch(b: BatchSave): Promise<void>;
  /** Effects with rollbackState = null, optionally one entity, at most `limit`. */
  listPendingEffects(runId: string, entity: string, limit: number): Promise<EffectRecord[]>;
  resetBlockedEffects(runId: string): Promise<void>;
  countRollbackStates(runId: string): Promise<{ blocked: number; kept_modified: number }>;
  /** Sets rollbackState and, when `invalidate`, deletes the ledger item so a later run re-evaluates the row. */
  markRolledBack(runId: string, rows: { entity: string; sourceKey: string; state: RollbackState; invalidate: boolean }[]): Promise<void>;
}

// ------------------------------------------------------------------ errors

export type ImportErrorCode =
  | "MAPPING_INVALID" | "SOURCE_CHANGED" | "MAPPING_CHANGED" | "RUN_NOT_FOUND" | "RUN_NOT_RESUMABLE"
  | "RUN_BUSY" | "NEWER_RUN_EXISTS" | "NOT_ROLLBACKABLE" | "SOURCE_INVALID";
export class ImportError extends Error {
  constructor(public readonly code: ImportErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ImportError";
  }
}
export class StoreError extends Error {
  constructor(public readonly code: "RUN_IN_PROGRESS" | "LEASE_LOST" | "NOT_FOUND" | "UNAVAILABLE", message: string) {
    super(message);
    this.name = "StoreError";
  }
}
export class SinkTransientError extends Error {
  constructor(message: string) { super(message); this.name = "SinkTransientError"; }
}
