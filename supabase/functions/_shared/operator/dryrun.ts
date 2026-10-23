// supabase/functions/_shared/operator/dryrun.ts
//
// Turns a validated plan into concrete, per-record effects WITHOUT changing
// anything: resolves names and dates, finds the affected jobs, predicts clashes
// and renders the exact texts. Data access is injected so this is fully testable.

import { formatClock, formatDay, resolveDateSpec, shiftToDate, zonedToUtcMs } from "./dates.ts";
import { matchTechnician, renderTemplate, type RosterTech } from "./plan.ts";
import { capacityWarnings, findOverlaps, type Slot } from "./policy.ts";
import { LIMITS, type EffectKind, type OperatorPlan, type OperatorTool } from "./types.ts";

export interface JobRow {
  id: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  service_type: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  assigned_technician_id: string | null;
  job_status: string;
}

export interface DryRunData {
  roster: RosterTech[];
  /** Jobs scheduled on a business-local date (any status), optionally for one technician. Max maxRecordsPerStep + 1 rows. */
  jobsOn(date: string, techId: string | null): Promise<JobRow[]>;
  /** Live (scheduled / en route / in progress) jobs on a date for these technicians. */
  liveJobsOn(date: string, techIds: string[]): Promise<JobRow[]>;
}

export interface EffectDraft {
  kind: EffectKind;
  record_id: string;
  label: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  status: "planned" | "skipped";
  reason: string | null;
}

export interface BuiltStep {
  key: string;
  tool: OperatorTool;
  title: string;
  params: Record<string, unknown>;
  effects: EffectDraft[];
  warnings: string[];
  /** Local dates this step touches (used for the "far from today" guardrail). */
  dates: string[];
  note: string | null;
}

export type DryRunResult = { ok: true; steps: BuiltStep[] } | { ok: false; kind: "blocked" | "clarify"; message: string };

const blocked = (message: string): DryRunResult => ({ ok: false, kind: "blocked", message });
const maskPhone = (p: string) => `•••• ${p.replace(/\D/g, "").slice(-4)}`;
export const plannedCount = (s: BuiltStep) => s.effects.filter((e) => e.status === "planned").length;

export async function buildDryRun(plan: OperatorPlan, env: { tz: string; today: string }, data: DryRunData): Promise<DryRunResult> {
  const { tz, today } = env;
  const steps: BuiltStep[] = [];
  const done = new Map<string, { built: BuiltStep; jobs: Map<string, JobRow> }>();
  const when = (iso: string) => `${formatDay(Date.parse(iso), tz)} · ${formatClock(Date.parse(iso), tz)}`;
  const dayLabel = (date: string) => formatDay(zonedToUtcMs(date, "12:00", tz), tz);
  const slot = (id: string, techId: string | null, iso: string, dur: number | null): Slot => ({ id, techId, startMs: Date.parse(iso), durationMin: dur ?? 0 });
  const snapshot = (j: JobRow) => ({ scheduled_datetime: j.scheduled_datetime, assigned_technician_id: j.assigned_technician_id, job_status: j.job_status });
  const label = (j: JobRow) => `${j.customer_name}${j.service_type ? ` · ${j.service_type}` : ""}`;
  let smsCount = 0;

  for (const step of plan.steps) {
    // ---------------- text customers ----------------
    if (step.tool === "message_customers") {
      const src = done.get(step.from_step);
      if (!src) return blocked("A text step has no step to follow.");
      const srcReschedule = src.built.tool === "reschedule_jobs";
      const effects: EffectDraft[] = [];
      for (const e of src.built.effects) {
        if (e.status !== "planned") continue;
        const job = src.jobs.get(e.record_id)!;
        if (!job.customer_phone) {
          effects.push({ kind: "sms", record_id: job.id, label: job.customer_name, before: { display: "No phone" }, after: { display: "" }, status: "skipped", reason: "No phone number on file." });
          continue;
        }
        const newMs = Date.parse(srcReschedule ? String(e.after.scheduled_datetime) : String(job.scheduled_datetime));
        const oldMs = srcReschedule ? Date.parse(String(job.scheduled_datetime)) : NaN;
        const message = renderTemplate(step.body, {
          first_name: job.customer_name, new_date: formatDay(newMs, tz), new_time: formatClock(newMs, tz), old_date: Number.isNaN(oldMs) ? null : formatDay(oldMs, tz),
        });
        effects.push({ kind: "sms", record_id: job.id, label: job.customer_name, before: { display: maskPhone(job.customer_phone) }, after: { display: message }, status: "planned", reason: null });
      }
      smsCount += effects.filter((e) => e.status === "planned").length;
      if (smsCount > LIMITS.maxMessagesPerRun) return blocked(`That would send more than ${LIMITS.maxMessagesPerRun} texts. Narrow the request.`);
      const built: BuiltStep = { key: step.id, tool: step.tool, title: "Text the affected customers", params: { from_step: step.from_step, body: step.body }, effects, warnings: [], dates: src.built.dates, note: null };
      steps.push(built);
      done.set(step.id, { built, jobs: src.jobs });
      continue;
    }

    // ---------------- job steps: who + when ----------------
    let techId: string | null = null;
    if (step.selector.technician) {
      const m = matchTechnician(data.roster, step.selector.technician);
      if (!m.ok) {
        return {
          ok: false, kind: "clarify",
          message: m.reason === "ambiguous" ? `Which “${step.selector.technician}”? ${m.candidates.join(" or ")}.` : `I couldn’t find a technician named “${step.selector.technician}”.`,
        };
      }
      techId = m.tech.id;
    }
    const from = resolveDateSpec(step.selector.date, today);
    if (!from.ok) return blocked(from.error);

    const found = await data.jobsOn(from.date, techId);
    if (found.length > LIMITS.maxRecordsPerStep) return blocked(`More than ${LIMITS.maxRecordsPerStep} jobs match — narrow the request.`);
    const jobs = new Map(found.map((j) => [j.id, j]));
    const movable = found.filter((j) => j.job_status === "scheduled" && j.scheduled_datetime);
    const frozen = found.length - movable.length;
    const note = frozen ? `${frozen} job${frozen > 1 ? "s" : ""} already started or finished — left untouched.` : null;
    const who = step.selector.technician ? `${step.selector.technician}’s` : "All";
    const effects: EffectDraft[] = [];
    const warnings: string[] = [];

    if (step.tool === "reschedule_jobs") {
      const to = resolveDateSpec(step.to_date, today, from.date);
      if (!to.ok) return blocked(to.error);
      if (to.date < today) return blocked("That date is in the past.");
      if (to.date === from.date && !step.to_time) return blocked("Those jobs are already on that day.");

      for (const j of movable) {
        const newIso = shiftToDate(j.scheduled_datetime!, to.date, tz, step.to_time);
        if (newIso === new Date(j.scheduled_datetime!).toISOString()) continue;
        effects.push({
          kind: "job_reschedule", record_id: j.id, label: label(j),
          before: { ...snapshot(j), display: when(j.scheduled_datetime!) },
          after: { scheduled_datetime: newIso, display: when(newIso) },
          status: "planned", reason: null,
        });
      }
      if (effects.length) {
        const techIds = [...new Set(movable.map((j) => j.assigned_technician_id).filter((x): x is string => !!x))];
        const movingIds = new Set(effects.map((e) => e.record_id));
        const existing = (await data.liveJobsOn(to.date, techIds)).filter((j) => !movingIds.has(j.id) && j.scheduled_datetime);
        const moving = effects.map((e) => { const j = jobs.get(e.record_id)!; return slot(j.id, j.assigned_technician_id, String(e.after.scheduled_datetime), j.duration_minutes); });
        const clashes = findOverlaps(moving, existing.map((j) => slot(j.id, j.assigned_technician_id, j.scheduled_datetime!, j.duration_minutes)));
        if (clashes.length) warnings.push(`${clashes.length} job${clashes.length > 1 ? "s" : ""} would overlap an existing booking for the same technician — they’ll be skipped if still booked at run time.`);
        const incoming = new Map<string, number>();
        for (const m of moving) if (m.techId) incoming.set(m.techId, (incoming.get(m.techId) ?? 0) + 1);
        const have = new Map<string, number>();
        for (const j of existing) if (j.assigned_technician_id) have.set(j.assigned_technician_id, (have.get(j.assigned_technician_id) ?? 0) + 1);
        warnings.push(...capacityWarnings(incoming, have, data.roster));
      }
      const built: BuiltStep = {
        key: step.id, tool: step.tool, title: `Move ${who} jobs from ${dayLabel(from.date)} to ${dayLabel(to.date)}`,
        params: {}, effects, warnings, dates: [from.date, to.date], note,
      };
      steps.push(built);
      done.set(step.id, { built, jobs });
      continue;
    }

    // reassign_jobs
    const target = matchTechnician(data.roster, step.to_technician);
    if (!target.ok) {
      return {
        ok: false, kind: "clarify",
        message: target.reason === "ambiguous" ? `Which “${step.to_technician}”? ${target.candidates.join(" or ")}.` : `I couldn’t find a technician named “${step.to_technician}”.`,
      };
    }
    for (const j of movable) {
      if (j.assigned_technician_id === target.tech.id) continue;
      effects.push({
        kind: "job_reassign", record_id: j.id, label: label(j),
        before: { ...snapshot(j), display: data.roster.find((t) => t.id === j.assigned_technician_id)?.member_name ?? "Unassigned" },
        after: { assigned_technician_id: target.tech.id, display: target.tech.member_name ?? "Technician" },
        status: "planned", reason: null,
      });
    }
    if (effects.length) {
      const existing = await data.liveJobsOn(from.date, [target.tech.id]);
      const movingIds = new Set(effects.map((e) => e.record_id));
      const others = existing.filter((j) => !movingIds.has(j.id) && j.scheduled_datetime);
      const moving = effects.map((e) => { const j = jobs.get(e.record_id)!; return slot(j.id, target.tech.id, j.scheduled_datetime!, j.duration_minutes); });
      const clashes = findOverlaps(moving, others.map((j) => slot(j.id, j.assigned_technician_id, j.scheduled_datetime!, j.duration_minutes)));
      if (clashes.length) warnings.push(`${clashes.length} job${clashes.length > 1 ? "s" : ""} would overlap ${target.tech.member_name ?? "the technician"}’s existing bookings — they’ll be skipped if still booked at run time.`);
      warnings.push(...capacityWarnings(new Map([[target.tech.id, effects.length]]), new Map([[target.tech.id, others.length]]), data.roster));
    }
    const built: BuiltStep = {
      key: step.id, tool: step.tool, title: `Reassign ${who} jobs on ${dayLabel(from.date)} to ${target.tech.member_name ?? "the technician"}`,
      params: {}, effects, warnings, dates: [from.date], note,
    };
    steps.push(built);
    done.set(step.id, { built, jobs });
  }
  return { ok: true, steps };
}
