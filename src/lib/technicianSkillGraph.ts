/**
 * AI Technician Coaching + Skill Graph — client library.
 *
 * Deliberately follows the exact same architecture as
 * `lib/technicianPerformance.ts` (Technician Performance OS):
 * - No new analysis pipeline, no new edge function, no LLM call.
 * - No new database table. Every signal already exists:
 *   `jobs.assigned_technician_id` / `service_type` / `is_rework` /
 *   `rework_of_job_id` / `completed_at` / `scheduled_datetime` /
 *   `duration_minutes`, and `review_requests.rating`.
 * - "AI" here means rule-based scoring over recency-weighted history,
 *   the same trustworthy, explainable pattern already used for
 *   `aiCoachingNotes` in Technician Performance OS.
 *
 * What this adds on top of Technician Performance OS:
 * 1. A skill graph — a proficiency score per (technician, service type)
 *    pair, recency-weighted so it reflects current ability rather than
 *    all-time history.
 * 2. Fleet coverage risk — service types where only one technician (or
 *    none) is proficient, i.e. a bus-factor warning.
 * 3. Assignment suggestions — given a service type, rank technicians by
 *    proficiency (adjusted for current utilization if supplied), with a
 *    plain-language reason for each ranking.
 * 4. Growth pairing — for a given technician, the highest-demand service
 *    type they haven't developed yet where a specific teammate already
 *    has it mastered, i.e. a concrete "shadow this person on this job
 *    type" suggestion.
 */

import { Job, TeamMember, ReviewRequest } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type SkillLevel = 'expert' | 'proficient' | 'developing' | 'novice' | 'no_data';

export interface SkillNode {
  technicianId: string;
  technicianName: string;
  serviceType: string;
  proficiencyScore: number; // 0-100
  level: SkillLevel;
  sampleSize: number; // raw completed-job count (unweighted), for confidence display
  firstTimeFixRate: number | null;
  csatAvg: number | null;
  relativeSpeedPct: number | null; // + slower than fleet avg for this service type, - faster
  trend: 'improving' | 'steady' | 'declining' | null;
}

export interface SkillGraph {
  generatedAt: string;
  serviceTypes: string[]; // ordered by fleet-wide job volume, descending
  nodes: SkillNode[];
  nodesByTechnician: Map<string, SkillNode[]>;
}

export interface CoverageRisk {
  serviceType: string;
  jobVolume: number; // fleet-wide completed jobs of this type in the horizon
  proficientTechnicianIds: string[]; // technicians at 'expert' or 'proficient' for this type
  risk: 'no_coverage' | 'single_point';
}

export interface AssignmentSuggestion {
  technicianId: string;
  technicianName: string;
  score: number; // 0-100, proficiency adjusted for utilization
  level: SkillLevel;
  reasoning: string[];
}

export interface GrowthPairing {
  serviceType: string;
  reason: string;
  mentorTechnicianId: string;
  mentorTechnicianName: string;
}

// ============================================================
// CONFIG
// ============================================================

const HORIZON_DAYS = 365; // how far back the skill graph looks at all
const HALF_LIFE_DAYS = 90; // recency weighting: a job this old counts half as much
const MIN_SAMPLE_FOR_EXPERT = 3; // raw completed jobs required before a technician can be called "expert"
const MIN_FLEET_DEMAND_FOR_RISK = 3; // ignore rarely-booked service types for coverage risk

function round(n: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function recencyWeight(ageDays: number): number {
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

function actualDurationMinutes(job: Job): number | null {
  if (job.completed_at && job.scheduled_datetime) {
    const mins = (new Date(job.completed_at).getTime() - new Date(job.scheduled_datetime).getTime()) / 60000;
    if (mins > 0 && mins < 24 * 60) return mins;
  }
  return job.duration_minutes ?? null;
}

function levelFor(score: number, rawSampleSize: number): SkillLevel {
  if (rawSampleSize === 0) return 'no_data';
  if (score >= 85 && rawSampleSize >= MIN_SAMPLE_FOR_EXPERT) return 'expert';
  if (score >= 70) return 'proficient';
  if (score >= 45) return 'developing';
  return 'novice';
}

// ============================================================
// SKILL GRAPH
// ============================================================

/**
 * @param allJobs Full job history (unfiltered by date — this function
 *   applies its own HORIZON_DAYS window internally, same convention as
 *   `computeTechnicianPerformance` taking unfiltered history for rework
 *   lookups).
 * @param allReviewRequests Full review-request history.
 * @param technicians Active dispatch technicians.
 * @param now Injectable for tests; defaults to current time.
 */
export function computeSkillGraph(
  allJobs: Job[],
  allReviewRequests: ReviewRequest[],
  technicians: TeamMember[],
  now: Date = new Date(),
): SkillGraph {
  const horizonStart = new Date(now.getTime() - HORIZON_DAYS * 86400000);
  const jobsById = new Map(allJobs.map((j) => [j.id, j]));

  const reworkedOriginalIds = new Set(
    allJobs.filter((j) => j.is_rework && j.rework_of_job_id).map((j) => j.rework_of_job_id as string),
  );

  const completed = allJobs.filter((j) => {
    if (j.job_status !== 'completed' || !j.assigned_technician_id || !j.service_type) return false;
    const at = j.completed_at ?? j.scheduled_datetime;
    if (!at) return false;
    const d = new Date(at);
    return d >= horizonStart && d <= now;
  });

  const serviceTypeVolume = new Map<string, number>();
  for (const j of completed) {
    serviceTypeVolume.set(j.service_type as string, (serviceTypeVolume.get(j.service_type as string) ?? 0) + 1);
  }
  const serviceTypes = [...serviceTypeVolume.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);

  // Fleet-wide weighted average duration per service type, needed to score
  // any individual technician's relative speed.
  const fleetDurationWeighted = new Map<string, { sum: number; weight: number }>();
  for (const j of completed) {
    const mins = actualDurationMinutes(j);
    if (mins === null) continue;
    const ageDays = (now.getTime() - new Date(j.completed_at ?? j.scheduled_datetime!).getTime()) / 86400000;
    const w = recencyWeight(Math.max(0, ageDays));
    const entry = fleetDurationWeighted.get(j.service_type as string) ?? { sum: 0, weight: 0 };
    entry.sum += mins * w;
    entry.weight += w;
    fleetDurationWeighted.set(j.service_type as string, entry);
  }
  const fleetAvgDuration = (serviceType: string): number | null => {
    const e = fleetDurationWeighted.get(serviceType);
    return e && e.weight > 0 ? e.sum / e.weight : null;
  };

  const reviewsByJobId = new Map<string, ReviewRequest[]>();
  for (const r of allReviewRequests) {
    if (r.rating === null || !r.job_id) continue;
    const list = reviewsByJobId.get(r.job_id) ?? [];
    list.push(r);
    reviewsByJobId.set(r.job_id, list);
  }

  /** Scores one technician's history for one service type within a given window. Returns null if no completed jobs. */
  function scoreWindow(
    techId: string,
    serviceType: string,
    windowStart: Date,
    windowEnd: Date,
  ): { score: number; rawCount: number; ftfRate: number | null; csatAvg: number | null; relativeSpeedPct: number | null } | null {
    const jobs = completed.filter((j) => {
      if (j.assigned_technician_id !== techId || j.service_type !== serviceType) return false;
      const at = new Date(j.completed_at ?? j.scheduled_datetime!);
      return at >= windowStart && at <= windowEnd;
    });
    if (jobs.length === 0) return null;

    let ftfWeightSum = 0;
    let ftfWeightTotal = 0;
    let durationWeightedSum = 0;
    let durationWeightTotal = 0;
    let csatSum = 0;
    let csatCount = 0;

    for (const j of jobs) {
      const ageDays = Math.max(0, (now.getTime() - new Date(j.completed_at ?? j.scheduled_datetime!).getTime()) / 86400000);
      const w = recencyWeight(ageDays);
      ftfWeightTotal += w;
      ftfWeightSum += w * (reworkedOriginalIds.has(j.id) ? 0 : 1);

      const mins = actualDurationMinutes(j);
      if (mins !== null) {
        durationWeightedSum += mins * w;
        durationWeightTotal += w;
      }

      for (const r of reviewsByJobId.get(j.id) ?? []) {
        csatSum += r.rating ?? 0;
        csatCount += 1;
      }
    }

    const ftfRate = ftfWeightTotal > 0 ? round((ftfWeightSum / ftfWeightTotal) * 100) : null;
    const csatAvg = csatCount > 0 ? round(csatSum / csatCount, 2) : null;
    const techAvgDuration = durationWeightTotal > 0 ? durationWeightedSum / durationWeightTotal : null;
    const fleetAvg = fleetAvgDuration(serviceType);
    const relativeSpeedPct =
      techAvgDuration !== null && fleetAvg && fleetAvg > 0 ? round(((techAvgDuration - fleetAvg) / fleetAvg) * 100) : null;

    // Weighted blend: first-time-fix matters most, then customer sentiment,
    // then speed relative to peers. Any missing component is dropped and
    // the remaining weights are rescaled, so a technician with no reviews
    // yet isn't unfairly punished.
    const components: { value: number; weight: number }[] = [];
    if (ftfRate !== null) components.push({ value: ftfRate, weight: 0.5 });
    if (csatAvg !== null) components.push({ value: (csatAvg / 5) * 100, weight: 0.25 });
    if (relativeSpeedPct !== null) components.push({ value: clamp(100 - relativeSpeedPct, 0, 100), weight: 0.25 });

    const totalWeight = components.reduce((s, c) => s + c.weight, 0);
    const score = totalWeight > 0 ? round(components.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight) : 0;

    return { score, rawCount: jobs.length, ftfRate, csatAvg, relativeSpeedPct };
  }

  const nodes: SkillNode[] = [];
  const nodesByTechnician = new Map<string, SkillNode[]>();

  for (const tech of technicians) {
    const techNodes: SkillNode[] = [];
    for (const serviceType of serviceTypes) {
      const full = scoreWindow(tech.id, serviceType, horizonStart, now);
      if (!full) {
        const node: SkillNode = {
          technicianId: tech.id,
          technicianName: tech.member_name || tech.member_email || 'Unnamed technician',
          serviceType,
          proficiencyScore: 0,
          level: 'no_data',
          sampleSize: 0,
          firstTimeFixRate: null,
          csatAvg: null,
          relativeSpeedPct: null,
          trend: null,
        };
        nodes.push(node);
        techNodes.push(node);
        continue;
      }

      // Trend: most-recent third of the horizon vs. the two-thirds before it.
      const recentStart = new Date(now.getTime() - (HORIZON_DAYS / 3) * 86400000);
      const recentWindow = scoreWindow(tech.id, serviceType, recentStart, now);
      const priorWindow = scoreWindow(tech.id, serviceType, horizonStart, new Date(recentStart.getTime() - 1));
      let trend: SkillNode['trend'] = null;
      if (recentWindow && priorWindow && recentWindow.rawCount >= 2 && priorWindow.rawCount >= 2) {
        const diff = recentWindow.score - priorWindow.score;
        trend = diff >= 5 ? 'improving' : diff <= -5 ? 'declining' : 'steady';
      }

      const node: SkillNode = {
        technicianId: tech.id,
        technicianName: tech.member_name || tech.member_email || 'Unnamed technician',
        serviceType,
        proficiencyScore: full.score,
        level: levelFor(full.score, full.rawCount),
        sampleSize: full.rawCount,
        firstTimeFixRate: full.ftfRate,
        csatAvg: full.csatAvg,
        relativeSpeedPct: full.relativeSpeedPct,
        trend,
      };
      nodes.push(node);
      techNodes.push(node);
    }
    nodesByTechnician.set(tech.id, techNodes);
  }

  void jobsById; // kept for symmetry with technicianPerformance.ts's lookup pattern; not needed beyond this point

  return { generatedAt: now.toISOString(), serviceTypes, nodes, nodesByTechnician };
}

// ============================================================
// FLEET COVERAGE RISK
// ============================================================

/** Service types where the fleet has at most one technician who's actually good at it. */
export function getCoverageRisks(graph: SkillGraph): CoverageRisk[] {
  const risks: CoverageRisk[] = [];
  for (const serviceType of graph.serviceTypes) {
    const nodesForType = graph.nodes.filter((n) => n.serviceType === serviceType);
    const jobVolume = nodesForType.reduce((s, n) => s + n.sampleSize, 0);
    if (jobVolume < MIN_FLEET_DEMAND_FOR_RISK) continue;

    const proficient = nodesForType.filter((n) => n.level === 'expert' || n.level === 'proficient');
    if (proficient.length === 0) {
      risks.push({ serviceType, jobVolume, proficientTechnicianIds: [], risk: 'no_coverage' });
    } else if (proficient.length === 1) {
      risks.push({ serviceType, jobVolume, proficientTechnicianIds: [proficient[0].technicianId], risk: 'single_point' });
    }
  }
  return risks.sort((a, b) => b.jobVolume - a.jobVolume);
}

// ============================================================
// ASSIGNMENT SUGGESTIONS
// ============================================================

/**
 * Ranks technicians for a given service type. Pass `utilizationByTechnician`
 * (e.g. from `computeTechnicianPerformance(...).byTechnician`) to fold in
 * current workload as a tiebreaker — a slightly-less-proficient technician
 * who's free beats an expert who's already overbooked.
 */
export function suggestTechniciansForJob(
  serviceType: string,
  graph: SkillGraph,
  options?: { utilizationByTechnician?: Record<string, number | null>; excludeTechnicianIds?: string[]; limit?: number },
): AssignmentSuggestion[] {
  const exclude = new Set(options?.excludeTechnicianIds ?? []);
  const limit = options?.limit ?? 5;

  const candidates = [...graph.nodesByTechnician.entries()]
    .filter(([techId]) => !exclude.has(techId))
    .map(([, techNodes]) => techNodes.find((n) => n.serviceType === serviceType))
    .filter((n): n is SkillNode => !!n);

  const suggestions: AssignmentSuggestion[] = candidates.map((node) => {
    const utilization = options?.utilizationByTechnician?.[node.technicianId] ?? null;
    const utilizationPenalty = utilization !== null && utilization > 90 ? 15 : utilization !== null && utilization > 75 ? 5 : 0;
    const score = clamp(round(node.proficiencyScore - utilizationPenalty), 0, 100);

    const reasoning: string[] = [];
    if (node.level === 'no_data') {
      reasoning.push(`No completed ${serviceType} jobs on record — this would be their first.`);
    } else {
      reasoning.push(
        `${node.proficiencyScore}% proficiency on ${serviceType} from ${node.sampleSize} recent job${node.sampleSize === 1 ? '' : 's'}` +
          (node.firstTimeFixRate !== null ? ` (first-time-fix ${node.firstTimeFixRate}%)` : ''),
      );
    }
    if (node.trend === 'improving') reasoning.push('Trending up on this service type recently.');
    if (node.trend === 'declining') reasoning.push('Trending down on this service type recently — worth a check-in.');
    if (utilizationPenalty > 0) reasoning.push(`Currently at ${utilization}% utilization — factored into the ranking.`);

    return { technicianId: node.technicianId, technicianName: node.technicianName, score, level: node.level, reasoning };
  });

  return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ============================================================
// GROWTH PAIRING (coaching)
// ============================================================

/**
 * For one technician, finds the highest-demand service type they haven't
 * developed yet where a specific teammate has already mastered it —
 * a concrete "shadow this person on this job type" coaching suggestion.
 * Returns null if there's nothing to suggest (e.g. they're already solid
 * across the board, or no qualified mentor exists on the team).
 */
export function suggestGrowthPairing(technicianId: string, graph: SkillGraph): GrowthPairing | null {
  const myNodes = graph.nodesByTechnician.get(technicianId) ?? [];
  const myByType = new Map(myNodes.map((n) => [n.serviceType, n]));

  const demandByType = new Map<string, number>();
  for (const n of graph.nodes) {
    demandByType.set(n.serviceType, (demandByType.get(n.serviceType) ?? 0) + n.sampleSize);
  }

  const candidateTypes = graph.serviceTypes
    .filter((t) => {
      const mine = myByType.get(t);
      return !mine || mine.level === 'no_data' || mine.level === 'novice';
    })
    .sort((a, b) => (demandByType.get(b) ?? 0) - (demandByType.get(a) ?? 0));

  for (const serviceType of candidateTypes) {
    const mentors = graph.nodes
      .filter((n) => n.serviceType === serviceType && n.technicianId !== technicianId && n.level === 'expert')
      .sort((a, b) => b.proficiencyScore - a.proficiencyScore);
    if (mentors.length === 0) continue;

    const mentor = mentors[0];
    return {
      serviceType,
      reason: `${serviceType} is a high-volume service type this technician hasn't developed yet, and ${mentor.technicianName} is the fleet's strongest performer on it.`,
      mentorTechnicianId: mentor.technicianId,
      mentorTechnicianName: mentor.technicianName,
    };
  }

  return null;
}
