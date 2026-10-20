// Rules-driven auto-assign. Called by dispatch-auto-assign.
//   1. No enabled rules  -> legacy path (assignBestTechnician) — behaviour unchanged.
//   2. Rules enabled     -> rank with rulesEngine, then write the winner through the SAME
//      assign_technician_to_job() RPC (explicit technician), so time-off, capacity locking and
//      credential gates still apply. If the DB blocks the winner, the next eligible one is tried.
// Every decision (assigned or no_eligible) is written to dispatch_decisions with the explanation.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { assignBestTechnician, type AssignResult } from './assign.ts';
import { dayKey, loadRulesContext, loadVipCustomerIds, toEngineJob, type RulesContext } from './rulesContext.ts';
import { loadsForDay, rankTechnicians, snapshotForAudit, type RankResult } from './rulesEngine.ts';
import { buildDispatchEvidence, recordAiDecision } from '../governance/aiDecisionRecorder.ts';

export interface AutoAssignJob {
  id: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
}

export interface RulesAssignResult extends AssignResult {
  job_id: string;
  engine: 'rules' | 'legacy';
  score?: number;
  explanation?: string;
}

const BLOCKED_STATUSES = new Set(['blocked_time_off', 'at_capacity', 'blocked_compliance']);

async function logDecision(admin: SupabaseClient, row: Record<string, unknown>) {
  try {
    await admin.from('dispatch_decisions').insert(row);
  } catch (e) {
    console.error(JSON.stringify({ event: 'dispatch_decision_log_failed', error: e instanceof Error ? e.message : String(e) }));
  }
}

export async function assignJobsWithRules(admin: SupabaseClient, userId: string, jobs: AutoAssignJob[]): Promise<RulesAssignResult[]> {
  if (jobs.length === 0) return [];

  let ctx: RulesContext;
  let rows: Record<string, unknown>[] = [];
  let vipIds = new Set<string>();
  try {
    const { data } = await admin.from('jobs').select('id, service_type, address, scheduled_datetime, duration_minutes, customer_id, latitude, longitude').eq('user_id', userId).in('id', jobs.map((j) => j.id));
    rows = (data ?? []) as Record<string, unknown>[];
    const days = rows.flatMap((r) => { const d = dayKey(r.scheduled_datetime as string | null); return d ? [d] : []; });
    ctx = await loadRulesContext(admin, userId, days);
    vipIds = await loadVipCustomerIds(admin, userId, rows.map((r) => r.customer_id as string).filter(Boolean));
  } catch (e) {
    // Rules context unavailable (e.g. migration not applied yet): fall back instead of failing dispatch.
    console.error(JSON.stringify({ event: 'dispatch_rules_context_failed', error: e instanceof Error ? e.message : String(e) }));
    return legacy(admin, userId, jobs);
  }

  if (!ctx.rules.some((r) => r.enabled)) return legacy(admin, userId, jobs);

  const byId = new Map(rows.map((r) => [r.id as string, r]));
  // VIP jobs are placed first (they get first pick of capacity), then chronologically.
  const ordered = [...jobs].sort((a, b) => {
    const va = vipIds.has((byId.get(a.id)?.customer_id as string) ?? '') ? 0 : 1;
    const vb = vipIds.has((byId.get(b.id)?.customer_id as string) ?? '') ? 0 : 1;
    return va - vb || (a.scheduled_datetime ?? '').localeCompare(b.scheduled_datetime ?? '');
  });

  const results: RulesAssignResult[] = [];
  for (const job of ordered) {
    const row = byId.get(job.id);
    if (!row) { results.push({ job_id: job.id, engine: 'rules', technicianId: null, technicianName: null, reason: 'Job not found.' }); continue; }
    const engineJob = toEngineJob(row, vipIds);
    const day = dayKey(row.scheduled_datetime as string | null) ?? dayKey(new Date().toISOString())!;
    const ranking: RankResult = rankTechnicians({ job: engineJob, technicians: ctx.technicians, rules: ctx.rules, territories: ctx.territories, preferences: ctx.preferences, loads: loadsForDay(ctx.openJobs, day, job.id) });
    const audit = { rules_applied: ranking.rules_applied, margin: ranking.margin, candidates: snapshotForAudit(ranking) };

    let outcome: RulesAssignResult | null = null;
    const blockedNotes: string[] = [];
    for (const cand of ranking.ranked.filter((r) => r.eligible)) {
      const { data, error } = await admin.rpc('assign_technician_to_job', { p_job_id: job.id, p_technician_id: cand.technician_id });
      const res = (data ?? {}) as { status?: string; reason?: string };
      if (!error && res.status === 'assigned') {
        const reason = `Rules engine: ${cand.summary}`;
        outcome = { job_id: job.id, engine: 'rules', technicianId: cand.technician_id, technicianName: cand.technician_name, reason, score: cand.score, explanation: cand.summary };
        ctx.openJobs.push({ id: job.id, technician_id: cand.technician_id, day, minutes: engineJob.duration_minutes && engineJob.duration_minutes > 0 ? engineJob.duration_minutes : 60 });
        await logDecision(admin, { user_id: userId, job_id: job.id, technician_id: cand.technician_id, recommended_technician_id: ranking.best?.technician_id ?? null, mode: 'auto', score: cand.score, explanation: audit, note: blockedNotes.length ? `Skipped by system gates: ${blockedNotes.join('; ')}` : null });
        await recordGovernance(admin, userId, row, cand.technician_id, cand.technician_name, reason);
        break;
      }
      if (error || !BLOCKED_STATUSES.has(res.status ?? '')) {
        outcome = { job_id: job.id, engine: 'rules', technicianId: null, technicianName: null, reason: error?.message ?? res.reason ?? 'Assignment failed.' };
        break;
      }
      blockedNotes.push(res.reason ?? `${cand.technician_name} blocked`);
    }

    if (!outcome) {
      const why = ranking.ranked.length === 0
        ? 'No dispatch-enabled technicians on the team.'
        : `No technician satisfies your dispatch rules. ${ranking.ranked.slice(0, 3).map((r) => `${r.technician_name}: ${r.summary}`).join(' | ')}${blockedNotes.length ? ` | System gates: ${blockedNotes.join('; ')}` : ''}`;
      outcome = { job_id: job.id, engine: 'rules', technicianId: null, technicianName: null, reason: why };
      await logDecision(admin, { user_id: userId, job_id: job.id, technician_id: null, recommended_technician_id: null, mode: 'no_eligible', score: null, explanation: audit, note: why.slice(0, 900) });
    }
    results.push(outcome);
  }
  return results;
}

async function legacy(admin: SupabaseClient, userId: string, jobs: AutoAssignJob[]): Promise<RulesAssignResult[]> {
  const out: RulesAssignResult[] = [];
  for (const job of jobs) out.push({ job_id: job.id, engine: 'legacy', ...(await assignBestTechnician(admin, userId, job)) });
  return out;
}

async function recordGovernance(admin: SupabaseClient, userId: string, row: Record<string, unknown>, technicianId: string, technicianName: string, reason: string) {
  try {
    const job = { id: row.id as string, service_type: (row.service_type as string | null) ?? null, address: (row.address as string | null) ?? null, scheduled_datetime: (row.scheduled_datetime as string | null) ?? null };
    const evidence = await buildDispatchEvidence(admin, userId, job, technicianId);
    await recordAiDecision(admin, {
      userId, decisionType: 'dispatch', agentSource: 'ai-dispatcher', engineKind: 'rules', modelVersion: 'dispatch-rules-engine',
      title: `Assigned ${technicianName} to ${job.service_type ?? 'job'}`, decision: `Assign technician ${technicianName} to job ${job.id}`, reasoning: reason,
      confidencePct: evidence.confidencePct, reasonFactors: evidence.reasonFactors, dataUsed: evidence.dataUsed,
      subjectTable: 'jobs', subjectId: job.id, enforcement: 'post_execution', executed: true,
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'ai_governance_dispatch_record_failed', error: e instanceof Error ? e.message : String(e) }));
  }
}
