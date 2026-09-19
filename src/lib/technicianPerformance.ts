/**
 * Technician Performance OS — client library.
 *
 * Does NOT run any new analysis pipeline and does NOT duplicate data that
 * already exists elsewhere:
 * - `jobs.is_rework` / `rework_of_job_id` (20260923000000_rework_intelligence.sql,
 *   the same trigger `ReworkIntelligence.tsx` already reads) is the callback
 *   signal. first_time_fix_rate is the inverse of callback_rate.
 * - `review_requests.rating` (20260905120000_review_requests.sql) is CSAT.
 * - `team_members.max_jobs_per_day` is capacity, for utilization.
 *
 * This module only aggregates what's already there into a per-technician
 * scorecard, and optionally saves that scorecard as a named snapshot in
 * `technician_scorecards` so it survives past the current date-range view
 * — the exact same pattern as `lib/coachingReports.ts`.
 *
 * "AI coaching" here is deliberately rule-based (thresholds over the
 * computed metrics), not a live model call — consistent with how
 * `coaching_tip` already works elsewhere in this app, and it keeps this
 * feature free of a new edge function / prompt-injection surface.
 */

import { supabase, Job, TeamMember, ReviewRequest } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export interface TrainingGap {
  serviceType: string;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

export interface CoachingNote {
  tip: string;
  basis: string;
}

export interface TechnicianMetrics {
  technicianId: string;
  technicianName: string;
  jobsCompleted: number;
  firstTimeFixRate: number | null;
  callbackRate: number | null;
  avgJobDurationMinutes: number | null;
  revenueCents: number;
  csatAvg: number | null;
  csatResponses: number;
  utilizationRate: number | null;
  trainingGaps: TrainingGap[];
  aiCoachingNotes: CoachingNote[];
}

export interface FleetSummary {
  technicianCount: number;
  jobsCompleted: number;
  avgFirstTimeFixRate: number | null;
  avgCallbackRate: number | null;
  avgJobDurationMinutes: number | null;
  revenueCents: number;
  avgCsat: number | null;
  avgUtilizationRate: number | null;
}

export interface TechnicianPerformanceResult {
  fleet: FleetSummary;
  byTechnician: TechnicianMetrics[];
}

export interface TechnicianScorecard {
  id: string;
  user_id: string;
  technician_id: string;
  period_start: string;
  period_end: string;
  jobs_completed: number;
  first_time_fix_rate: number | null;
  callback_rate: number | null;
  avg_job_duration_minutes: number | null;
  revenue_cents: number;
  csat_avg: number | null;
  csat_responses: number;
  utilization_rate: number | null;
  training_gaps: TrainingGap[];
  ai_coaching_notes: CoachingNote[];
  created_at: string;
}

// ============================================================
// THRESHOLDS
// ============================================================

const MIN_SERVICE_TYPE_SAMPLE = 3;
const LOW_FTF_THRESHOLD = 80; // %
const LOW_CSAT_THRESHOLD = 4.0; // out of 5
const HIGH_CALLBACK_THRESHOLD = 15; // %
const LOW_UTILIZATION_THRESHOLD = 50; // %
const HIGH_UTILIZATION_THRESHOLD = 95; // %

function round(n: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function actualDurationMinutes(job: Job): number | null {
  if (job.completed_at && job.scheduled_datetime) {
    const mins = (new Date(job.completed_at).getTime() - new Date(job.scheduled_datetime).getTime()) / 60000;
    if (mins > 0 && mins < 24 * 60) return mins; // sanity bound: under a day
  }
  return job.duration_minutes ?? null;
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
}

// ============================================================
// AGGREGATION (pure — no network)
// ============================================================

/**
 * @param allJobs Full job history (not range-filtered) — needed because a
 *   job completed inside the period can be reworked by a job that lands
 *   outside it. Mirrors ReworkIntelligence's approach.
 * @param allReviewRequests Full review-request history, for the same reason.
 * @param technicians Active dispatch technicians (team_members, role='technician').
 * @param periodStart / periodEnd Inclusive scorecard window.
 */
export function computeTechnicianPerformance(
  allJobs: Job[],
  allReviewRequests: ReviewRequest[],
  technicians: TeamMember[],
  periodStart: Date,
  periodEnd: Date,
): TechnicianPerformanceResult {
  const jobsById = new Map(allJobs.map((j) => [j.id, j]));

  const reworkedOriginalIds = new Set(
    allJobs
      .filter((j) => j.is_rework && j.rework_of_job_id)
      .map((j) => j.rework_of_job_id as string),
  );

  const inRange = (iso: string | null) => {
    if (!iso) return false;
    const d = new Date(iso);
    return d >= periodStart && d <= periodEnd;
  };

  const completedInRange = allJobs.filter(
    (j) => j.job_status === 'completed' && j.assigned_technician_id && inRange(j.completed_at ?? j.scheduled_datetime),
  );

  const scheduledInRange = allJobs.filter(
    (j) => j.assigned_technician_id && j.job_status !== 'cancelled' && inRange(j.scheduled_datetime),
  );

  const reviewsInRange = allReviewRequests.filter((r) => r.rating !== null && inRange(r.completed_at ?? r.sent_at));

  const periodDays = daysBetween(periodStart, periodEnd);

  const byTechnician: TechnicianMetrics[] = technicians.map((tech) => {
    const techCompleted = completedInRange.filter((j) => j.assigned_technician_id === tech.id);
    const techScheduled = scheduledInRange.filter((j) => j.assigned_technician_id === tech.id);

    const reworkedCount = techCompleted.filter((j) => reworkedOriginalIds.has(j.id)).length;
    const callbackRate = techCompleted.length > 0 ? round((reworkedCount / techCompleted.length) * 100) : null;
    const firstTimeFixRate = callbackRate !== null ? round(100 - callbackRate) : null;

    const durations = techCompleted.map(actualDurationMinutes).filter((d): d is number => d !== null);
    const avgJobDurationMinutes = durations.length > 0 ? round(durations.reduce((s, d) => s + d, 0) / durations.length) : null;

    const revenueCents = techCompleted.reduce((sum, j) => sum + Math.round((j.invoice_amount ?? 0) * 100), 0);

    const techReviews = reviewsInRange.filter((r) => {
      const job = r.job_id ? jobsById.get(r.job_id) : null;
      return job?.assigned_technician_id === tech.id;
    });
    const csatResponses = techReviews.length;
    const csatAvg = csatResponses > 0
      ? round(techReviews.reduce((s, r) => s + (r.rating ?? 0), 0) / csatResponses, 2)
      : null;

    const capacity = tech.max_jobs_per_day * periodDays;
    const utilizationRate = capacity > 0 ? round(Math.min(100, (techScheduled.length / capacity) * 100)) : null;

    // Training gaps: by service_type, only where there's enough sample to
    // mean something (MIN_SERVICE_TYPE_SAMPLE), flagging low first-time-fix
    // or low CSAT for that specific service type.
    const byServiceType = new Map<string, { completed: Job[]; reviews: ReviewRequest[] }>();
    for (const j of techCompleted) {
      if (!j.service_type) continue;
      const entry = byServiceType.get(j.service_type) ?? { completed: [], reviews: [] };
      entry.completed.push(j);
      byServiceType.set(j.service_type, entry);
    }
    for (const r of techReviews) {
      const job = r.job_id ? jobsById.get(r.job_id) : null;
      if (!job?.service_type) continue;
      const entry = byServiceType.get(job.service_type) ?? { completed: [], reviews: [] };
      entry.reviews.push(r);
      byServiceType.set(job.service_type, entry);
    }

    const trainingGaps: TrainingGap[] = [];
    for (const [serviceType, entry] of byServiceType.entries()) {
      if (entry.completed.length < MIN_SERVICE_TYPE_SAMPLE) continue;
      const reworked = entry.completed.filter((j) => reworkedOriginalIds.has(j.id)).length;
      const ftf = round(100 - (reworked / entry.completed.length) * 100);
      if (ftf < LOW_FTF_THRESHOLD) {
        trainingGaps.push({
          serviceType,
          reason: `First-time-fix rate on ${serviceType} is ${ftf}%, below the ${LOW_FTF_THRESHOLD}% target`,
          severity: ftf < LOW_FTF_THRESHOLD - 20 ? 'high' : ftf < LOW_FTF_THRESHOLD - 10 ? 'medium' : 'low',
        });
      }
      if (entry.reviews.length >= MIN_SERVICE_TYPE_SAMPLE) {
        const avgRating = round(entry.reviews.reduce((s, r) => s + (r.rating ?? 0), 0) / entry.reviews.length, 2);
        if (avgRating < LOW_CSAT_THRESHOLD) {
          trainingGaps.push({
            serviceType,
            reason: `Customer rating on ${serviceType} averages ${avgRating}/5, below the ${LOW_CSAT_THRESHOLD}/5 target`,
            severity: avgRating < LOW_CSAT_THRESHOLD - 1 ? 'high' : 'medium',
          });
        }
      }
    }

    const aiCoachingNotes = generateCoachingNotes({
      firstTimeFixRate,
      callbackRate,
      csatAvg,
      utilizationRate,
      avgJobDurationMinutes,
      trainingGaps,
    });

    return {
      technicianId: tech.id,
      technicianName: tech.member_name || tech.member_email || 'Unnamed technician',
      jobsCompleted: techCompleted.length,
      firstTimeFixRate,
      callbackRate,
      avgJobDurationMinutes,
      revenueCents,
      csatAvg,
      csatResponses,
      utilizationRate,
      trainingGaps,
      aiCoachingNotes,
    };
  });

  const withCompleted = byTechnician.filter((t) => t.jobsCompleted > 0);
  const avg = (values: number[]) => (values.length > 0 ? round(values.reduce((s, v) => s + v, 0) / values.length) : null);

  const fleet: FleetSummary = {
    technicianCount: technicians.length,
    jobsCompleted: byTechnician.reduce((s, t) => s + t.jobsCompleted, 0),
    avgFirstTimeFixRate: avg(withCompleted.map((t) => t.firstTimeFixRate).filter((v): v is number => v !== null)),
    avgCallbackRate: avg(withCompleted.map((t) => t.callbackRate).filter((v): v is number => v !== null)),
    avgJobDurationMinutes: avg(withCompleted.map((t) => t.avgJobDurationMinutes).filter((v): v is number => v !== null)),
    revenueCents: byTechnician.reduce((s, t) => s + t.revenueCents, 0),
    avgCsat: avg(byTechnician.map((t) => t.csatAvg).filter((v): v is number => v !== null)),
    avgUtilizationRate: avg(byTechnician.map((t) => t.utilizationRate).filter((v): v is number => v !== null)),
  };

  return { fleet, byTechnician: byTechnician.sort((a, b) => b.revenueCents - a.revenueCents) };
}

// ============================================================
// RULE-BASED AI COACHING
// ============================================================

function generateCoachingNotes(m: {
  firstTimeFixRate: number | null;
  callbackRate: number | null;
  csatAvg: number | null;
  utilizationRate: number | null;
  avgJobDurationMinutes: number | null;
  trainingGaps: TrainingGap[];
}): CoachingNote[] {
  const notes: CoachingNote[] = [];

  if (m.callbackRate !== null && m.callbackRate > HIGH_CALLBACK_THRESHOLD) {
    notes.push({
      tip: 'Slow down on diagnosis before closing out the job — a high callback rate usually traces back to a root cause that wasn\u2019t fully confirmed on the first visit.',
      basis: `Callback rate is ${m.callbackRate}%, above the ${HIGH_CALLBACK_THRESHOLD}% threshold`,
    });
  }

  if (m.csatAvg !== null && m.csatAvg < LOW_CSAT_THRESHOLD) {
    notes.push({
      tip: 'Focus on customer communication during the visit — explaining what\u2019s being done and why tends to move satisfaction scores more than the technical fix itself.',
      basis: `Average customer rating is ${m.csatAvg}/5, below the ${LOW_CSAT_THRESHOLD}/5 target`,
    });
  }

  if (m.utilizationRate !== null && m.utilizationRate < LOW_UTILIZATION_THRESHOLD) {
    notes.push({
      tip: 'Capacity is going unused — check whether dispatch is routing enough jobs this technician\u2019s way, or whether their available hours need adjusting.',
      basis: `Utilization is ${m.utilizationRate}%, below the ${LOW_UTILIZATION_THRESHOLD}% target`,
    });
  }

  if (m.utilizationRate !== null && m.utilizationRate > HIGH_UTILIZATION_THRESHOLD) {
    notes.push({
      tip: 'This technician is booked near or at capacity — watch for burnout and rushed jobs, which is often where callback rate and CSAT start to slip.',
      basis: `Utilization is ${m.utilizationRate}%, above the ${HIGH_UTILIZATION_THRESHOLD}% watch line`,
    });
  }

  for (const gap of m.trainingGaps.slice(0, 3)) {
    notes.push({
      tip: `Consider a refresher or shadowing session on ${gap.serviceType} jobs specifically.`,
      basis: gap.reason,
    });
  }

  if (notes.length === 0 && m.firstTimeFixRate !== null) {
    notes.push({
      tip: 'Metrics are healthy across the board for this period — no coaching action needed.',
      basis: `First-time-fix rate ${m.firstTimeFixRate}%, callback rate ${m.callbackRate ?? 0}%`,
    });
  }

  return notes;
}

// ============================================================
// PERSISTENCE
// ============================================================

export async function saveTechnicianScorecard(
  technicianId: string,
  metrics: TechnicianMetrics,
  periodStart: Date,
  periodEnd: Date,
  userId: string,
): Promise<TechnicianScorecard> {
  const payload = {
    user_id: userId,
    technician_id: technicianId,
    period_start: periodStart.toISOString().slice(0, 10),
    period_end: periodEnd.toISOString().slice(0, 10),
    jobs_completed: metrics.jobsCompleted,
    first_time_fix_rate: metrics.firstTimeFixRate,
    callback_rate: metrics.callbackRate,
    avg_job_duration_minutes: metrics.avgJobDurationMinutes,
    revenue_cents: metrics.revenueCents,
    csat_avg: metrics.csatAvg,
    csat_responses: metrics.csatResponses,
    utilization_rate: metrics.utilizationRate,
    training_gaps: metrics.trainingGaps,
    ai_coaching_notes: metrics.aiCoachingNotes,
  };
  const { data, error } = await supabase.from('technician_scorecards').insert(payload).select().single();
  if (error) throw error;
  return data as TechnicianScorecard;
}

export async function fetchTechnicianScorecards(technicianId?: string): Promise<TechnicianScorecard[]> {
  let query = supabase.from('technician_scorecards').select('*').order('period_start', { ascending: false }).limit(100);
  if (technicianId) query = query.eq('technician_id', technicianId);
  const { data, error } = await query;
  if (error) throw error;
  return (data as TechnicianScorecard[]) ?? [];
}

export async function deleteTechnicianScorecard(id: string): Promise<void> {
  const { error } = await supabase.from('technician_scorecards').delete().eq('id', id);
  if (error) throw error;
}
