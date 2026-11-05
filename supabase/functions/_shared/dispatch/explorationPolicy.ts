// I/O side of the Causal Dispatch Loop (edge function only). Loads the account's settings and the state the pure
// selector needs, runs the guardrail monitor, and tells the caller to stay fully deterministic (returns null)
// on ANY problem. Dispatch must never wait on, or fail because of, this module.

import type { Db } from './rulesContext.ts';
import {
  DEFAULT_EXPLORATION_CONFIG,
  evaluateGuardrail,
  looksLikeEmergency,
  type ExplorationConfig,
  type ExplorationOutcome,
  type ExplorationState,
  type FtfVerdict,
  type GuardrailResult,
} from './exploration.ts';
import { buildReworkIndex, firstTimeFix } from './outcomes.ts';

export interface JobSafetyFlags {
  isEmergency: boolean;
  slaCritical: boolean;
}

export interface PolicyContext {
  config: ExplorationConfig;
  state: ExplorationState;
  /** job id -> hard-exclusion flags (every requested job is present, or the whole policy is null). */
  jobFlags: Map<string, JobSafetyFlags>;
  /** `${jobId}:${technicianId}` -> autopilot verdict. */
  verdicts: Map<string, FtfVerdict>;
  verdictsFailed: boolean;
  /** Auto decisions with a recorded arm in the last 30 days (denominator of the realised share). */
  autoTotal: number;
  exploreCount: number;
}

const DAY = 86_400_000;
const CHUNK = 150;
const GUARDRAIL_WINDOW_DAYS = 90;
const CALLBACK_WINDOW_DAYS = 14;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const log = (event: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ event, ...extra }));

function chunks<T>(arr: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function globalKillSwitch(): boolean {
  // Global switch for incidents: set the edge secret DISPATCH_EXPLORATION_KILL_SWITCH=true — no deploy needed.
  try {
    // deno-lint-ignore no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deno = (globalThis as any).Deno;
    return deno?.env?.get('DISPATCH_EXPLORATION_KILL_SWITCH') === 'true';
  } catch {
    return false;
  }
}

interface SettingsRow {
  enabled: boolean;
  kill_switch: boolean;
  budget_pct: number | string;
  delta: number | string;
  max_regret_pct: number | string;
  per_tech_weekly_cap: number;
  guardrail_tolerance_pct: number | string;
  auto_disabled_at: string | null;
}

function toConfig(r: SettingsRow): ExplorationConfig {
  const n = (v: number | string, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: r.enabled === true,
    killSwitch: r.kill_switch === true,
    autoDisabled: r.auto_disabled_at != null,
    budgetPct: n(r.budget_pct, DEFAULT_EXPLORATION_CONFIG.budgetPct),
    delta: n(r.delta, DEFAULT_EXPLORATION_CONFIG.delta),
    maxRegretPct: n(r.max_regret_pct, DEFAULT_EXPLORATION_CONFIG.maxRegretPct),
    perTechWeeklyCap: n(r.per_tech_weekly_cap, DEFAULT_EXPLORATION_CONFIG.perTechWeeklyCap),
  };
}

/** Compares randomized vs not-enrolled FTF (mature jobs only) and switches the account off on a real, large drop. */
export async function runGuardrail(db: Db, userId: string, tolerancePct: number, now = new Date()): Promise<GuardrailResult> {
  const since = new Date(now.getTime() - GUARDRAIL_WINDOW_DAYS * DAY).toISOString();
  const { data, error } = await db
    .from('dispatch_decisions')
    .select('job_id, arm, set_size, indifference_set')
    .eq('user_id', userId)
    .eq('mode', 'auto')
    .in('arm', ['explore', 'exploit'])
    .gte('set_size', 2)
    .gte('created_at', since)
    .limit(4000);
  if (error) throw new Error(error.message);

  const armOf = new Map<string, 'explore' | 'control'>();
  for (const r of (data ?? []) as { job_id: string; arm: string; indifference_set: { reason?: string } | null }[]) {
    const reason = r.indifference_set?.reason;
    if (r.arm === 'explore' && reason === 'explored') armOf.set(r.job_id, 'explore');
    else if (r.arm === 'exploit' && reason === 'not_enrolled') armOf.set(r.job_id, 'control');
  }
  const jobIds = [...armOf.keys()];
  const explore: number[] = [];
  const control: number[] = [];
  for (const ids of chunks(jobIds)) {
    const [jobs, reworks] = await Promise.all([
      db.from('jobs').select('id, job_status, completed_at, is_rework').eq('user_id', userId).in('id', ids),
      db.from('jobs').select('rework_of_job_id, created_at').eq('user_id', userId).eq('is_rework', true).in('rework_of_job_id', ids),
    ]);
    if (jobs.error) throw new Error(jobs.error.message);
    if (reworks.error) throw new Error(reworks.error.message);
    const idx = buildReworkIndex((reworks.data ?? []) as { rework_of_job_id: string | null; created_at: string }[]);
    for (const j of (jobs.data ?? []) as { id: string; job_status: string; completed_at: string | null; is_rework: boolean }[]) {
      const y = firstTimeFix(j, idx, CALLBACK_WINDOW_DAYS, now);
      if (y === null) continue;
      (armOf.get(j.id) === 'explore' ? explore : control).push(y);
    }
  }
  return evaluateGuardrail({ explore, control, tolerancePct });
}

export async function loadExplorationPolicy(db: Db, userId: string, jobIds: string[], now = new Date()): Promise<PolicyContext | null> {
  try {
    if (globalKillSwitch() || jobIds.length === 0) return null;

    const settings = await db.from('dispatch_exploration_settings').select('enabled, kill_switch, budget_pct, delta, max_regret_pct, per_tech_weekly_cap, guardrail_tolerance_pct, auto_disabled_at').eq('user_id', userId).maybeSingle();
    if (settings.error || !settings.data) return null; // table missing (migration not applied) or never configured => OFF
    const row = settings.data as SettingsRow;
    const config = toConfig(row);
    if (!config.enabled || config.killSwitch || config.autoDisabled) return null;

    // Guardrail first: a breach switches the account off for good until an owner re-enables it.
    const g = await runGuardrail(db, userId, Number(row.guardrail_tolerance_pct) || DEFAULT_EXPLORATION_CONFIG.maxRegretPct, now);
    if (g.status === 'breached') {
      const reason = `First-time-fix is ${g.dropPp} pp lower on randomized jobs than on matched controls (n=${g.nExplore}/${g.nControl}). Exploration was switched off automatically.`;
      await db.from('dispatch_exploration_settings').update({ enabled: false, auto_disabled_at: now.toISOString(), auto_disabled_reason: reason.slice(0, 500), updated_at: now.toISOString() }).eq('user_id', userId);
      log('dispatch_exploration_auto_disabled', { userId, ...g });
      return null;
    }

    // Budget + exposure state (auto decisions with an arm, last 30 days).
    const since30 = new Date(now.getTime() - 30 * DAY).toISOString();
    const since7 = now.getTime() - 7 * DAY;
    const dec = await db.from('dispatch_decisions').select('technician_id, arm, indifference_set, created_at').eq('user_id', userId).eq('mode', 'auto').not('arm', 'is', null).gte('created_at', since30).limit(5000);
    if (dec.error) throw new Error(dec.error.message);
    let autoTotal = 0;
    let exploreCount = 0;
    const weeklyExposure: Record<string, number> = {};
    for (const d of (dec.data ?? []) as { technician_id: string | null; arm: string; indifference_set: { top_id?: string | null } | null; created_at: string }[]) {
      autoTotal += 1;
      if (d.arm !== 'explore') continue;
      exploreCount += 1;
      if (d.technician_id && d.technician_id !== d.indifference_set?.top_id && Date.parse(d.created_at) >= since7) {
        weeklyExposure[d.technician_id] = (weeklyExposure[d.technician_id] ?? 0) + 1;
      }
    }

    // Job-level hard-exclusion flags. Any failure => no exploration this batch (fail closed).
    const jobFlags = new Map<string, JobSafetyFlags>();
    const callIds = new Set<string>();
    const callOf = new Map<string, string>();
    for (const ids of chunks(jobIds)) {
      const { data, error } = await db.from('jobs').select('id, service_type, tags, call_id, sla_response_hours').eq('user_id', userId).in('id', ids);
      if (error) throw new Error(error.message);
      for (const j of (data ?? []) as { id: string; service_type: string | null; tags: string[] | null; call_id: string | null; sla_response_hours: number | null }[]) {
        jobFlags.set(j.id, { isEmergency: looksLikeEmergency(j.service_type, j.tags), slaCritical: j.sla_response_hours != null });
        if (j.call_id) { callIds.add(j.call_id); callOf.set(j.id, j.call_id); }
      }
    }
    for (const id of jobIds) if (!jobFlags.has(id)) throw new Error('job missing while loading exploration flags');
    if (callIds.size > 0) {
      const emergencyCalls = new Set<string>();
      for (const ids of chunks([...callIds])) {
        const { data, error } = await db.from('calls').select('id, is_emergency').in('id', ids);
        if (error) throw new Error(error.message);
        for (const c of (data ?? []) as { id: string; is_emergency: boolean }[]) if (c.is_emergency) emergencyCalls.add(c.id);
      }
      for (const [jobId, callId] of callOf) if (emergencyCalls.has(callId)) jobFlags.get(jobId)!.isEmergency = true;
    }

    // FTF Autopilot verdicts (per job x technician). A failed lookup makes every job 'error' => deterministic.
    const verdicts = new Map<string, FtfVerdict>();
    let verdictsFailed = false;
    try {
      for (const ids of chunks(jobIds)) {
        const { data, error } = await db.from('ftf_predictions').select('job_id, technician_id, verdict').in('job_id', ids);
        if (error) throw new Error(error.message);
        for (const v of (data ?? []) as { job_id: string; technician_id: string; verdict: FtfVerdict }[]) verdicts.set(`${v.job_id}:${v.technician_id}`, v.verdict);
      }
    } catch (e) {
      verdictsFailed = true;
      log('dispatch_exploration_verdicts_failed', { error: errMsg(e) });
    }

    const state: ExplorationState = { exploreSharePct: autoTotal > 0 ? (100 * exploreCount) / autoTotal : 0, weeklyExposure };
    return { config, state, jobFlags, verdicts, verdictsFailed, autoTotal, exploreCount };
  } catch (e) {
    log('dispatch_exploration_policy_failed', { error: errMsg(e) });
    return null;
  }
}

/** Keep budget and exposure honest inside one batch (several jobs are dispatched per call). */
export function applyOutcome(ctx: PolicyContext, outcome: ExplorationOutcome, assignedId: string): void {
  ctx.autoTotal += 1;
  if (outcome.arm === 'explore' && assignedId === outcome.chosenId) {
    ctx.exploreCount += 1;
    if (assignedId !== outcome.log.top_id) ctx.state.weeklyExposure[assignedId] = (ctx.state.weeklyExposure[assignedId] ?? 0) + 1;
  }
  ctx.state.exploreSharePct = (100 * ctx.exploreCount) / ctx.autoTotal;
}
