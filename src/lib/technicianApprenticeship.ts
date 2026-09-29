/**
 * Vireek Technician Apprenticeship Engine - pure client library.
 *
 * Separate from plain training. Given a technician and a target level it
 * answers: "what exactly is missing?" and then builds, per missing
 * competency, the full path
 *
 *   Job -> Learning -> Simulation -> Assessment -> Certification -> Real Job
 *
 * Design rules (same philosophy as the Skill Graph, Simulator and Trust
 * Passport):
 * - No LLM decides anything here. Every number is deterministic and explainable.
 * - No new evidence pipeline. Scores are derived from data that already exists:
 *   real-job proficiency (Skill Graph), server-scored simulator attempts, and
 *   customer ratings.
 * - Stage state is DERIVED, never stored. The only self-attested stage is
 *   Learning, and it can never lift a certification on its own.
 * - This file does no I/O. Callers pass data in, which keeps it testable.
 */

import type { Job, ReviewRequest, TeamMember } from '@/lib/supabase';
import type { SkillGraph, SkillNode } from '@/lib/technicianSkillGraph';
import {
  SIM_SCORE_MAX,
  SIM_TRADE_META,
  tradeForServiceType,
  type SimDifficulty,
  type SimScoreBreakdown,
  type SimTrade,
} from '@/lib/technicianSimulator';
import { lessonsFor } from '@/lib/apprenticeshipLessons';

// ============================================================
// TYPES
// ============================================================

export type ApprenticeshipLevel = 1 | 2 | 3 | 4 | 5;
export type StageId =
  'job' | 'learning' | 'simulation' | 'assessment' | 'certification' | 'real_job';
export type StageState = 'done' | 'active' | 'locked';
export type Confidence = 'none' | 'low' | 'medium' | 'high';
export type ApprenticeshipStatus =
  'no_scope' | 'closing_gaps' | 'needs_assessment' | 'proving_on_jobs' | 'certified';

export type CompetencyId =
  | 'hvac_refrigerant'
  | 'hvac_airflow_controls'
  | 'plumbing_leak_drain'
  | 'plumbing_water_heating'
  | 'electrical_fault'
  | 'appliance_diagnosis'
  | 'diagnostic_reasoning'
  | 'evidence_testing'
  | 'safety_compliance'
  | 'customer_communication'
  | 'parts_decisions'
  | 'confidence_calibration';

export interface CompetencyDef {
  id: CompetencyId;
  label: string;
  domain: 'technical' | 'core';
  trade: SimTrade | null;
  weight: number;
  pattern: RegExp | null;
  simDimension: keyof SimScoreBreakdown | null;
}

/** One submitted simulator attempt, as returned by get_apprenticeship_sim_evidence(). */
export interface SimEvidenceRow {
  technician_id: string;
  trade: SimTrade;
  difficulty: SimDifficulty;
  score: number;
  passed: boolean;
  submitted_at: string;
  breakdown: Partial<SimScoreBreakdown> | null;
}

export interface CompetencyResult {
  id: CompetencyId;
  label: string;
  domain: 'technical' | 'core';
  trade: SimTrade | null;
  score: number | null; // null = no evidence yet
  required: number;
  confidence: Confidence;
  evidence: { jobs: number; simulations: number };
  critical: boolean;
  shortfall: number; // points below the requirement, 0 when met
  impactPoints: number; // readiness points this gap costs overall
}

export interface PathwayStage {
  id: StageId;
  label: string;
  state: StageState;
  detail: string;
}

export interface PathwayLesson {
  id: string;
  title: string;
  minutes: number;
  done: boolean;
}

export interface Pathway {
  competencyId: CompetencyId;
  label: string;
  isGap: boolean;
  score: number | null;
  required: number;
  stages: PathwayStage[];
  activeStage: StageId | null;
  nextAction: string;
  simulatorTrade: SimTrade | null;
  mentor: { id: string; name: string } | null;
  lessons: PathwayLesson[];
}

export interface ApprenticeshipAssessment {
  technicianId: string;
  technicianName: string;
  targetLevel: ApprenticeshipLevel;
  levelLabel: string;
  currentLevel: 0 | ApprenticeshipLevel;
  scopeTrades: SimTrade[];
  readiness: number;
  targetReadiness: number;
  gapPoints: number;
  status: ApprenticeshipStatus;
  competencies: CompetencyResult[];
  gaps: CompetencyResult[];
  pathways: Pathway[];
  next: {
    competencyId: CompetencyId;
    label: string;
    stage: StageId;
    action: string;
    simulatorTrade: SimTrade | null;
  } | null;
  stageProgressPct: number;
  generatedAt: string;
}

export interface ApprenticeshipInput {
  technician: TeamMember;
  jobs: Job[]; // full unfiltered history, any technician
  reviews: ReviewRequest[];
  graph: SkillGraph; // computeSkillGraph() output, computed once by the caller
  simRows: SimEvidenceRow[]; // this technician's submitted attempts
  completedLessonIds: ReadonlySet<string>;
  targetLevel: ApprenticeshipLevel;
  trades: SimTrade[]; // scope; empty falls back to inferTrades()
  now?: Date;
}

// ============================================================
// FRAMEWORK
// ============================================================

export const APPRENTICESHIP_LEVELS: Record<
  ApprenticeshipLevel,
  { label: string; readiness: number; difficulty: SimDifficulty }
> = {
  1: { label: 'Trainee', readiness: 40, difficulty: 'foundation' },
  2: { label: 'Apprentice', readiness: 55, difficulty: 'foundation' },
  3: { label: 'Journeyman', readiness: 70, difficulty: 'professional' },
  4: { label: 'Senior Technician', readiness: 85, difficulty: 'professional' },
  5: { label: 'Master Technician', readiness: 92, difficulty: 'master' },
};

export const APPRENTICESHIP_LEVEL_LIST: ApprenticeshipLevel[] = [1, 2, 3, 4, 5];

/** Safety is a hard gate from Journeyman up: overall readiness can never compensate for it. */
export const SAFETY_FLOOR = 80;
export const SAFETY_FLOOR_FROM_LEVEL: ApprenticeshipLevel = 3;

const JOB_EXPOSURE_MIN = 3;
const CORE_EXPOSURE_MIN = 5;
const SIM_PRACTICE_MIN = 2;
const REAL_JOB_PROOF_MIN = 2;
const MIN_PROOF_RATING = 4;
const RECENT_SIM_ATTEMPTS = 5;
const MENTOR_MIN_JOBS = 3;
const DIFFICULTY_RANK: Record<SimDifficulty, number> = {
  foundation: 1,
  professional: 2,
  master: 3,
};

export const COMPETENCIES: CompetencyDef[] = [
  {
    id: 'hvac_refrigerant',
    label: 'Refrigerant diagnosis',
    domain: 'technical',
    trade: 'hvac',
    weight: 1.5,
    pattern:
      /(refrigerant|recharge|compressor|condens|evaporator|heat ?pump|a\/c|\bac\b|air ?con|cooling|coil)/i,
    simDimension: null,
  },
  {
    id: 'hvac_airflow_controls',
    label: 'Airflow, heating & controls',
    domain: 'technical',
    trade: 'hvac',
    weight: 1.5,
    pattern: /(furnace|heating|thermostat|duct|blower|airflow|ventilat|air handler)/i,
    simDimension: null,
  },
  {
    id: 'plumbing_leak_drain',
    label: 'Leak & drain diagnosis',
    domain: 'technical',
    trade: 'plumbing',
    weight: 1.5,
    pattern: /(leak|drain|sewer|pipe|toilet|faucet|sump|clog|disposal)/i,
    simDimension: null,
  },
  {
    id: 'plumbing_water_heating',
    label: 'Water heater service',
    domain: 'technical',
    trade: 'plumbing',
    weight: 1.5,
    pattern: /(water heater|tankless|boiler)/i,
    simDimension: null,
  },
  {
    id: 'electrical_fault',
    label: 'Electrical fault isolation',
    domain: 'technical',
    trade: 'electrical',
    weight: 1.5,
    pattern: /(electric|breaker|panel|outlet|wiring|circuit|lighting|generator|ev charger)/i,
    simDimension: null,
  },
  {
    id: 'appliance_diagnosis',
    label: 'Appliance diagnosis',
    domain: 'technical',
    trade: 'appliance',
    weight: 1.5,
    pattern:
      /(appliance|washer|dryer|dishwasher|refrigerator|fridge|oven|range|microwave|freezer)/i,
    simDimension: null,
  },
  {
    id: 'diagnostic_reasoning',
    label: 'Diagnostic reasoning',
    domain: 'core',
    trade: null,
    weight: 1.3,
    pattern: null,
    simDimension: 'diagnosis',
  },
  {
    id: 'evidence_testing',
    label: 'Evidence-based testing',
    domain: 'core',
    trade: null,
    weight: 1,
    pattern: null,
    simDimension: 'evidence',
  },
  {
    id: 'safety_compliance',
    label: 'Safety compliance',
    domain: 'core',
    trade: null,
    weight: 1.5,
    pattern: null,
    simDimension: 'safety',
  },
  {
    id: 'customer_communication',
    label: 'Customer communication',
    domain: 'core',
    trade: null,
    weight: 1.2,
    pattern: null,
    simDimension: 'information',
  },
  {
    id: 'parts_decisions',
    label: 'Parts & repair decisions',
    domain: 'core',
    trade: null,
    weight: 0.8,
    pattern: null,
    simDimension: 'parts_decision',
  },
  {
    id: 'confidence_calibration',
    label: 'Confidence calibration',
    domain: 'core',
    trade: null,
    weight: 0.5,
    pattern: null,
    simDimension: 'calibration',
  },
];

// ============================================================
// SMALL HELPERS
// ============================================================

function round(n: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function blend(parts: { value: number | null; weight: number }[]): number | null {
  const usable = parts.filter((p): p is { value: number; weight: number } => p.value !== null);
  const total = usable.reduce((s, p) => s + p.weight, 0);
  if (total === 0) return null;
  return round(usable.reduce((s, p) => s + p.value * p.weight, 0) / total);
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

function jobTime(job: Job): number | null {
  const at = job.completed_at ?? job.scheduled_datetime;
  if (!at) return null;
  const t = new Date(at).getTime();
  return Number.isNaN(t) ? null : t;
}

function confidenceFor(jobs: number, simulations: number): Confidence {
  const points = jobs + simulations * 2;
  if (points === 0) return 'none';
  if (points < 4) return 'low';
  if (points < 10) return 'medium';
  return 'high';
}

export function requiredScore(def: CompetencyDef, level: ApprenticeshipLevel): number {
  const base = APPRENTICESHIP_LEVELS[level].readiness;
  return def.id === 'safety_compliance' && level >= SAFETY_FLOOR_FROM_LEVEL
    ? Math.max(base, SAFETY_FLOOR)
    : base;
}

function dimensionPct(row: SimEvidenceRow, dim: keyof SimScoreBreakdown): number | null {
  const raw = row.breakdown?.[dim];
  if (typeof raw !== 'number') return null;
  return clamp((raw / SIM_SCORE_MAX[dim]) * 100, 0, 100);
}

function byNewest(rows: SimEvidenceRow[]): SimEvidenceRow[] {
  return [...rows].sort(
    (a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
  );
}

function jobEvidence(
  nodes: SkillNode[],
  def: CompetencyDef,
): { score: number | null; count: number } {
  const pattern = def.pattern;
  if (!pattern) return { score: null, count: 0 };
  const matched = nodes.filter((n) => n.sampleSize > 0 && pattern.test(n.serviceType));
  const count = matched.reduce((s, n) => s + n.sampleSize, 0);
  if (count === 0) return { score: null, count: 0 };
  return {
    score: round(matched.reduce((s, n) => s + n.proficiencyScore * n.sampleSize, 0) / count),
    count,
  };
}

/** Which trades a technician actually works in, from job history first, then their declared skills. */
export function inferTrades(technician: TeamMember, graph: SkillGraph): SimTrade[] {
  const counts = new Map<SimTrade, number>();
  for (const n of graph.nodesByTechnician.get(technician.id) ?? []) {
    if (n.sampleSize === 0) continue;
    const trade = tradeForServiceType(n.serviceType);
    if (trade) counts.set(trade, (counts.get(trade) ?? 0) + n.sampleSize);
  }
  if (counts.size === 0) {
    for (const skill of technician.skills ?? []) {
      const trade = tradeForServiceType(skill);
      if (trade) counts.set(trade, (counts.get(trade) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([trade]) => trade);
}

export function estimateLevel(
  readiness: number,
  safetyScore: number | null,
): 0 | ApprenticeshipLevel {
  for (const level of [5, 4, 3, 2, 1] as ApprenticeshipLevel[]) {
    if (readiness < APPRENTICESHIP_LEVELS[level].readiness) continue;
    if (level >= SAFETY_FLOOR_FROM_LEVEL && (safetyScore ?? 0) < SAFETY_FLOOR) continue;
    return level;
  }
  return 0;
}

// ============================================================
// ENGINE
// ============================================================

export function computeApprenticeship(input: ApprenticeshipInput): ApprenticeshipAssessment {
  const { technician, graph, completedLessonIds, targetLevel } = input;
  const now = input.now ?? new Date();
  const techId = technician.id;
  const technicianName = technician.member_name || technician.member_email || 'Unnamed technician';
  const scopeTrades = input.trades.length > 0 ? input.trades : inferTrades(technician, graph);
  const levelMeta = APPRENTICESHIP_LEVELS[targetLevel];
  const inScope = COMPETENCIES.filter(
    (c) => c.domain === 'core' || (c.trade !== null && scopeTrades.includes(c.trade)),
  );

  const myNodes = graph.nodesByTechnician.get(techId) ?? [];
  const totalCompleted = myNodes.reduce((s, n) => s + n.sampleSize, 0);
  const simRows = byNewest(input.simRows.filter((r) => r.technician_id === techId));
  const scopedSimRows =
    scopeTrades.length > 0 ? simRows.filter((r) => scopeTrades.includes(r.trade)) : simRows;

  // Real-job signals used to back up simulator evidence on core competencies.
  const myJobs = input.jobs.filter(
    (j) => j.assigned_technician_id === techId && j.job_status === 'completed',
  );
  const myJobIds = new Set(myJobs.map((j) => j.id));
  const ratings = input.reviews
    .filter((r) => r.rating !== null && r.job_id && myJobIds.has(r.job_id))
    .map((r) => r.rating as number);
  const csatPct = ratings.length > 0 ? round(((average(ratings) as number) / 5) * 100) : null;
  const ftfNodes = myNodes.filter((n) => n.firstTimeFixRate !== null && n.sampleSize > 0);
  const ftfCount = ftfNodes.reduce((s, n) => s + n.sampleSize, 0);
  const ftfPct =
    ftfCount > 0
      ? round(
          ftfNodes.reduce((s, n) => s + (n.firstTimeFixRate as number) * n.sampleSize, 0) /
            ftfCount,
        )
      : null;

  const reworkedOriginalIds = new Set(
    input.jobs
      .filter((j) => j.is_rework && j.rework_of_job_id)
      .map((j) => j.rework_of_job_id as string),
  );
  const lowRatedJobIds = new Set(
    input.reviews
      .filter((r) => r.rating !== null && (r.rating as number) < MIN_PROOF_RATING && r.job_id)
      .map((r) => r.job_id as string),
  );

  // ---- competency scoring -------------------------------------------------
  const results: CompetencyResult[] = [];
  const totalWeight = inScope.reduce((s, c) => s + c.weight, 0);

  const attemptsFor = (def: CompetencyDef): SimEvidenceRow[] =>
    def.domain === 'technical' ? simRows.filter((r) => r.trade === def.trade) : scopedSimRows;

  for (const def of inScope) {
    const attempts = attemptsFor(def);
    const recent = attempts.slice(0, RECENT_SIM_ATTEMPTS);
    let score: number | null;
    let jobs = 0;

    if (def.domain === 'technical') {
      const jobEv = jobEvidence(myNodes, def);
      jobs = jobEv.count;
      score = blend([
        { value: jobEv.score, weight: 0.7 },
        { value: average(recent.map((r) => r.score)), weight: 0.3 },
      ]);
    } else {
      const dim = def.simDimension as keyof SimScoreBreakdown;
      const simPct = average(
        recent.map((r) => dimensionPct(r, dim)).filter((v): v is number => v !== null),
      );
      const real =
        def.id === 'customer_communication'
          ? csatPct
          : def.id === 'diagnostic_reasoning' || def.id === 'parts_decisions'
            ? ftfPct
            : null;
      jobs = def.id === 'customer_communication' ? ratings.length : real !== null ? ftfCount : 0;
      score = blend([
        { value: simPct, weight: 0.7 },
        { value: real, weight: 0.3 },
      ]);
    }

    const required = requiredScore(def, targetLevel);
    const shortfall = Math.max(0, round(required - (score ?? 0)));
    results.push({
      id: def.id,
      label: def.label,
      domain: def.domain,
      trade: def.trade,
      score,
      required,
      confidence: confidenceFor(jobs, recent.length),
      evidence: { jobs, simulations: recent.length },
      critical: def.id === 'safety_compliance' && targetLevel >= SAFETY_FLOOR_FROM_LEVEL,
      shortfall,
      impactPoints: totalWeight > 0 ? round((def.weight / totalWeight) * shortfall) : 0,
    });
  }

  const readiness =
    totalWeight > 0
      ? round(
          inScope.reduce((s, def, i) => s + def.weight * (results[i].score ?? 0), 0) / totalWeight,
        )
      : 0;
  const gaps = results
    .filter((r) => r.shortfall > 0)
    .sort((a, b) => b.impactPoints - a.impactPoints);
  const safetyScore = results.find((r) => r.id === 'safety_compliance')?.score ?? null;

  // ---- pathways -----------------------------------------------------------
  const pathways: Pathway[] = inScope.map((def, i) => {
    const result = results[i];
    const attempts = attemptsFor(def);
    const lessons = lessonsFor(def.id).map((l) => ({
      id: l.id,
      title: l.title,
      minutes: l.minutes,
      done: completedLessonIds.has(l.id),
    }));
    const simulatorTrade: SimTrade | null = def.trade ?? scopeTrades[0] ?? null;
    const tradeLabel = simulatorTrade ? SIM_TRADE_META[simulatorTrade].label : 'any-trade';
    const difficulty = levelMeta.difficulty;

    // Stage 1 - Job: real-job exposure to this competency.
    const exposure = def.domain === 'technical' ? result.evidence.jobs : totalCompleted;
    const exposureNeeded = def.domain === 'technical' ? JOB_EXPOSURE_MIN : CORE_EXPOSURE_MIN;
    const jobDone = exposure >= exposureNeeded;

    // Mentor: strongest teammate on the same competency.
    let mentor: { id: string; name: string } | null = null;
    if (def.domain === 'technical') {
      let best = -1;
      for (const [otherId, nodes] of graph.nodesByTechnician) {
        if (otherId === techId) continue;
        const ev = jobEvidence(nodes, def);
        if (
          ev.score !== null &&
          ev.count >= MENTOR_MIN_JOBS &&
          ev.score >= result.required &&
          ev.score > best
        ) {
          best = ev.score;
          mentor = { id: otherId, name: nodes[0]?.technicianName ?? 'a teammate' };
        }
      }
    }

    // Stage 4 - Assessment: a server-scored pass at the level's difficulty.
    const qualifying = attempts.filter((r) => {
      if (!r.passed || DIFFICULTY_RANK[r.difficulty] < DIFFICULTY_RANK[difficulty]) return false;
      if (def.domain === 'technical') return r.score >= result.required;
      return (
        (dimensionPct(r, def.simDimension as keyof SimScoreBreakdown) ?? -1) >= result.required
      );
    });
    const assessmentDone = qualifying.length > 0;
    const passedAt = assessmentDone ? new Date(qualifying[0].submitted_at).getTime() : null; // newest first

    // Stage 2 / 3 - Learning and Simulation.
    const lessonsDone = lessons.length === 0 || lessons.every((l) => l.done);
    const simDone = attempts.length >= SIM_PRACTICE_MIN || assessmentDone;

    // Stage 5 - Certification: cleared to take level-appropriate work.
    const certDone = lessonsDone && assessmentDone;

    // Stage 6 - Real Job: clean, well-rated jobs completed after the assessment.
    const pattern = def.pattern;
    const cleanJobs =
      passedAt === null
        ? 0
        : myJobs.filter((j) => {
            const t = jobTime(j);
            if (t === null || t <= passedAt) return false;
            if (pattern && !pattern.test(j.service_type ?? '')) return false;
            if (j.is_rework || reworkedOriginalIds.has(j.id) || lowRatedJobIds.has(j.id))
              return false;
            return true;
          }).length;
    const realJobDone = assessmentDone && cleanJobs >= REAL_JOB_PROOF_MIN;

    const doneFlags: Record<StageId, boolean> = {
      job: jobDone,
      learning: lessonsDone,
      simulation: simDone,
      assessment: assessmentDone,
      certification: certDone,
      real_job: realJobDone,
    };
    const details: Record<StageId, string> = {
      job: jobDone
        ? `${exposure} completed job${exposure === 1 ? '' : 's'} of real exposure`
        : mentor
          ? `${exposure}/${exposureNeeded} jobs. Shadow ${mentor.name}, the strongest on your team`
          : `${exposure}/${exposureNeeded} jobs. Get assigned supervised work in this area`,
      learning: `${lessons.filter((l) => l.done).length}/${lessons.length} lesson${lessons.length === 1 ? '' : 's'} complete`,
      simulation: `${attempts.length}/${SIM_PRACTICE_MIN} practice attempts`,
      assessment: assessmentDone
        ? `Passed a ${difficulty} scenario at or above ${result.required}%`
        : `Pass a ${difficulty} ${tradeLabel} scenario at or above ${result.required}%`,
      certification: certDone
        ? `Cleared for Level ${targetLevel} work`
        : 'Unlocks after learning and assessment',
      real_job: assessmentDone
        ? `${Math.min(cleanJobs, REAL_JOB_PROOF_MIN)}/${REAL_JOB_PROOF_MIN} clean jobs since assessment`
        : 'Starts after the assessment is passed',
    };
    const labels: Record<StageId, string> = {
      job: 'Job',
      learning: 'Learning',
      simulation: 'Simulation',
      assessment: 'Assessment',
      certification: 'Certification',
      real_job: 'Real Job',
    };
    const order: StageId[] = [
      'job',
      'learning',
      'simulation',
      'assessment',
      'certification',
      'real_job',
    ];
    const activeStage = order.find((s) => !doneFlags[s]) ?? null;
    const stages: PathwayStage[] = order.map((id) => ({
      id,
      label: labels[id],
      state: doneFlags[id] ? 'done' : id === activeStage ? 'active' : 'locked',
      detail: details[id],
    }));

    const pendingLesson = lessons.find((l) => !l.done);
    const actionByStage: Record<StageId, string> = {
      job: mentor
        ? `Ride along with ${mentor.name} on a ${def.label.toLowerCase()} job.`
        : `Get assigned a supervised ${def.label.toLowerCase()} job.`,
      learning: pendingLesson
        ? `Complete the lesson "${pendingLesson.title}".`
        : 'Complete the remaining lessons.',
      simulation: `Run ${SIM_PRACTICE_MIN - Math.min(attempts.length, SIM_PRACTICE_MIN)} more ${tradeLabel} simulation${SIM_PRACTICE_MIN - attempts.length === 1 ? '' : 's'}.`,
      assessment: `Pass a ${difficulty} ${tradeLabel} scenario${def.domain === 'core' ? ` with ${def.label.toLowerCase()} at ${result.required}%+` : ` scoring ${result.required}%+`}.`,
      certification: 'Finish the earlier stages to be cleared.',
      real_job: `Complete ${REAL_JOB_PROOF_MIN - Math.min(cleanJobs, REAL_JOB_PROOF_MIN)} more clean, well-rated job(s) to prove it in the field.`,
    };

    return {
      competencyId: def.id,
      label: def.label,
      isGap: result.shortfall > 0,
      score: result.score,
      required: result.required,
      stages,
      activeStage,
      nextAction: activeStage
        ? actionByStage[activeStage]
        : 'Fully proven. Nothing left to do here.',
      simulatorTrade,
      mentor,
      lessons,
    };
  });

  const impactById = new Map(results.map((r) => [r.id, r.impactPoints]));
  pathways.sort((a, b) => {
    if (a.isGap !== b.isGap) return a.isGap ? -1 : 1;
    return (impactById.get(b.competencyId) ?? 0) - (impactById.get(a.competencyId) ?? 0);
  });

  const allStages = pathways.flatMap((p) => p.stages);
  const stageProgressPct =
    allStages.length > 0
      ? Math.round((allStages.filter((s) => s.state === 'done').length / allStages.length) * 100)
      : 0;

  let status: ApprenticeshipStatus;
  if (inScope.every((c) => c.domain === 'core') && scopeTrades.length === 0) status = 'no_scope';
  else if (gaps.length > 0) status = 'closing_gaps';
  else if (pathways.some((p) => p.stages.find((s) => s.id === 'assessment')?.state !== 'done'))
    status = 'needs_assessment';
  else if (pathways.some((p) => p.stages.find((s) => s.id === 'real_job')?.state !== 'done'))
    status = 'proving_on_jobs';
  else status = 'certified';

  const firstOpen = pathways.find((p) => p.activeStage !== null);
  const next =
    firstOpen && firstOpen.activeStage
      ? {
          competencyId: firstOpen.competencyId,
          label: firstOpen.label,
          stage: firstOpen.activeStage,
          action: firstOpen.nextAction,
          simulatorTrade: firstOpen.simulatorTrade,
        }
      : null;

  return {
    technicianId: techId,
    technicianName,
    targetLevel,
    levelLabel: levelMeta.label,
    currentLevel: estimateLevel(readiness, safetyScore),
    scopeTrades,
    readiness,
    targetReadiness: levelMeta.readiness,
    gapPoints: Math.max(0, round(levelMeta.readiness - readiness)),
    status,
    competencies: results,
    gaps,
    pathways,
    next,
    stageProgressPct,
    generatedAt: now.toISOString(),
  };
}

/** Compact snapshot stored on a plan so progress can be shown against where the technician started. */
export function snapshotScores(
  assessment: ApprenticeshipAssessment,
): Record<string, number | null> {
  return Object.fromEntries(assessment.competencies.map((c) => [c.id, c.score]));
}

export const STATUS_META: Record<
  ApprenticeshipStatus,
  { label: string; tone: 'neutral' | 'warning' | 'accent' | 'success' }
> = {
  no_scope: { label: 'Select a trade', tone: 'neutral' },
  closing_gaps: { label: 'Closing skill gaps', tone: 'warning' },
  needs_assessment: { label: 'Ready for assessment', tone: 'accent' },
  proving_on_jobs: { label: 'Proving on real jobs', tone: 'accent' },
  certified: { label: 'Certified', tone: 'success' },
};
