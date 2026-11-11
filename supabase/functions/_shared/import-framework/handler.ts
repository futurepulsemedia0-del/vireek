// supabase/functions/_shared/import-framework/handler.ts
//
// Transport-agnostic request handler for the `import-framework` edge function (pure: all I/O arrives
// through `deps`, so it is unit-tested without Deno). Order of checks: module gate -> permission ->
// input validation -> work. Nothing else in Vireek calls this, so with the module OFF behaviour is unchanged.
//
// Actions: dry_run | start (also resumes) | rollback | status
// A call works until its time budget is spent and then returns status "paused" + run_id; the client calls
// `start` again with the SAME files (the snapshot fingerprint must match) until status is "completed*".

import { createCsvAdapter, CSV_ADAPTER_ID } from "./adapters/csv.ts";
import { rollbackRun, runImport } from "./engine.ts";
import { ImportError, StoreError } from "./types.ts";
import type { EntityDefinitions, ImportStore, MappingConfig, TargetSink } from "./types.ts";

export interface HandlerDeps {
  tenantId: string;
  actorId: string | null;
  moduleEnabled: boolean;
  canImport: boolean;
  store: ImportStore;
  makeSink: (scopeKey: string) => TargetSink;
  defs: EntityDefinitions;
  now?: () => number;
  budgetMs?: number;
}
export interface HandlerResult { status: number; body: Record<string, unknown> }

const SCOPE_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const reply = (status: number, body: Record<string, unknown>): HandlerResult => ({ status, body });

const HTTP: Record<string, number> = {
  MAPPING_INVALID: 422, SOURCE_INVALID: 422, SOURCE_CHANGED: 409, MAPPING_CHANGED: 409, RUN_BUSY: 409,
  RUN_NOT_FOUND: 404, RUN_NOT_RESUMABLE: 409, NEWER_RUN_EXISTS: 409, NOT_ROLLBACKABLE: 409,
};

export async function handleFrameworkRequest(d: HandlerDeps, body: unknown): Promise<HandlerResult> {
  if (!d.moduleEnabled) return reply(403, { error: "module_disabled", message: "The import framework is not enabled for this account." });
  if (!d.canImport) return reply(403, { error: "forbidden", message: "You don't have permission to import data." });
  if (!isObj(body) || typeof body.action !== "string") return reply(400, { error: "bad_request", message: "Expected { action, ... }." });
  const scopeKey = body.scope_key;
  if (typeof scopeKey !== "string" || !SCOPE_RE.test(scopeKey)) return reply(400, { error: "bad_scope", message: "scope_key must be 1-80 chars: lowercase letters, digits, . _ -" });
  const now = d.now ?? Date.now;

  try {
    if (body.action === "status") {
      const runs = await d.store.listRuns(scopeKey);
      return reply(200, { runs: runs.slice(0, 20).map((r) => ({ run_id: r.id, status: r.status, checkpoint: r.checkpoint, counters: r.counters, failure: r.failure, created_at: r.createdAt, finished_at: r.finishedAt, rollback_summary: r.rollbackSummary })) });
    }
    if (body.action === "rollback") {
      if (typeof body.run_id !== "string") return reply(400, { error: "bad_request", message: "run_id is required." });
      const out = await rollbackRun({ tenantId: d.tenantId, scopeKey, runId: body.run_id, defs: d.defs, sink: d.makeSink(scopeKey), store: d.store, force: body.force === true, deadlineMs: now() + (d.budgetMs ?? 40_000), now });
      return reply(200, { run_id: out.runId, status: out.status, complete: out.complete, summary: out.summary });
    }
    if (body.action !== "dry_run" && body.action !== "start") return reply(400, { error: "unknown_action" });

    if ((body.source ?? CSV_ADAPTER_ID) !== CSV_ADAPTER_ID) return reply(400, { error: "unknown_source", message: "Only the csv source is available." });
    if (!isObj(body.files) || Object.keys(body.files).length === 0 || Object.keys(body.files).length > 20) return reply(400, { error: "bad_request", message: "files must map entity names to CSV text." });
    const adapter = createCsvAdapter(body.files as Record<string, string>);
    const mapping = body.mapping as MappingConfig; // validated (and refused if invalid) inside runImport
    const common = { tenantId: d.tenantId, actorId: d.actorId, scopeKey, adapter, mapping, defs: d.defs, sink: d.makeSink(scopeKey), store: d.store, now, deadlineMs: now() + (d.budgetMs ?? 40_000), batchSize: 200 };

    if (body.action === "dry_run") {
      const out = await runImport({ ...common, mode: "dry_run" });
      return reply(200, { report: out.report });
    }
    const out = await runImport({ ...common, mode: "commit", ...(typeof body.resume_run_id === "string" ? { resumeRunId: body.resume_run_id } : {}) });
    return reply(200, { run_id: out.runId, status: out.status, complete: out.complete, failure: out.failure, checkpoint: out.checkpoint, report: out.report });
  } catch (e) {
    if (e instanceof ImportError) return reply(HTTP[e.code] ?? 400, { error: e.code.toLowerCase(), message: e.message, ...(e.details ? { details: e.details } : {}) });
    if (e instanceof StoreError) {
      if (e.code === "LEASE_LOST") return reply(409, { error: "lease_lost", message: "Another worker took over this run; re-check its status." });
      if (e.code === "NOT_FOUND") return reply(404, { error: "not_found" });
    }
    console.error(JSON.stringify({ event: "import_framework_error", error: (e as Error).message }));
    return reply(500, { error: "internal", message: "The import hit an unexpected problem. Nothing was lost; check the run status and retry." });
  }
}
