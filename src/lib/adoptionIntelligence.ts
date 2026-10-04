/**
 * Vireek Change Management / Adoption OS - pure client library.
 *
 * Answers one question per technician: "are they actually using the system?"
 * and then turns the answer into a personalized onboarding plan.
 *
 * Design rules (same philosophy as the Skill Graph, Simulator and Apprenticeship Engine):
 * - No LLM decides anything here. Every number is deterministic and explainable.
 * - No new tracking pipeline. Signals are derived from data that already exists:
 *   AI Copilot sessions linked to completed jobs, job documentation fields,
 *   Evidence Chain entries, customer signatures, lessons and simulator attempts.
 * - Adoption measures enablement, not surveillance: it is computed per completed job,
 *   never from keystrokes, location or time-on-screen.
 * - This file does no I/O and has no imports, which keeps it fully testable.
 */

// ============================================================
// TYPES
// ============================================================

export type AdoptionLevel = 'high' | 'medium' | 'low' | 'insufficient';
export type AdoptionDimension = 'ai' | 'documentation';
export type DocumentationPart = 'photos' | 'diagnosis' | 'work_notes' | 'evidence' | 'signature';
export type AdoptionTrend = 'improving' | 'steady' | 'declining' | 'unknown';
export type InterventionVerdict = 'improved' | 'unchanged' | 'declined' | 'unmeasured';

/** One row per technician, as returned by the get_adoption_signals() RPC. */
export interface AdoptionSignalRow {
  team_member_id: string;
  member_name: string | null;
  member_email: string;
  jobs_completed: number;
  jobs_with_ai: number;
  ai_sessions: number;
  jobs_with_photos: number;
  jobs_with_diagnosis: number;
  jobs_with_work_notes: number;
  jobs_with_evidence: number;
  jobs_with_signature: number;
  lessons_completed: number;
  simulator_attempts: number;
}

export interface DocumentationBreakdownItem {
  part: DocumentationPart;
  label: string;
  /** 0-100, or null when there are no completed jobs to measure. */
  pct: number | null;
  weight: number;
}

export interface TechnicianAdoption {
  technicianId: string;
  name: string;
  jobsCompleted: number;
  aiSessions: number;
  lessonsCompleted: number;
  simulatorAttempts: number;
  /** Share of completed jobs where the technician used an AI copilot, 0-100. */
  aiUsagePct: number | null;
  /** Weighted documentation completeness across completed jobs, 0-100. */
  documentationPct: number | null;
  /** Blended 0-100 adoption score, or null when there is not enough evidence. */
  score: number | null;
  level: AdoptionLevel;
  breakdown: DocumentationBreakdownItem[];
  /** Weakest documentation part, or null when nothing is measurable. */
  weakestPart: DocumentationBreakdownItem | null;
  /** Dimensions below target, biggest weighted shortfall first. */
  gaps: AdoptionDimension[];
}

export interface OnboardingStep {
  id: string;
  dimension: AdoptionDimension | 'learning';
  title: string;
  why: string;
  action: string;
  /** In-app route that opens the tool for this step. */
  href: string | null;
}

export interface AdoptionSummary {
  technicians: number;
  measured: number;
  high: number;
  medium: number;
  low: number;
  insufficient: number;
  /** Share of measured technicians at medium or high, 0-100. */
  adoptionRatePct: number | null;
  avgAiUsagePct: number | null;
  avgDocumentationPct: number | null;
  avgScore: number | null;
  /** Documentation part that is weakest across the whole team. */
  weakestTeamPart: DocumentationPart | null;
}

// ============================================================
// CONSTANTS
// ============================================================

/** Below this many completed jobs a percentage is noise, so no level is assigned. */
export const MIN_JOBS_FOR_LEVEL = 3;
/** Blend weights. They must sum to 1. */
export const SCORE_WEIGHTS = { ai: 0.55, documentation: 0.45 } as const;
export const HIGH_THRESHOLD = 75;
export const MEDIUM_THRESHOLD = 50;
/** Score change (points) beyond which a trend or intervention result is not "steady". */
export const MEANINGFUL_DELTA = 5;

export const DOCUMENTATION_PARTS: ReadonlyArray<{
  part: DocumentationPart;
  label: string;
  weight: number;
}> = [
  { part: 'photos', label: 'Before & after photos', weight: 0.25 },
  { part: 'diagnosis', label: 'Recorded diagnosis', weight: 0.2 },
  { part: 'work_notes', label: 'Work performed notes', weight: 0.2 },
  { part: 'evidence', label: 'Evidence Chain entries', weight: 0.25 },
  { part: 'signature', label: 'Customer signature', weight: 0.1 },
];

export const LEVEL_META: Record<
  AdoptionLevel,
  { label: string; tone: 'success' | 'accent' | 'warning' | 'neutral' }
> = {
  high: { label: 'High adoption', tone: 'success' },
  medium: { label: 'Medium adoption', tone: 'accent' },
  low: { label: 'Low adoption', tone: 'warning' },
  insufficient: { label: 'Not enough jobs yet', tone: 'neutral' },
};

export const ADOPTION_ROUTES = {
  diagnosis: '/dashboard/diagnosis-copilot',
  liveCopilot: '/dashboard/live-copilot',
  simulator: '/dashboard/technician-simulator',
  apprenticeship: '/dashboard/apprenticeship',
  evidenceChain: '/dashboard/evidence-chain',
  jobs: '/dashboard/jobs',
} as const;

// ============================================================
// HELPERS
// ============================================================

function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function ratioPct(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round(Math.min(1, Math.max(0, part / total)) * 100);
}

function average(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function levelForScore(score: number): Exclude<AdoptionLevel, 'insufficient'> {
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

function displayName(row: AdoptionSignalRow): string {
  const name = row.member_name?.trim();
  return name || row.member_email;
}

// ============================================================
// PER-TECHNICIAN ADOPTION
// ============================================================

export function computeAdoption(row: AdoptionSignalRow): TechnicianAdoption {
  const jobs = toCount(row.jobs_completed);
  const counts: Record<DocumentationPart, number> = {
    photos: toCount(row.jobs_with_photos),
    diagnosis: toCount(row.jobs_with_diagnosis),
    work_notes: toCount(row.jobs_with_work_notes),
    evidence: toCount(row.jobs_with_evidence),
    signature: toCount(row.jobs_with_signature),
  };

  const breakdown: DocumentationBreakdownItem[] = DOCUMENTATION_PARTS.map((p) => ({
    part: p.part,
    label: p.label,
    weight: p.weight,
    pct: ratioPct(counts[p.part], jobs),
  }));

  const measurable = jobs > 0;
  const aiUsagePct = ratioPct(toCount(row.jobs_with_ai), jobs);
  const documentationPct = measurable
    ? Math.round(breakdown.reduce((sum, b) => sum + (b.pct ?? 0) * b.weight, 0))
    : null;

  const enough = jobs >= MIN_JOBS_FOR_LEVEL && aiUsagePct !== null && documentationPct !== null;
  const score = enough
    ? Math.round(
        (aiUsagePct as number) * SCORE_WEIGHTS.ai +
          (documentationPct as number) * SCORE_WEIGHTS.documentation,
      )
    : null;

  const weakestPart = measurable
    ? breakdown.reduce((worst, b) => ((b.pct ?? 0) < (worst.pct ?? 0) ? b : worst), breakdown[0])
    : null;

  // Gap = distance below the "High" bar, weighted by how much that dimension counts.
  const gaps = (
    [
      { d: 'ai' as const, v: aiUsagePct, w: SCORE_WEIGHTS.ai },
      { d: 'documentation' as const, v: documentationPct, w: SCORE_WEIGHTS.documentation },
    ]
      .filter((x) => x.v !== null && x.v < HIGH_THRESHOLD)
      .map((x) => ({ d: x.d, shortfall: (HIGH_THRESHOLD - (x.v as number)) * x.w }))
      .sort((a, b) => b.shortfall - a.shortfall)
  ).map((x) => x.d);

  return {
    technicianId: row.team_member_id,
    name: displayName(row),
    jobsCompleted: jobs,
    aiSessions: toCount(row.ai_sessions),
    lessonsCompleted: toCount(row.lessons_completed),
    simulatorAttempts: toCount(row.simulator_attempts),
    aiUsagePct,
    documentationPct,
    score,
    level: score === null ? 'insufficient' : levelForScore(score),
    breakdown,
    weakestPart,
    gaps,
  };
}

// ============================================================
// TREND (current window vs previous window)
// ============================================================

export function adoptionTrend(current: number | null, previous: number | null): AdoptionTrend {
  if (current === null || previous === null) return 'unknown';
  const delta = current - previous;
  if (delta >= MEANINGFUL_DELTA) return 'improving';
  if (delta <= -MEANINGFUL_DELTA) return 'declining';
  return 'steady';
}

// ============================================================
// PERSONALIZED ONBOARDING PLAN
// ============================================================

const DOC_STEPS: Record<DocumentationPart, Omit<OnboardingStep, 'id' | 'dimension'>> = {
  photos: {
    title: 'Capture before & after photos on every job',
    why: 'Photos are the fastest proof of work and the first thing customers and insurers ask for.',
    action: 'Take one before photo on arrival and one after photo at completion, from the job screen.',
    href: ADOPTION_ROUTES.jobs,
  },
  diagnosis: {
    title: 'Record your diagnosis before starting the repair',
    why: 'A written diagnosis prevents callbacks and lets the office price the work correctly.',
    action: 'Enter the diagnosis on the job before work begins. One sentence is enough.',
    href: ADOPTION_ROUTES.jobs,
  },
  work_notes: {
    title: 'Write what you did when you close the job',
    why: 'Completion notes protect the warranty and make the next visit faster for whoever comes back.',
    action: 'Add work-performed notes before marking the job complete: what you fixed and what you replaced.',
    href: ADOPTION_ROUTES.jobs,
  },
  evidence: {
    title: 'Add evidence to the Job Evidence Chain',
    why: 'Evidence entries turn your work into a verifiable record that backs up every invoice.',
    action: 'Log at least one measurement or test result per job in the Evidence Chain.',
    href: ADOPTION_ROUTES.evidenceChain,
  },
  signature: {
    title: 'Collect the customer signature at completion',
    why: 'A signature closes the job with customer agreement and shortens payment disputes.',
    action: 'Ask the customer to sign on your device before you leave the site.',
    href: ADOPTION_ROUTES.jobs,
  },
};

const MAX_PLAN_STEPS = 4;

/**
 * Builds a short, ordered plan from the technician's real gaps. The biggest gap comes first.
 * Returns an empty list for technicians with high adoption or too little data.
 */
export function buildOnboardingPlan(adoption: TechnicianAdoption): OnboardingStep[] {
  if (adoption.level === 'insufficient' || adoption.level === 'high') return [];

  const steps: OnboardingStep[] = [];
  const neverUsedAi = adoption.aiUsagePct === 0;

  for (const dimension of adoption.gaps) {
    if (dimension === 'ai') {
      steps.push({
        id: 'ai-diagnosis',
        dimension: 'ai',
        title: neverUsedAi
          ? 'Run your first Diagnosis Copilot session'
          : 'Open the Diagnosis Copilot on every job with a fault code or repeat symptom',
        why: 'Technicians who diagnose with the copilot get a second opinion in seconds and avoid repeat visits.',
        action: 'Start from the job, enter the symptoms and meter readings, and review the suggested causes.',
        href: ADOPTION_ROUTES.diagnosis,
      });
      if (adoption.simulatorAttempts === 0) {
        steps.push({
          id: 'ai-simulator',
          dimension: 'ai',
          title: 'Practice in the Technician Simulator first',
          why: 'A safe practice run builds confidence with the tools before you rely on them on a real job.',
          action: 'Complete one scenario in your main trade.',
          href: ADOPTION_ROUTES.simulator,
        });
      } else if (!neverUsedAi) {
        steps.push({
          id: 'ai-live',
          dimension: 'ai',
          title: 'Try the Live Copilot when you are stuck on site',
          why: 'It answers while you work and can escalate to a remote expert when needed.',
          action: 'Start a live session from the job when a fix is not going to plan.',
          href: ADOPTION_ROUTES.liveCopilot,
        });
      }
    } else if (adoption.weakestPart) {
      const base = DOC_STEPS[adoption.weakestPart.part];
      steps.push({ id: `doc-${adoption.weakestPart.part}`, dimension: 'documentation', ...base });
      // Second-weakest part, only when it is also clearly low, so the plan stays focused.
      const second = adoption.breakdown
        .filter((b) => b.part !== adoption.weakestPart?.part && b.pct !== null && b.pct < MEDIUM_THRESHOLD)
        .sort((a, b) => (a.pct as number) - (b.pct as number))[0];
      if (second) steps.push({ id: `doc-${second.part}`, dimension: 'documentation', ...DOC_STEPS[second.part] });
    }
  }

  // A low-adoption technician who has never opened a lesson always gets that step: it is
  // reserved a slot so the cap can never push it out.
  if (adoption.level === 'low' && adoption.lessonsCompleted === 0) {
    return [
      ...steps.slice(0, MAX_PLAN_STEPS - 1),
      {
        id: 'learn-apprenticeship',
        dimension: 'learning',
        title: 'Start your first Apprenticeship lesson',
        why: 'Short guided lessons show exactly how each tool fits into a normal job.',
        action: 'Complete one lesson this week.',
        href: ADOPTION_ROUTES.apprenticeship,
      },
    ];
  }

  return steps.slice(0, MAX_PLAN_STEPS);
}

// ============================================================
// TEAM SUMMARY
// ============================================================

export function computeAdoptionSummary(list: TechnicianAdoption[]): AdoptionSummary {
  const count = (level: AdoptionLevel) => list.filter((t) => t.level === level).length;
  const high = count('high');
  const medium = count('medium');
  const low = count('low');
  const measured = high + medium + low;

  // Team-wide weakest documentation part, averaged over technicians that have jobs.
  let weakestTeamPart: DocumentationPart | null = null;
  let weakestValue = Infinity;
  for (const def of DOCUMENTATION_PARTS) {
    const avg = average(
      list.map((t) => t.breakdown.find((b) => b.part === def.part)?.pct ?? null),
    );
    if (avg !== null && avg < weakestValue) {
      weakestValue = avg;
      weakestTeamPart = def.part;
    }
  }

  return {
    technicians: list.length,
    measured,
    high,
    medium,
    low,
    insufficient: count('insufficient'),
    adoptionRatePct: measured > 0 ? Math.round(((high + medium) / measured) * 100) : null,
    avgAiUsagePct: average(list.map((t) => (t.level === 'insufficient' ? null : t.aiUsagePct))),
    avgDocumentationPct: average(
      list.map((t) => (t.level === 'insufficient' ? null : t.documentationPct)),
    ),
    avgScore: average(list.map((t) => t.score)),
    weakestTeamPart,
  };
}

// ============================================================
// INTERVENTION OUTCOME (did the onboarding actually work?)
// ============================================================

export function interventionOutcome(
  baseline: number | null,
  current: number | null,
): { verdict: InterventionVerdict; delta: number | null } {
  if (baseline === null || current === null) return { verdict: 'unmeasured', delta: null };
  const delta = Math.round((current - baseline) * 10) / 10;
  if (delta >= MEANINGFUL_DELTA) return { verdict: 'improved', delta };
  if (delta <= -MEANINGFUL_DELTA) return { verdict: 'declined', delta };
  return { verdict: 'unchanged', delta };
}
