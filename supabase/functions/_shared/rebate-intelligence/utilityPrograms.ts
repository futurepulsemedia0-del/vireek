// supabase/functions/_shared/rebate-intelligence/utilityPrograms.ts  (item 141)
// Pure layer ON TOP of the Rebate Intelligence engine: it never re-decides eligibility. It takes the engine's
// IncentiveEvaluation[] (already matched to the property, equipment and territory) and adds what a utility program
// needs operationally: contractor enrolment, how/when to submit, and tracking of submitted/approved rebates.

import type { IncentiveEvaluation } from "./engine.ts";

export const SUBMISSION_METHODS = ["online_portal", "email", "mail", "partner_api", "point_of_sale", "contractor_portal", "unknown"] as const;
export type SubmissionMethod = (typeof SUBMISSION_METHODS)[number];

export const ENROLLMENT_STATUSES = ["not_enrolled", "pending", "active", "suspended", "expired"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export interface SubmissionProfile {
  program_id: string;
  submission_method: SubmissionMethod;
  submission_url: string | null;
  submission_deadline_days: number | null;
  required_documents: string[];
}

export type Blocker = "enrollment_required" | "pre_approval_required" | "funding_unavailable" | "program_ended" | "submission_info_missing";

export interface ProgramAction {
  program_id: string;
  name: string;
  eval_status: IncentiveEvaluation["status"];
  expected_cents: number;
  blockers: Blocker[];
  submit: { method: SubmissionMethod; url: string | null; due_at: string | null; days_left: number | null; documents: string[] } | null;
  next_step: "enroll" | "get_pre_approval" | "complete_job" | "submit" | "resolve_missing_info" | "none";
}

export interface JobTiming { completedAt?: string | null }

const DAY = 86_400_000;
const isHttps = (u: string | null) => !!u && /^https:\/\//.test(u);

/** Utility-level programs only; everything is derived from stored data, nothing invented. Ineligible programs are dropped. */
export function buildProgramActions(i: {
  evaluations: readonly IncentiveEvaluation[];
  profiles: Readonly<Record<string, SubmissionProfile | undefined>>;
  enrollments: Readonly<Record<string, EnrollmentStatus | undefined>>;
  job: JobTiming;
  now: string;
}): ProgramAction[] {
  const nowMs = Date.parse(i.now);
  const out: ProgramAction[] = [];
  const seen = new Set<string>();
  for (const e of i.evaluations) {
    if (e.level !== "utility" || e.status === "ineligible" || seen.has(e.program_id)) continue;
    seen.add(e.program_id);
    const profile = i.profiles[e.program_id];
    const blockers: Blocker[] = [];
    if (e.requires_participating_contractor && (i.enrollments[e.program_id] ?? "not_enrolled") !== "active") blockers.push("enrollment_required");
    if (e.funding_status === "closed" || e.funding_status === "waitlist") blockers.push("funding_unavailable");
    if (e.end_date && Date.parse(e.end_date) < nowMs) blockers.push("program_ended");
    const completed = i.job.completedAt ? Date.parse(i.job.completedAt) : NaN;
    if (e.requires_pre_approval && Number.isNaN(completed)) blockers.push("pre_approval_required");
    if (!profile || profile.submission_method === "unknown" || (profile.submission_method === "online_portal" && !isHttps(profile.submission_url))) {
      blockers.push("submission_info_missing");
    }

    let dueAt: string | null = null, daysLeft: number | null = null;
    if (profile?.submission_deadline_days != null && !Number.isNaN(completed)) {
      const due = completed + profile.submission_deadline_days * DAY;
      dueAt = new Date(due).toISOString();
      daysLeft = Math.ceil((due - nowMs) / DAY);
    }
    const next: ProgramAction["next_step"] =
      blockers.includes("enrollment_required") ? "enroll"
      : blockers.includes("pre_approval_required") ? "get_pre_approval"
      : blockers.includes("funding_unavailable") || blockers.includes("program_ended") ? "none"
      : blockers.includes("submission_info_missing") ? "resolve_missing_info"
      : Number.isNaN(completed) ? "complete_job" : "submit";
    out.push({
      program_id: e.program_id, name: e.name, eval_status: e.status, expected_cents: e.expected_cents, blockers,
      submit: profile ? { method: profile.submission_method, url: isHttps(profile.submission_url) ? profile.submission_url : null, due_at: dueAt, days_left: daysLeft, documents: profile.required_documents } : null,
      next_step: next,
    });
  }
  // Soonest deadline first, then largest expected value, then name: deterministic.
  return out.sort((a, b) => (a.submit?.days_left ?? 1e9) - (b.submit?.days_left ?? 1e9) || b.expected_cents - a.expected_cents || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Tracking of submitted / approved rebates
// ---------------------------------------------------------------------------
export const APPLICATION_STATUSES = ["identified", "proposed", "submitted", "approved", "paid", "denied", "withdrawn"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface ApplicationRow {
  id: string;
  status: ApplicationStatus;
  estimated_cents: number;
  approved_cents: number | null;
  paid_cents: number | null;
  submission_due_at: string | null;
  submitted_at: string | null;
}

export interface TrackingSummary {
  counts: Record<ApplicationStatus, number>;
  submitted_cents: number;      // estimated value of applications currently awaiting a decision
  approved_cents: number;       // approved, not yet paid
  paid_cents: number;
  decided: number;              // approved + paid + denied
  approval_rate: number | null; // (approved + paid) / decided; null until something is decided
  overdue: string[];            // not yet submitted and past submission_due_at
  stale_submitted: string[];    // submitted more than `staleDays` ago without a decision
}

export function summarizeApplications(rows: readonly ApplicationRow[], nowIso: string, staleDays = 45): TrackingSummary {
  const now = Date.parse(nowIso);
  const counts = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0])) as Record<ApplicationStatus, number>;
  let submitted = 0, approved = 0, paid = 0;
  const overdue: string[] = [], stale: string[] = [];
  for (const r of rows) {
    counts[r.status]++;
    if (r.status === "submitted") {
      submitted += r.estimated_cents;
      if (r.submitted_at && now - Date.parse(r.submitted_at) > staleDays * DAY) stale.push(r.id);
    }
    if (r.status === "approved") approved += r.approved_cents ?? r.estimated_cents;
    if (r.status === "paid") paid += r.paid_cents ?? r.approved_cents ?? 0;
    if ((r.status === "identified" || r.status === "proposed") && r.submission_due_at && Date.parse(r.submission_due_at) < now) overdue.push(r.id);
  }
  const decided = counts.approved + counts.paid + counts.denied;
  return {
    counts, submitted_cents: submitted, approved_cents: approved, paid_cents: paid, decided,
    approval_rate: decided === 0 ? null : (counts.approved + counts.paid) / decided,
    overdue: overdue.sort(), stale_submitted: stale.sort(),
  };
}

/** Mirror of the validation in the rebate_applications trigger: money received is final; everything else may move (appeals). */
export function applicationTransitionAllowed(from: ApplicationStatus, to: ApplicationStatus): boolean {
  if (from === to) return true;
  if (from === "paid") return false;
  return true;
}
