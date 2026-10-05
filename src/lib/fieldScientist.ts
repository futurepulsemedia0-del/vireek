/**
 * AI Field Scientist — client library.
 *
 * Vireek as a research scientist for the business itself:
 *
 *   mine jobs -> find a segment whose callback rate differs -> control for
 *   job mix (Cochran–Mantel–Haenszel) and multiple testing (Benjamini–
 *   Hochberg) -> AI proposes candidate causes + job-level interventions ->
 *   pre-registered hash-randomised experiment on real upcoming jobs ->
 *   two-proportion test -> ACCEPT / REJECT -> write the result into
 *   Organizational Memory as a playbook or a failure pattern.
 *
 * Every number here is deterministic, inspectable arithmetic. The model only
 * ever drafts candidate causes (server side) — it never sees a p-value, a
 * sample size, an arm assignment or a verdict.
 *
 * Server counterparts:
 *   supabase/migrations/20270202000000_ai_field_scientist.sql
 *   supabase/functions/field-scientist-hypothesize
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// CONSTANTS
// ============================================================

export const CALLBACK_WINDOW_DAYS = 30;
export const LOOKBACK_DAYS = 180;
const MIN_ARM_N = 30;          // min jobs per side before a segment is even tested
const MIN_TOTAL_EVENTS = 8;    // min callbacks across both sides
const MIN_EFFECT_PP = 3;       // min absolute difference (percentage points)
const FDR_Q = 0.05;            // Benjamini–Hochberg false-discovery rate (conservative: tests overlap)
const ALPHA = 0.05;
const POWER = 0.8;
const MAX_PROPOSALS = 8;
const MAX_AI_PER_RUN = 4;
const DAY_MS = 86_400_000;

// ============================================================
// TYPES
// ============================================================

export type FieldDimension =
  | 'technician' | 'tech_group' | 'equipment_type' | 'service_type'
  | 'tech_x_equipment' | 'time_bucket' | 'duration_bucket';
export type HypothesisDirection = 'worse' | 'better';
export type HypothesisStatus = 'proposed' | 'ready' | 'testing' | 'accepted' | 'rejected' | 'inconclusive' | 'dismissed';

export interface JobFeature {
  id: string;
  techId: string | null;
  techName: string | null;
  techGroup: string | null;
  equipment: string | null;
  service: string | null;
  timeBucket: string | null;
  durationBucket: string | null;
  tags: string[];
  completedAtMs: number | null;
  callback: boolean;
}

export interface Counts { n: number; k: number }

export interface ProportionTest {
  p_treat: number; p_ctrl: number; diff: number; z: number; p: number; ci_low: number; ci_high: number;
}

export interface CmhResult { chi2: number; p: number; oddsRatio: number | null; strata: number }

export interface DrilldownRow { dimension: string; key: string; segment_rate_pct: number; others_rate_pct: number; n: number }

export interface SegmentDefinition { dimension: FieldDimension; key: string; techId?: string; equipment?: string }

export interface DiscoveryStats {
  segment_n: number; segment_k: number; segment_rate_pct: number;
  comparison_n: number; comparison_k: number; comparison_rate_pct: number;
  diff_pp: number; ci_low_pp: number; ci_high_pp: number;
  z: number; p_value: number; q_value: number;
  adjusted_p: number | null; adjusted_or: number | null; adjusted_significant: boolean; strata_used: number;
  tested_segments: number; lookback_days: number; window_days: number;
  jobs_per_day: number; comparison_jobs_per_day: number;
  drilldown: DrilldownRow[];
}

export interface CandidateCause { id: string; label: string; mechanism: string; intervention: string; priority: number }

export interface ExperimentDesign {
  cause_id: string; cause_label: string; intervention: string; control_desc: string;
  eligible: 'segment' | 'comparison';
  randomization: string; seed: string; tag_prefix: string;
  primary_metric: string; callback_window_days: number; alpha: number; power: number;
  control_rate_pct: number; target_rate_pct: number;
  n_per_arm: number; expected_days: number; underpowered: boolean; stop_rule: string;
}

export interface ExperimentResult {
  treatment: Counts; control: Counts; test: ProportionTest | null;
  complete: boolean; verdict: 'accepted' | 'rejected' | 'inconclusive' | 'collecting';
  reasoning: string; pending_jobs: number; evaluated_at: string;
}

export interface FieldHypothesis {
  id: string;
  dedupe_key: string;
  segment_dimension: FieldDimension;
  segment_label: string;
  segment_definition: SegmentDefinition;
  direction: HypothesisDirection;
  statement: string;
  discovery: DiscoveryStats;
  status: HypothesisStatus;
  candidate_causes: CandidateCause[];
  selected_cause_id: string | null;
  experiment_design: ExperimentDesign | null;
  experiment_started_at: string | null;
  experiment_ends_at: string | null;
  experiment_result: ExperimentResult | null;
  verdict_reasoning: string | null;
  playbook_entry_id: string | null;
  decided_at: string | null;
  created_at: string;
}

// ============================================================
// STATISTICS (pure, unit-tested in fieldScientist.test.ts)
// ============================================================

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));
export const twoSidedP = (z: number): number => Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));

function wilson(k: number, n: number, z = 1.959964): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Two-proportion z-test (pooled SE) + Newcombe hybrid-score 95% CI for (treat − ctrl). */
export function twoProportionTest(treat: Counts, ctrl: Counts): ProportionTest {
  const p1 = treat.n > 0 ? treat.k / treat.n : 0;
  const p2 = ctrl.n > 0 ? ctrl.k / ctrl.n : 0;
  const pooled = treat.n + ctrl.n > 0 ? (treat.k + ctrl.k) / (treat.n + ctrl.n) : 0;
  const se = treat.n > 0 && ctrl.n > 0 ? Math.sqrt(pooled * (1 - pooled) * (1 / treat.n + 1 / ctrl.n)) : 0;
  const z = se > 0 ? (p1 - p2) / se : 0;
  const [l1, u1] = wilson(treat.k, treat.n);
  const [l2, u2] = wilson(ctrl.k, ctrl.n);
  const diff = p1 - p2;
  return {
    p_treat: p1, p_ctrl: p2, diff, z,
    p: twoSidedP(z),
    ci_low: diff - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2),
    ci_high: diff + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2),
  };
}

/**
 * Cochran–Mantel–Haenszel test across 2x2 strata (continuity-corrected).
 * a/b = segment events/non-events, c/d = comparison events/non-events.
 */
export function cochranMantelHaenszel(strata: Array<{ a: number; b: number; c: number; d: number }>): CmhResult | null {
  let sumDev = 0, sumVar = 0, num = 0, den = 0, used = 0;
  for (const { a, b, c, d } of strata) {
    const n = a + b + c + d;
    if (n < 2 || a + b === 0 || c + d === 0) continue;
    used++;
    sumDev += a - ((a + b) * (a + c)) / n;
    sumVar += ((a + b) * (c + d) * (a + c) * (b + d)) / (n * n * (n - 1));
    num += (a * d) / n;
    den += (b * c) / n;
  }
  if (used === 0 || sumVar <= 0) return null;
  const chi2 = Math.max(0, Math.abs(sumDev) - 0.5) ** 2 / sumVar;
  return { chi2, p: twoSidedP(Math.sqrt(chi2)), oddsRatio: den > 0 ? num / den : null, strata: used };
}

/** Benjamini–Hochberg adjusted p-values (q-values), same order as input. */
export function benjaminiHochberg(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adj = new Array<number>(m).fill(1);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    running = Math.min(running, (order[r].p * m) / (r + 1));
    adj[order[r].i] = Math.min(1, running);
  }
  return adj;
}

/** Per-arm sample size for a two-sided two-proportion test (alpha 0.05, power 0.80). */
export function requiredSampleSizePerArm(p0: number, p1: number): number {
  const za = 1.959964; // two-sided alpha = 0.05
  const zb = 0.841621; // power = 0.80
  const a = Math.min(0.999, Math.max(0.001, p0));
  const b = Math.min(0.999, Math.max(0.001, p1));
  const delta = Math.abs(a - b);
  if (delta < 1e-6) return Number.POSITIVE_INFINITY;
  const pbar = (a + b) / 2;
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(a * (1 - a) + b * (1 - b))) ** 2 / delta ** 2;
  return Math.ceil(n);
}

/** Deterministic 50/50 assignment: FNV-1a over `${seed}:${jobId}`. Reproducible and auditable. */
export function assignArm(jobId: string, seed: string): 'treatment' | 'control' {
  let h = 0x811c9dc5;
  const s = `${seed}:${jobId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h >>> 16) & 1) === 1 ? 'treatment' : 'control';
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

// ============================================================
// FEATURE EXTRACTION
// ============================================================

const toLabel = (s: string | null | undefined): string | null => {
  const v = (s ?? '').trim().toLowerCase();
  return v.length > 0 ? v : null;
};

function timeBucketOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const h = d.getHours();
  return `${weekend ? 'weekend' : 'weekday'} ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}`;
}

function durationBucketOf(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  return minutes < 60 ? 'under 60 min' : minutes <= 120 ? '60–120 min' : 'over 120 min';
}

const KEY_OF: Record<FieldDimension, (j: JobFeature) => string | null> = {
  technician: (j) => j.techId,
  tech_group: (j) => j.techGroup,
  equipment_type: (j) => j.equipment,
  service_type: (j) => j.service,
  tech_x_equipment: (j) => (j.techId && j.equipment ? `${j.techId}|${j.equipment}` : null),
  time_bucket: (j) => j.timeBucket,
  duration_bucket: (j) => j.durationBucket,
};

const DIMENSION_NOUN: Record<FieldDimension, string> = {
  technician: 'technician', tech_group: 'technician group', equipment_type: 'equipment type',
  service_type: 'service type', tech_x_equipment: 'technician × equipment',
  time_bucket: 'time slot', duration_bucket: 'booked duration',
};

function labelFor(dim: FieldDimension, sample: JobFeature): string {
  switch (dim) {
    case 'technician': return sample.techName ?? 'Unnamed technician';
    case 'tech_group': return `Technician group “${sample.techGroup}”`;
    case 'equipment_type': return `${sample.equipment} equipment`;
    case 'service_type': return `${sample.service} service`;
    case 'tech_x_equipment': return `${sample.techName ?? 'Technician'} on ${sample.equipment}`;
    case 'time_bucket': return `${sample.timeBucket} jobs`;
    case 'duration_bucket': return `${sample.durationBucket} jobs`;
  }
}

export function inSegment(def: SegmentDefinition, j: JobFeature): boolean {
  return KEY_OF[def.dimension](j) === def.key;
}

/** The population an experiment is compared against / applied to when direction is 'better'. */
export function inComparison(def: SegmentDefinition, j: JobFeature): boolean {
  if (def.dimension === 'tech_x_equipment') return j.equipment === def.equipment && j.techId !== def.techId;
  return !inSegment(def, j);
}

const countOf = (jobs: JobFeature[]): Counts => ({ n: jobs.length, k: jobs.filter((j) => j.callback).length });

// ============================================================
// DATA LOADING (RLS-scoped; never crosses tenants)
// ============================================================

interface JobRow {
  id: string; service_type: string | null; assigned_technician_id: string | null;
  scheduled_datetime: string | null; duration_minutes: number | null; completed_at: string | null; tags: string[] | null;
}

async function fetchReworkMap(sinceIso: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from('jobs')
    .select('rework_of_job_id, created_at')
    .eq('is_rework', true)
    .not('rework_of_job_id', 'is', null)
    .gte('created_at', sinceIso)
    .limit(10000);
  if (error) throw error;
  const map = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ rework_of_job_id: string; created_at: string }>) {
    const t = new Date(r.created_at).getTime();
    const prev = map.get(r.rework_of_job_id);
    if (prev === undefined || t < prev) map.set(r.rework_of_job_id, t);
  }
  return map;
}

async function fetchEquipmentMap(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('job_equipment')
    .select('job_id, equipment:equipment_id ( equipment_type )')
    .limit(10000);
  if (error) throw error;
  const map = new Map<string, string>();
  for (const r of (data ?? []) as unknown as Array<{ job_id: string; equipment: { equipment_type: string | null } | Array<{ equipment_type: string | null }> | null }>) {
    const eq = Array.isArray(r.equipment) ? r.equipment[0] : r.equipment;
    const label = toLabel(eq?.equipment_type);
    if (label && !map.has(r.job_id)) map.set(r.job_id, label);
  }
  return map;
}

async function fetchTeam(): Promise<Map<string, { name: string | null; group: string | null }>> {
  const { data, error } = await supabase.from('team_members').select('id, member_name, tech_group');
  if (error) throw error;
  const map = new Map<string, { name: string | null; group: string | null }>();
  for (const t of (data ?? []) as Array<{ id: string; member_name: string | null; tech_group: string | null }>) {
    map.set(t.id, { name: t.member_name, group: toLabel(t.tech_group) });
  }
  return map;
}

function toFeature(
  r: JobRow,
  team: Map<string, { name: string | null; group: string | null }>,
  equipment: Map<string, string>,
  rework: Map<string, number>,
): JobFeature {
  const completedAtMs = r.completed_at ? new Date(r.completed_at).getTime() : null;
  const reworkAt = rework.get(r.id);
  const tech = r.assigned_technician_id ? team.get(r.assigned_technician_id) : undefined;
  return {
    id: r.id,
    techId: r.assigned_technician_id,
    techName: tech?.name ?? null,
    techGroup: tech?.group ?? null,
    equipment: equipment.get(r.id) ?? null,
    service: toLabel(r.service_type),
    timeBucket: timeBucketOf(r.scheduled_datetime),
    durationBucket: durationBucketOf(r.duration_minutes),
    tags: r.tags ?? [],
    completedAtMs,
    callback: completedAtMs !== null && reworkAt !== undefined && reworkAt <= completedAtMs + CALLBACK_WINDOW_DAYS * DAY_MS,
  };
}

const JOB_COLUMNS = 'id, service_type, assigned_technician_id, scheduled_datetime, duration_minutes, completed_at, tags';

/** Completed, original (non-rework) jobs old enough for a callback to have had time to happen. */
export async function loadMatureJobs(): Promise<JobFeature[]> {
  const now = Date.now();
  const since = new Date(now - LOOKBACK_DAYS * DAY_MS).toISOString();
  const matureBefore = new Date(now - CALLBACK_WINDOW_DAYS * DAY_MS).toISOString();
  const [jobs, team, equipment, rework] = await Promise.all([
    supabase.from('jobs').select(JOB_COLUMNS).eq('job_status', 'completed').eq('is_rework', false)
      .gte('completed_at', since).lte('completed_at', matureBefore).limit(5000),
    fetchTeam(), fetchEquipmentMap(), fetchReworkMap(since),
  ]);
  if (jobs.error) throw jobs.error;
  return ((jobs.data ?? []) as JobRow[]).map((r) => toFeature(r, team, equipment, rework));
}

async function loadScheduledJobs(): Promise<JobFeature[]> {
  const [jobs, team, equipment] = await Promise.all([
    supabase.from('jobs').select(JOB_COLUMNS).eq('job_status', 'scheduled')
      .gte('scheduled_datetime', new Date().toISOString()).limit(2000),
    fetchTeam(), fetchEquipmentMap(),
  ]);
  if (jobs.error) throw jobs.error;
  return ((jobs.data ?? []) as JobRow[]).map((r) => toFeature(r, team, equipment, new Map()));
}

// ============================================================
// DISCOVERY — the hypothesis generator
// ============================================================

const DRILL_DIMENSIONS: FieldDimension[] = ['equipment_type', 'service_type', 'duration_bucket', 'time_bucket'];

function drilldown(segment: JobFeature[], others: JobFeature[], skip: FieldDimension[]): DrilldownRow[] {
  const rows: DrilldownRow[] = [];
  for (const dim of DRILL_DIMENSIONS) {
    if (skip.includes(dim)) continue;
    const keys = new Set(segment.map(KEY_OF[dim]).filter((k): k is string => k !== null));
    for (const key of keys) {
      const s = countOf(segment.filter((j) => KEY_OF[dim](j) === key));
      const o = countOf(others.filter((j) => KEY_OF[dim](j) === key));
      if (s.n < 10 || o.n < 10) continue;
      const sRate = (s.k / s.n) * 100;
      const oRate = (o.k / o.n) * 100;
      if (Math.abs(sRate - oRate) >= 5) {
        rows.push({ dimension: DIMENSION_NOUN[dim], key, segment_rate_pct: round1(sRate), others_rate_pct: round1(oRate), n: s.n });
      }
    }
  }
  return rows
    .sort((a, b) => Math.abs(b.segment_rate_pct - b.others_rate_pct) - Math.abs(a.segment_rate_pct - a.others_rate_pct))
    .slice(0, 3);
}

export interface ProposedHypothesis {
  dedupe_key: string;
  segment_dimension: FieldDimension;
  segment_label: string;
  segment_definition: SegmentDefinition;
  direction: HypothesisDirection;
  statement: string;
  discovery: DiscoveryStats;
}

export interface DiscoveryOutcome { proposals: ProposedHypothesis[]; tested: number; confoundedFiltered: number }

/**
 * Scans every (dimension, segment) pair, keeps the ones that survive:
 * minimum sample -> minimum effect -> BH false-discovery control ->
 * service-mix adjustment (CMH). Pure function; no I/O.
 */
export function discoverHypotheses(jobs: JobFeature[]): DiscoveryOutcome {
  interface Candidate {
    dim: FieldDimension; key: string; seg: JobFeature[]; cmp: JobFeature[];
    segC: Counts; cmpC: Counts; test: ProportionTest;
  }
  const candidates: Candidate[] = [];
  const dims = Object.keys(KEY_OF) as FieldDimension[];

  for (const dim of dims) {
    const groups = new Map<string, JobFeature[]>();
    for (const j of jobs) {
      const key = KEY_OF[dim](j);
      if (key === null) continue;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(j);
    }
    for (const [key, seg] of groups) {
      if (seg.length < MIN_ARM_N) continue;
      const def: SegmentDefinition = { dimension: dim, key, techId: seg[0].techId ?? undefined, equipment: seg[0].equipment ?? undefined };
      const cmp = jobs.filter((j) => inComparison(def, j));
      if (cmp.length < MIN_ARM_N) continue;
      const segC = countOf(seg);
      const cmpC = countOf(cmp);
      if (segC.k + cmpC.k < MIN_TOTAL_EVENTS) continue;
      candidates.push({ dim, key, seg, cmp, segC, cmpC, test: twoProportionTest(segC, cmpC) });
    }
  }

  const q = benjaminiHochberg(candidates.map((c) => c.test.p));
  const proposals: ProposedHypothesis[] = [];
  let confoundedFiltered = 0;

  candidates.forEach((c, i) => {
    if (q[i] > FDR_Q || Math.abs(c.test.diff) * 100 < MIN_EFFECT_PP) return;

    // Service-mix adjustment: stratify by service type (skipped when service type IS the segment).
    let adjP: number | null = null, adjOr: number | null = null, strata = 0, adjSig = true;
    if (c.dim !== 'service_type') {
      const byService = new Map<string, { a: number; b: number; c: number; d: number }>();
      const bump = (j: JobFeature, isSeg: boolean) => {
        const s = byService.get(j.service ?? 'unknown') ?? { a: 0, b: 0, c: 0, d: 0 };
        if (isSeg) {
          if (j.callback) s.a++; else s.b++;
        } else if (j.callback) s.c++; else s.d++;
        byService.set(j.service ?? 'unknown', s);
      };
      c.seg.forEach((j) => bump(j, true));
      c.cmp.forEach((j) => bump(j, false));
      const cmh = cochranMantelHaenszel([...byService.values()]);
      if (cmh) {
        adjP = cmh.p; adjOr = cmh.oddsRatio; strata = cmh.strata;
        const sameDirection = adjOr !== null && (c.test.diff > 0 ? adjOr > 1 : adjOr < 1);
        adjSig = cmh.p < ALPHA && sameDirection;
      }
    }
    if (!adjSig) { confoundedFiltered++; return; }

    const direction: HypothesisDirection = c.test.diff > 0 ? 'worse' : 'better';
    const label = labelFor(c.dim, c.seg[0]);
    const segPct = round1(c.test.p_treat * 100);
    const cmpPct = round1(c.test.p_ctrl * 100);
    const pp = round1(Math.abs(c.test.diff) * 100);
    const against = c.dim === 'tech_x_equipment' ? 'other technicians on the same equipment' : 'comparable jobs';
    const skip: FieldDimension[] = [c.dim, ...(c.dim === 'tech_x_equipment' ? (['equipment_type'] as FieldDimension[]) : [])];

    proposals.push({
      dedupe_key: `${c.dim}:${c.key}:${direction}`,
      segment_dimension: c.dim,
      segment_label: label,
      segment_definition: { dimension: c.dim, key: c.key, techId: c.seg[0].techId ?? undefined, equipment: c.seg[0].equipment ?? undefined },
      direction,
      statement: `Jobs assigned to ${label} have a ${pp} pp ${direction === 'worse' ? 'higher' : 'lower'} ${CALLBACK_WINDOW_DAYS}-day callback rate (${segPct}% vs ${cmpPct}%) than ${against}.`,
      discovery: {
        segment_n: c.segC.n, segment_k: c.segC.k, segment_rate_pct: segPct,
        comparison_n: c.cmpC.n, comparison_k: c.cmpC.k, comparison_rate_pct: cmpPct,
        diff_pp: round1(c.test.diff * 100), ci_low_pp: round1(c.test.ci_low * 100), ci_high_pp: round1(c.test.ci_high * 100),
        z: round3(c.test.z), p_value: Number(c.test.p.toPrecision(3)), q_value: Number(q[i].toPrecision(3)),
        adjusted_p: adjP === null ? null : Number(adjP.toPrecision(3)),
        adjusted_or: adjOr === null ? null : round3(adjOr),
        adjusted_significant: adjSig, strata_used: strata,
        tested_segments: candidates.length, lookback_days: LOOKBACK_DAYS, window_days: CALLBACK_WINDOW_DAYS,
        jobs_per_day: round3(c.segC.n / LOOKBACK_DAYS), comparison_jobs_per_day: round3(c.cmpC.n / LOOKBACK_DAYS),
        drilldown: drilldown(c.seg, c.cmp, skip),
      },
    });
  });

  proposals.sort((a, b) => Math.abs(b.discovery.z) - Math.abs(a.discovery.z));
  return { proposals: proposals.slice(0, MAX_PROPOSALS), tested: candidates.length, confoundedFiltered };
}

// ============================================================
// EXPERIMENT DESIGN + EXECUTION
// ============================================================

export function tagPrefixOf(h: Pick<FieldHypothesis, 'id'>): string {
  return `fs:${h.id.slice(0, 8)}`;
}

/**
 * Pre-registers the experiment. The intervention always aims to LOWER the
 * callback rate: for a 'worse' segment it is applied to that segment's jobs
 * (target = comparison rate); for a 'better' segment the segment's practice is
 * applied to the comparison population (target = the segment's rate).
 */
export function buildExperimentDesign(h: FieldHypothesis, cause: CandidateCause): ExperimentDesign {
  const d = h.discovery;
  const worse = h.direction === 'worse';
  const control = worse ? d.segment_rate_pct : d.comparison_rate_pct;
  const target = worse ? d.comparison_rate_pct : d.segment_rate_pct;
  const nPerArm = Math.max(MIN_ARM_N, requiredSampleSizePerArm(control / 100, target / 100));
  const perDay = worse ? d.jobs_per_day : d.comparison_jobs_per_day;
  const fillDays = Number.isFinite(nPerArm) && perDay > 0 ? Math.ceil((2 * nPerArm) / perDay) : 9999;
  const totalDays = fillDays + CALLBACK_WINDOW_DAYS;

  return {
    cause_id: cause.id,
    cause_label: cause.label,
    intervention: cause.intervention,
    control_desc: 'Business as usual — no change to how the job is done.',
    eligible: worse ? 'segment' : 'comparison',
    randomization: 'Per job: FNV-1a hash of seed + job id, 50/50. Assigned while the job is still scheduled, before any outcome exists.',
    seed: crypto.randomUUID().slice(0, 8),
    tag_prefix: tagPrefixOf(h),
    primary_metric: `Callback within ${CALLBACK_WINDOW_DAYS} days of completion`,
    callback_window_days: CALLBACK_WINDOW_DAYS,
    alpha: ALPHA,
    power: POWER,
    control_rate_pct: control,
    target_rate_pct: target,
    n_per_arm: Number.isFinite(nPerArm) ? nPerArm : 0,
    expected_days: totalDays,
    underpowered: !Number.isFinite(nPerArm) || totalDays > 180,
    stop_rule: 'No early stopping and no peeking-based verdicts: accept/reject only once both arms reach n per arm with mature outcomes.',
  };
}

export async function logEvent(hypothesisId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
  // Audit trail is best-effort: a logging failure must never block the science.
  await supabase.from('field_hypothesis_events').insert({ hypothesis_id: hypothesisId, event_type: eventType, payload });
}

export async function selectCause(h: FieldHypothesis, causeId: string): Promise<void> {
  const cause = h.candidate_causes.find((c) => c.id === causeId);
  if (!cause) throw new Error('Unknown cause');
  const design = buildExperimentDesign(h, cause);
  const { error } = await supabase
    .from('field_hypotheses')
    .update({ selected_cause_id: causeId, experiment_design: design })
    .eq('id', h.id);
  if (error) throw error;
  await logEvent(h.id, 'design_registered', { cause_id: causeId, n_per_arm: design.n_per_arm, seed: design.seed });
}

/** Tags still-scheduled eligible jobs with their arm. Idempotent: already-tagged jobs are skipped. */
export async function assignExperimentArms(h: FieldHypothesis): Promise<{ treatment: number; control: number }> {
  const design = h.experiment_design;
  if (!design) throw new Error('No registered design');
  const scheduled = await loadScheduledJobs();
  const eligible = scheduled.filter(
    (j) => (design.eligible === 'segment' ? inSegment(h.segment_definition, j) : inComparison(h.segment_definition, j))
      && !j.tags.some((t) => t.startsWith(`${design.tag_prefix}:`)),
  );
  const tally = { treatment: 0, control: 0 };
  for (let i = 0; i < eligible.length; i += 10) {
    await Promise.all(eligible.slice(i, i + 10).map(async (j) => {
      const arm = assignArm(j.id, design.seed);
      const { error } = await supabase
        .from('jobs')
        .update({ tags: [...j.tags, `${design.tag_prefix}:${arm === 'treatment' ? 't' : 'c'}`] })
        .eq('id', j.id);
      if (error) throw error;
      tally[arm]++;
    }));
  }
  if (eligible.length > 0) await logEvent(h.id, 'arms_assigned', tally);
  return tally;
}

export async function startExperiment(h: FieldHypothesis): Promise<{ treatment: number; control: number }> {
  const design = h.experiment_design;
  if (!design) throw new Error('Pick a cause first');
  const tally = await assignExperimentArms(h);
  const startedAt = new Date();
  const { error } = await supabase
    .from('field_hypotheses')
    .update({
      status: 'testing',
      experiment_started_at: startedAt.toISOString(),
      experiment_ends_at: new Date(startedAt.getTime() + design.expected_days * DAY_MS).toISOString(),
    })
    .eq('id', h.id);
  if (error) throw error;
  await logEvent(h.id, 'experiment_started', { ...tally });
  return tally;
}

/** Reads real outcomes of tagged jobs and scores them. Pure read — nothing is saved here. */
export async function measureExperiment(h: FieldHypothesis): Promise<ExperimentResult> {
  const design = h.experiment_design;
  if (!design || !h.experiment_started_at) throw new Error('Experiment has not started');
  const tagT = `${design.tag_prefix}:t`;
  const tagC = `${design.tag_prefix}:c`;

  const [jobsRes, rework] = await Promise.all([
    supabase.from('jobs').select('id, job_status, completed_at, is_rework, tags').overlaps('tags', [tagT, tagC]).limit(5000),
    fetchReworkMap(h.experiment_started_at),
  ]);
  if (jobsRes.error) throw jobsRes.error;

  const matureBefore = Date.now() - CALLBACK_WINDOW_DAYS * DAY_MS;
  const treatment: Counts = { n: 0, k: 0 };
  const control: Counts = { n: 0, k: 0 };
  let pending = 0;

  for (const j of (jobsRes.data ?? []) as Array<{ id: string; job_status: string; completed_at: string | null; is_rework: boolean | null; tags: string[] | null }>) {
    if (j.is_rework) continue; // a callback visit is an outcome, never a unit
    const completedAt = j.completed_at ? new Date(j.completed_at).getTime() : null;
    if (j.job_status !== 'completed' || completedAt === null || completedAt > matureBefore) { pending++; continue; }
    const arm = (j.tags ?? []).includes(tagT) ? treatment : control;
    arm.n++;
    const reworkAt = rework.get(j.id);
    if (reworkAt !== undefined && reworkAt <= completedAt + CALLBACK_WINDOW_DAYS * DAY_MS) arm.k++;
  }

  const complete = treatment.n >= design.n_per_arm && control.n >= design.n_per_arm && design.n_per_arm > 0;
  const test = treatment.n > 0 && control.n > 0 ? twoProportionTest(treatment, control) : null;
  const designedDelta = (design.target_rate_pct - design.control_rate_pct) / 100; // negative = fewer callbacks
  const evaluatedAt = new Date().toISOString();

  if (!complete || !test) {
    return {
      treatment, control, test, complete: false, verdict: 'collecting', pending_jobs: pending, evaluated_at: evaluatedAt,
      reasoning: `Collecting: ${treatment.n}/${design.n_per_arm} treatment and ${control.n}/${design.n_per_arm} control jobs have mature outcomes. No verdict before the pre-registered sample is reached.`,
    };
  }

  const pct = (x: number) => `${round1(x * 100)}%`;
  const detail = `treatment ${pct(test.p_treat)} vs control ${pct(test.p_ctrl)} (n=${treatment.n}/${control.n}, diff ${round1(test.diff * 100)} pp, 95% CI ${round1(test.ci_low * 100)} to ${round1(test.ci_high * 100)} pp, p=${test.p.toPrecision(2)})`;

  if (test.p < design.alpha && test.diff < 0) {
    return { treatment, control, test, complete, verdict: 'accepted', pending_jobs: pending, evaluated_at: evaluatedAt, reasoning: `Accepted — the intervention significantly reduced callbacks: ${detail}.` };
  }
  if (test.p < design.alpha && test.diff > 0) {
    return { treatment, control, test, complete, verdict: 'rejected', pending_jobs: pending, evaluated_at: evaluatedAt, reasoning: `Rejected — callbacks significantly increased under the intervention: ${detail}.` };
  }
  if (test.ci_high > designedDelta / 2) {
    return { treatment, control, test, complete, verdict: 'rejected', pending_jobs: pending, evaluated_at: evaluatedAt, reasoning: `Rejected — fully powered, and even the best plausible effect is under half of the benefit that was needed: ${detail}.` };
  }
  return { treatment, control, test, complete, verdict: 'inconclusive', pending_jobs: pending, evaluated_at: evaluatedAt, reasoning: `Inconclusive — a meaningful benefit is neither confirmed nor ruled out: ${detail}.` };
}

// ============================================================
// VERDICT + PLAYBOOK WRITE-BACK
// ============================================================

async function writePlaybookEntry(h: FieldHypothesis, result: ExperimentResult): Promise<string | null> {
  const design = h.experiment_design;
  if (!design || !result.test || (result.verdict !== 'accepted' && result.verdict !== 'rejected')) return null;
  const accepted = result.verdict === 'accepted';
  const { data, error } = await supabase
    .from('org_memory_entries')
    .upsert({
      entry_type: accepted ? 'winning_playbook' : 'failure_pattern',
      title: accepted ? `Field-tested fix: ${design.cause_label}` : `Did not work: ${design.cause_label}`,
      situation: h.statement,
      action_taken: design.intervention,
      outcome_summary: result.reasoning,
      confidence_score: accepted ? (result.test.p < 0.01 ? 85 : 75) : 70,
      sample_size: result.treatment.n + result.control.n,
      tags: ['field-scientist', h.segment_dimension.replace(/_/g, '-')],
      status: 'active',
      source: 'manual',
      dedupe_key: `field_scientist:${h.id}`,
    }, { onConflict: 'user_id,dedupe_key' })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * Saves the verdict. If the planned sample was not reached the result is
 * ALWAYS 'inconclusive' — a forced early stop can never accept or reject.
 */
export async function concludeExperiment(h: FieldHypothesis): Promise<ExperimentResult> {
  const measured = await measureExperiment(h);
  const result: ExperimentResult = measured.complete
    ? measured
    : { ...measured, verdict: 'inconclusive', reasoning: `Stopped before the pre-registered sample was reached — ${measured.reasoning} Early stops are never allowed to accept or reject.` };

  const entryId = await writePlaybookEntry(h, result);
  const verdict = result.verdict as Exclude<ExperimentResult['verdict'], 'collecting'>;
  const { error } = await supabase
    .from('field_hypotheses')
    .update({
      status: verdict,
      experiment_result: result,
      verdict_reasoning: result.reasoning,
      playbook_entry_id: entryId,
      decided_at: new Date().toISOString(),
    })
    .eq('id', h.id);
  if (error) throw error;
  await logEvent(h.id, 'verdict', { verdict, playbook_entry_id: entryId });
  return result;
}

// ============================================================
// ORCHESTRATION + CRUD
// ============================================================

export interface DiscoveryRunSummary { jobs: number; tested: number; confoundedFiltered: number; created: number; notEnoughData: boolean }

/** Mines the data, stores new hypotheses (existing ones are never duplicated), then asks the AI for causes. */
export async function runDiscovery(): Promise<DiscoveryRunSummary> {
  const jobs = await loadMatureJobs();
  if (jobs.length < MIN_ARM_N * 2) return { jobs: jobs.length, tested: 0, confoundedFiltered: 0, created: 0, notEnoughData: true };

  const { proposals, tested, confoundedFiltered } = discoverHypotheses(jobs);
  if (proposals.length === 0) return { jobs: jobs.length, tested, confoundedFiltered, created: 0, notEnoughData: false };

  const { data, error } = await supabase
    .from('field_hypotheses')
    .upsert(proposals, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;

  const createdIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  await Promise.allSettled(createdIds.slice(0, MAX_AI_PER_RUN).map((id) => requestCauses(id)));
  await Promise.all(createdIds.map((id) => logEvent(id, 'discovered')));
  return { jobs: jobs.length, tested, confoundedFiltered, created: createdIds.length, notEnoughData: false };
}

export async function requestCauses(hypothesisId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('field-scientist-hypothesize', { method: 'POST', body: { hypothesis_id: hypothesisId } });
  if (error) throw error;
}

export async function fetchHypotheses(): Promise<FieldHypothesis[]> {
  const { data, error } = await supabase
    .from('field_hypotheses')
    .select('*')
    .neq('status', 'dismissed')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as FieldHypothesis[]) ?? [];
}

export async function dismissHypothesis(id: string): Promise<void> {
  const { error } = await supabase.from('field_hypotheses').update({ status: 'dismissed', decided_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
  await logEvent(id, 'dismissed');
}

// ============================================================
// DISPLAY HELPERS
// ============================================================

export const STATUS_LABELS: Record<HypothesisStatus, string> = {
  proposed: 'Analyzing causes', ready: 'Ready to test', testing: 'Experiment running',
  accepted: 'Accepted', rejected: 'Rejected', inconclusive: 'Inconclusive', dismissed: 'Dismissed',
};

export const STATUS_COLORS: Record<HypothesisStatus, string> = {
  proposed: 'bg-accent/10 text-accent', ready: 'bg-accent/10 text-accent',
  testing: 'bg-warning-500/10 text-warning-500', accepted: 'bg-success-500/10 text-success-500',
  rejected: 'bg-danger/10 text-danger', inconclusive: 'bg-bg-tertiary text-text-secondary',
  dismissed: 'bg-bg-tertiary text-text-secondary',
};
