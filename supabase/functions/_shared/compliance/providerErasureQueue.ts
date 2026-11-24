// supabase/functions/_shared/compliance/providerErasureQueue.ts
//
// Retry queue + proof store for provider-side erasure (gap E5). Replaces the one-shot eraseProviderData() in
// providerErasure.ts (kept, now deprecated, so nothing that still imports it breaks).
//
// FLOW (full-account erasure)
//   1. collectErasureSubjects()  snapshot provider identifiers from local rows BEFORE any local row is deleted.
//   2. enqueueErasureJobs()      persist the snapshot as provider_erasure_jobs (idempotent via dedupe_key).
//   3. runErasureJobs()          claim (lease) -> adapter.erase() -> write proof; failures get exponential backoff.
//   4. The retention sweep calls processDueProviderErasureJobs() on every run, so failed jobs keep retrying after the
//      local rows - and even the account - are gone. That is why the snapshot lives in the job row.
//
// Table + claim RPC: supabase/migrations/20290312000000_provider_erasure_queue.sql (service_role only).
// NOT LIVE-VERIFIED: see providerAdapters.ts.

import {
  chunk,
  computeBackoffMs,
  createAdapters,
  type ErasureOutcome,
  type ErasureSubject,
  type ProviderEnv,
  type ProviderErasureAdapter,
  type ProviderName,
} from "./providerAdapters.ts";

// Minimal structural client type so this file never depends on a supabase-js version (same approach as regional.ts).
// deno-lint-ignore no-explicit-any
export type QueueAdmin = { from: (t: string) => any; rpc: (n: string, a?: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };

export const JOB_TABLE = "provider_erasure_jobs";
const CHUNK_SIZE = 50;
const PAGE = 1000;
const MAX_ROWS_PER_SOURCE = 50_000;
const DEFAULT_INLINE_DEADLINE_MS = 25_000;

export interface PlannedJob {
  provider: ProviderName;
  subject: ErasureSubject;
  dedupeKey: string;
}

export interface JobRow {
  id: string;
  subject_account_id: string;
  request_id: string | null;
  provider: ProviderName;
  dedupe_key: string;
  subject: ErasureSubject;
  status: "pending" | "erased" | "not_applicable" | "unsupported" | "dead";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

export interface Clock { now: () => Date; rand: () => number }
const SYSTEM_CLOCK: Clock = { now: () => new Date(), rand: Math.random };

/** Reads provider credentials through an injected getter (Deno.env.get in edge functions). */
export function readProviderEnv(get: (k: string) => string | undefined | null): ProviderEnv {
  const v = (k: string) => get(k) ?? undefined;
  return {
    vapiKey: v("VAPI_PRIVATE_KEY"),
    elevenLabsKey: v("ELEVENLABS_API_KEY"),
    twilioAccountSid: v("TWILIO_ACCOUNT_SID"),
    twilioAuthToken: v("TWILIO_AUTH_TOKEN"),
    resendKey: v("RESEND_API_KEY"),
  };
}

// ------------------------------------------------------------------ 1. snapshot
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface ColumnSource { table: string; column: string; ownerColumn: "user_id" | "account_owner_id" }

/** Pages through one column. A missing table counts as empty; any other error makes the snapshot incomplete. */
async function readColumn(admin: QueueAdmin, src: ColumnSource, accountId: string): Promise<{ values: string[]; error?: string; truncated?: boolean }> {
  const values: string[] = [];
  for (let from = 0; from < MAX_ROWS_PER_SOURCE; from += PAGE) {
    const { data, error } = await admin
      .from(src.table).select(src.column).eq(src.ownerColumn, accountId).not(src.column, "is", null)
      .order(src.column, { ascending: true }).range(from, from + PAGE - 1);
    if (error) {
      if (MISSING_TABLE_CODES.has(String(error.code ?? ""))) return { values: [] };
      return { values, error: `${src.table}.${src.column}:${String(error.code ?? error.message ?? "error").slice(0, 60)}` };
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of rows) if (typeof r[src.column] === "string" && r[src.column]) values.push(r[src.column] as string);
    if (rows.length < PAGE) return { values };
  }
  return { values, truncated: true };
}

export interface SubjectSnapshot {
  jobs: PlannedJob[];
  /** false => some source could not be read; the caller must NOT delete local rows (the identifiers would be lost). */
  complete: boolean;
  problems: string[];
}

export async function collectErasureSubjects(admin: QueueAdmin, accountId: string, requestId: string | null): Promise<SubjectSnapshot> {
  const problems: string[] = [];
  const read = async (src: ColumnSource) => {
    const r = await readColumn(admin, src, accountId);
    if (r.error) problems.push(r.error);
    if (r.truncated) problems.push(`${src.table}.${src.column}:truncated`);
    return r.values;
  };

  const callIds = await read({ table: "calls", column: "vapi_call_id", ownerColumn: "user_id" });
  const voiceIds = await read({ table: "business_profile", column: "custom_voice_id", ownerColumn: "user_id" });
  const recordingSids = [
    ...(await read({ table: "pbx_recordings", column: "recording_sid", ownerColumn: "account_owner_id" })),
    ...(await read({ table: "pbx_voicemails", column: "recording_sid", ownerColumn: "account_owner_id" })),
  ];
  const callSids = [
    ...(await read({ table: "pbx_calls", column: "call_sid", ownerColumn: "account_owner_id" })),
    ...(await read({ table: "pbx_call_legs", column: "call_sid", ownerColumn: "account_owner_id" })),
  ];

  const jobs: PlannedJob[] = [];
  const add = async (provider: ProviderName, kind: string, ids: string[]) => {
    for (const part of chunk([...new Set(ids)].sort(), CHUNK_SIZE)) {
      const subject: ErasureSubject = { accountId, resources: { [kind]: part } };
      jobs.push({ provider, subject, dedupeKey: `${accountId}:${provider}:${kind}:${(await sha256Hex(part.join(","))).slice(0, 32)}` });
    }
  };
  await add("vapi", "callIds", callIds);
  await add("elevenlabs", "voiceIds", voiceIds);
  await add("twilio", "recordingSids", recordingSids);
  await add("twilio", "callSids", callSids);
  // One documentation row per erasure: Resend has no deletion API we can call (see createResendAdapter).
  jobs.push({ provider: "resend", subject: { accountId, resources: {} }, dedupeKey: `${accountId}:resend:manual:${requestId ?? "account"}` });

  return { jobs, complete: problems.length === 0, problems };
}

// ------------------------------------------------------------------ 2. enqueue
export async function enqueueErasureJobs(admin: QueueAdmin, accountId: string, requestId: string | null, jobs: PlannedJob[]): Promise<{ ok: boolean; error?: string }> {
  if (jobs.length === 0) return { ok: true };
  const rows = jobs.map((j) => ({
    subject_account_id: accountId, request_id: requestId, provider: j.provider, dedupe_key: j.dedupeKey, subject: j.subject,
  }));
  const { error } = await admin.from(JOB_TABLE).upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });
  if (error) return { ok: false, error: String(error.code ?? error.message ?? "enqueue_failed").slice(0, 80) };
  // A new request re-arms jobs that previously ran out of attempts.
  const { error: rearmErr } = await admin.from(JOB_TABLE)
    .update({ status: "pending", attempts: 0, next_attempt_at: new Date().toISOString(), locked_until: null, last_error: null })
    .in("dedupe_key", jobs.map((j) => j.dedupeKey)).eq("status", "dead");
  if (rearmErr) return { ok: false, error: String(rearmErr.code ?? rearmErr.message ?? "rearm_failed").slice(0, 80) };
  return { ok: true };
}

// ------------------------------------------------------------------ 3. run
export interface RunOptions {
  adapters: Record<ProviderName, ProviderErasureAdapter>;
  clock?: Clock;
  limit?: number;
  subject?: string | null;
  deadlineMs?: number;
  leaseSeconds?: number;
}

export interface RunSummary { claimed: number; erased: number; retryScheduled: number; dead: number; unsupported: number; notApplicable: number; deferred: number }

export function planJobUpdate(job: Pick<JobRow, "attempts" | "max_attempts">, outcome: ErasureOutcome, clock: Clock): Record<string, unknown> {
  const attempts = job.attempts + 1;
  const nowIso = clock.now().toISOString();
  const base = { attempts, proof: outcome.proof, locked_until: null, updated_at: nowIso };
  if (outcome.status === "erased" || outcome.status === "not_applicable" || outcome.status === "unsupported") {
    return { ...base, status: outcome.status, last_error: null, completed_at: nowIso };
  }
  const error = (outcome.error ?? "failed").slice(0, 300);
  if (!outcome.retryable || attempts >= job.max_attempts) return { ...base, status: "dead", last_error: error, completed_at: nowIso };
  return { ...base, status: "pending", last_error: error, next_attempt_at: new Date(clock.now().getTime() + computeBackoffMs(attempts, clock.rand)).toISOString() };
}

export async function runErasureJobs(admin: QueueAdmin, opts: RunOptions): Promise<RunSummary> {
  const clock = opts.clock ?? SYSTEM_CLOCK;
  const summary: RunSummary = { claimed: 0, erased: 0, retryScheduled: 0, dead: 0, unsupported: 0, notApplicable: 0, deferred: 0 };
  const { data, error } = await admin.rpc("claim_provider_erasure_jobs", {
    p_limit: opts.limit ?? 25, p_lease_seconds: opts.leaseSeconds ?? 300, p_subject: opts.subject ?? null,
  });
  if (error) throw new Error(`claim_provider_erasure_jobs:${String(error.code ?? error.message ?? "error").slice(0, 80)}`);
  const claimed = (Array.isArray(data) ? data : []) as JobRow[];
  summary.claimed = claimed.length;
  const deadline = clock.now().getTime() + (opts.deadlineMs ?? DEFAULT_INLINE_DEADLINE_MS);

  for (const job of claimed) {
    if (clock.now().getTime() > deadline) {
      // Out of time: give the lease back so the next sweep can pick the job up immediately.
      await admin.from(JOB_TABLE).update({ locked_until: null }).eq("id", job.id).eq("status", "pending");
      summary.deferred++;
      continue;
    }
    let outcome: ErasureOutcome;
    try {
      outcome = await opts.adapters[job.provider].erase(job.subject);
    } catch (e) {
      // An adapter must not throw, but a bug must not stall the queue either.
      outcome = {
        status: "failed", retryable: true, error: `adapter_exception:${e instanceof Error ? e.name : "unknown"}`,
        proof: { provider: job.provider, adapter: "exception", endpoint: "n/a", at: clock.now().toISOString(), attempted: 0, deleted: 0, alreadyGone: 0, invalid: 0, failed: [], liveVerified: false },
      };
    }
    const patch = planJobUpdate(job, outcome, clock);
    const { error: updErr } = await admin.from(JOB_TABLE).update(patch).eq("id", job.id).eq("status", "pending");
    if (updErr) throw new Error(`job_update_failed:${String(updErr.code ?? updErr.message ?? "error").slice(0, 80)}`);
    switch (patch.status) {
      case "erased": summary.erased++; break;
      case "not_applicable": summary.notApplicable++; break;
      case "unsupported": summary.unsupported++; break;
      case "dead": summary.dead++; break;
      default: summary.retryScheduled++;
    }
  }
  return summary;
}

/** Called by data-retention-sweep on every run. Never throws: a queue problem must not break the sweep. */
export async function processDueProviderErasureJobs(
  admin: QueueAdmin, env: ProviderEnv, opts: { limit?: number; deadlineMs?: number; clock?: Clock; adapters?: Record<ProviderName, ProviderErasureAdapter> } = {},
): Promise<RunSummary & { error?: string }> {
  try {
    return await runErasureJobs(admin, { adapters: opts.adapters ?? createAdapters(env), limit: opts.limit ?? 50, deadlineMs: opts.deadlineMs ?? 60_000, clock: opts.clock });
  } catch (e) {
    return { claimed: 0, erased: 0, retryScheduled: 0, dead: 0, unsupported: 0, notApplicable: 0, deferred: 0, error: e instanceof Error ? e.message.slice(0, 160) : "unknown" };
  }
}

// ------------------------------------------------------------------ 4. facade used by delete-account and the sweep
export interface QueuedErasureResult {
  /** Legacy-compatible: true when no job is pending a retry and none is dead. `unsupported` does not make this false. */
  ok: boolean;
  /** false => provider identifiers could not be fully read; the caller must stop BEFORE deleting local rows. */
  snapshotOk: boolean;
  /** Legacy-compatible labels, e.g. "vapi:pending_retry". Empty when ok. */
  failed: string[];
  unsupported: string[];
  persisted: boolean;
  summary: RunSummary;
  jobs: Array<{ id: string; provider: ProviderName; status: string; attempts: number; lastError: string | null }>;
}

export async function eraseProviderDataQueued(
  admin: QueueAdmin,
  accountId: string,
  env: ProviderEnv,
  opts: { requestId?: string | null; deadlineMs?: number; clock?: Clock; adapters?: Record<ProviderName, ProviderErasureAdapter> } = {},
): Promise<QueuedErasureResult> {
  const adapters = opts.adapters ?? createAdapters(env);
  const empty: RunSummary = { claimed: 0, erased: 0, retryScheduled: 0, dead: 0, unsupported: 0, notApplicable: 0, deferred: 0 };
  const snap = await collectErasureSubjects(admin, accountId, opts.requestId ?? null);
  const failed: string[] = snap.problems.map((p) => `snapshot:${p}`);
  if (!snap.complete) {
    // Do not enqueue a partial snapshot as if it were complete; the caller must retry the whole request.
    return { ok: false, snapshotOk: false, failed, unsupported: [], persisted: false, summary: empty, jobs: [] };
  }

  const enq = await enqueueErasureJobs(admin, accountId, opts.requestId ?? null, snap.jobs);
  if (!enq.ok) {
    // Persisting failed: still try once in memory so data is removed, but report that no proof could be stored.
    failed.push(`queue:${enq.error ?? "persist_failed"}`);
    const summary = { ...empty };
    const unsupported: string[] = [];
    for (const j of snap.jobs) {
      const o = await adapters[j.provider].erase(j.subject);
      if (o.status === "erased") summary.erased++;
      else if (o.status === "not_applicable") summary.notApplicable++;
      else if (o.status === "unsupported") { summary.unsupported++; unsupported.push(j.provider); }
      else { summary.retryScheduled++; failed.push(`${j.provider}:${o.error ?? "failed"}`); }
    }
    return { ok: false, snapshotOk: true, failed, unsupported, persisted: false, summary, jobs: [] };
  }

  let summary = empty;
  try {
    summary = await runErasureJobs(admin, { adapters, clock: opts.clock, subject: accountId, limit: 100, deadlineMs: opts.deadlineMs ?? DEFAULT_INLINE_DEADLINE_MS });
  } catch (e) {
    failed.push(`queue:${e instanceof Error ? e.message.slice(0, 80) : "run_failed"}`);
  }

  const { data } = await admin.from(JOB_TABLE).select("id, provider, status, attempts, last_error").in("dedupe_key", snap.jobs.map((j) => j.dedupeKey));
  const rows = ((data ?? []) as Array<{ id: string; provider: ProviderName; status: string; attempts: number; last_error: string | null }>);
  const jobs = rows.map((r) => ({ id: r.id, provider: r.provider, status: r.status, attempts: r.attempts, lastError: r.last_error }));
  for (const r of rows) {
    if (r.status === "pending") failed.push(`${r.provider}:pending_retry`);
    else if (r.status === "dead") failed.push(`${r.provider}:dead`);
  }
  const unsupported = rows.filter((r) => r.status === "unsupported").map((r) => r.provider);
  return { ok: failed.length === 0, snapshotOk: true, failed, unsupported, persisted: true, summary, jobs };
}
