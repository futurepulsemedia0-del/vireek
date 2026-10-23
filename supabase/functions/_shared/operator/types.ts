// supabase/functions/_shared/operator/types.ts
//
// Shared contract for the Operator Agent (Cmd+K). Pure types + constants:
// no I/O, no Deno globals, so every rule is unit-testable under vitest.

export const OPERATOR_AGENT_SOURCE = "operator-agent";

export type OperatorTool = "reschedule_jobs" | "reassign_jobs" | "message_customers";
export const OPERATOR_TOOLS: readonly OperatorTool[] = ["reschedule_jobs", "reassign_jobs", "message_customers"];

/** agent_action_catalog slugs (seeded by the operator migration). */
export const TOOL_SLUG: Record<OperatorTool, string> = {
  reschedule_jobs: "operator_reschedule_jobs",
  reassign_jobs: "operator_reassign_jobs",
  message_customers: "operator_message_customers",
};

export const LIMITS = {
  maxInstructionChars: 500,
  maxSteps: 6,
  maxRecordsPerStep: 50,
  /** Above this many affected records a run ALWAYS needs a human, whatever the autonomy settings say. */
  bulkApprovalThreshold: 10,
  /** A target date further out than this always needs a human. */
  farDateDays: 14,
  maxBodyChars: 320,
  planTtlMinutes: 15,
  undoWindowHours: 24,
  runsPerHour: 30,
} as const;

export type Weekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
export const WEEKDAYS: readonly Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "2026-10-27" | "today" | "tomorrow" | { weekday: "tuesday", when?: "this" | "next" } */
export type DateSpec = string | { weekday: Weekday; when?: "this" | "next" };

export interface JobSelector {
  /** Technician first/full name as the user said it. null = every technician. */
  technician: string | null;
  date: DateSpec;
}

export interface RescheduleStep {
  id: string;
  tool: "reschedule_jobs";
  selector: JobSelector;
  to_date: DateSpec;
  /** "HH:MM" local. null/absent = keep each job's own time of day. */
  to_time: string | null;
}
export interface ReassignStep {
  id: string;
  tool: "reassign_jobs";
  selector: JobSelector;
  to_technician: string;
}
export interface MessageStep {
  id: string;
  tool: "message_customers";
  /** Id of an earlier reschedule/reassign step: only customers of jobs that step ACTUALLY changed are texted. */
  from_step: string;
  /** Template. Allowed placeholders: {first_name} {new_date} {new_time} {old_date} */
  body: string;
}
export type PlanStep = RescheduleStep | ReassignStep | MessageStep;

export interface OperatorPlan {
  summary: string;
  steps: PlanStep[];
}

export type PlanOutcome =
  | { kind: "plan"; plan: OperatorPlan }
  | { kind: "refusal"; reason: string }
  | { kind: "clarify"; question: string }
  | { kind: "denied"; tools: OperatorTool[]; reason: string }
  | { kind: "invalid"; error: string };

export interface JobSnapshot {
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  job_status: string;
}

export type EffectKind = "job_reschedule" | "job_reassign" | "sms";
export type EffectStatus = "planned" | "running" | "applied" | "failed" | "skipped" | "undone" | "undo_failed" | "irreversible";
export type StepStatus = "planned" | "running" | "succeeded" | "partial" | "failed" | "skipped" | "blocked" | "undone" | "undo_partial";
export type RunStatus =
  | "awaiting_approval" | "ready" | "running" | "completed" | "partial" | "failed"
  | "refused" | "blocked" | "cancelled" | "expired" | "undoing" | "undone" | "undo_partial";

export interface EffectRow {
  id: string;
  step_id: string;
  kind: EffectKind;
  record_id: string;
  label: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  status: EffectStatus;
  reason: string | null;
  external_ref: string | null;
}

export interface StepRow {
  id: string;
  step_key: string;
  position: number;
  tool: OperatorTool;
  title: string;
  status: StepStatus;
  action_log_id: string | null;
  /** Governance decision of the linked agent_action_log row, re-read from the DB at execute time. */
  gov_status: string | null;
  affected_count: number;
  error: string | null;
  /** Tool parameters needed at execution time (e.g. the SMS template). */
  params: Record<string, unknown>;
}

export interface Actor {
  userId: string;
  ownerId: string;
  role: "owner" | "admin" | "technician" | "member";
  permissions: { can_view_all_jobs?: boolean; can_view_billing?: boolean; can_manage_team?: boolean; can_edit_business_profile?: boolean };
}
