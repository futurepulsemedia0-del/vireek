// supabase/functions/_shared/operator/policy.ts
//
// Who may use which tool, when a run must be approved by a human no matter
// how permissive the autonomy settings are, and the advisory dry-run checks
// (capacity / overlap). Pure functions. The authoritative checks still happen
// per job inside the move_job RPC at execution time.

import { LIMITS, OPERATOR_TOOLS, type Actor, type OperatorTool } from "./types.ts";

/**
 * Operator acts with the CALLER'S authority, never more:
 *  - technicians never use it;
 *  - the account owner may use every tool;
 *  - everyone else needs can_view_all_jobs (the same bar move_job enforces) for every tool.
 */
export function toolsAllowedFor(actor: Pick<Actor, "role" | "permissions" | "userId" | "ownerId">): Set<OperatorTool> {
  if (actor.userId === actor.ownerId) return new Set(OPERATOR_TOOLS);
  if (actor.role === "technician" || actor.role === "owner") {
    // role "owner" on a different user id would be an inconsistent row: fail closed.
    return new Set();
  }
  return actor.permissions?.can_view_all_jobs === true ? new Set(OPERATOR_TOOLS) : new Set();
}

export interface ForceInput {
  affected: number;
  /** Local dates ("YYYY-MM-DD") the step moves jobs to; empty for non-reschedule steps. */
  targetDates: string[];
  today: string;
  warnings: string[];
  daysBetween: (a: string, b: string) => number;
}

/** Reasons that force a human approval even when autonomy settings would auto-approve. */
export function escalationReasons(i: ForceInput): string[] {
  const out: string[] = [];
  if (i.affected > LIMITS.bulkApprovalThreshold) out.push(`Affects ${i.affected} records (more than ${LIMITS.bulkApprovalThreshold}).`);
  if (i.targetDates.some((d) => Math.abs(i.daysBetween(i.today, d)) > LIMITS.farDateDays)) {
    out.push(`Moves jobs more than ${LIMITS.farDateDays} days away from today.`);
  }
  if (i.warnings.length) out.push("The dry run found warnings you should read first.");
  return out;
}

// ---------------------------------------------------------------------
// Advisory dry-run checks
// ---------------------------------------------------------------------
export interface Slot { id: string; techId: string | null; startMs: number; durationMin: number }

const DEFAULT_DURATION_MIN = 60;
const dur = (s: Slot) => (s.durationMin > 0 ? s.durationMin : DEFAULT_DURATION_MIN) * 60_000;

/** Moving jobs that would overlap an existing job of the same technician. */
export function findOverlaps(moving: Slot[], existing: Slot[]): { id: string; with: string }[] {
  const out: { id: string; with: string }[] = [];
  for (const m of moving) {
    if (!m.techId) continue;
    for (const e of existing) {
      if (e.techId !== m.techId || e.id === m.id) continue;
      if (m.startMs < e.startMs + dur(e) && e.startMs < m.startMs + dur(m)) { out.push({ id: m.id, with: e.id }); break; }
    }
  }
  return out;
}

/** Technicians whose target-day load (existing + incoming) would exceed max_jobs_per_day. */
export function capacityWarnings(
  incoming: Map<string, number>,
  existing: Map<string, number>,
  roster: { id: string; member_name: string | null; max_jobs_per_day?: number | null }[],
): string[] {
  const out: string[] = [];
  for (const [techId, n] of incoming) {
    const t = roster.find((r) => r.id === techId);
    const max = t?.max_jobs_per_day;
    if (!t || !max || max <= 0) continue;
    const total = (existing.get(techId) ?? 0) + n;
    if (total > max) out.push(`${t.member_name ?? "A technician"} would have ${total} jobs that day (limit ${max}).`);
  }
  return out;
}
