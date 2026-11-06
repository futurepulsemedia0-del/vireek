/**
 * Call-to-cash workflow health — pure domain logic (no network, no React).
 * Row shape mirrors public.c2c_workflow_health() in
 * supabase/migrations/20281116000000_c2c_state_machine_foundation.sql.
 * Network access lives in c2cWorkflowHealthApi.ts.
 */

export const HEALTH_STAGES = [
  'booking_without_technician',
  'completed_without_invoice',
  'invoice_overdue',
  'no_show_without_reschedule',
] as const;

export type HealthStage = (typeof HEALTH_STAGES)[number];

export interface HealthRow {
  stage: HealthStage;
  job_id: string | null;
  invoice_id: string | null;
  customer_name: string | null;
  age_minutes: number;
  sla_minutes: number;
  breached: boolean;
  owner_queue: string;
  suggested_action: string;
}

export const STAGE_LABELS: Record<HealthStage, string> = {
  booking_without_technician: 'Booked, no technician',
  completed_without_invoice: 'Completed, not invoiced',
  invoice_overdue: 'Invoice overdue',
  no_show_without_reschedule: 'No-show, not rebooked',
};

export function isHealthStage(value: unknown): value is HealthStage {
  return typeof value === 'string' && (HEALTH_STAGES as readonly string[]).includes(value);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Defensive parse: drops malformed rows instead of throwing, so one bad row never blanks the page. */
export function parseHealthRows(data: unknown): HealthRow[] {
  if (!Array.isArray(data)) return [];
  const rows: HealthRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!isHealthStage(r.stage)) continue;
    const age = Number(r.age_minutes);
    const sla = Number(r.sla_minutes);
    if (!Number.isFinite(age) || !Number.isFinite(sla)) continue;
    rows.push({
      stage: r.stage,
      job_id: str(r.job_id),
      invoice_id: str(r.invoice_id),
      customer_name: str(r.customer_name),
      age_minutes: Math.max(0, Math.round(age)),
      sla_minutes: Math.max(0, Math.round(sla)),
      breached: r.breached === true,
      owner_queue: str(r.owner_queue) ?? 'unassigned',
      suggested_action: str(r.suggested_action) ?? '',
    });
  }
  return rows;
}

export function formatAge(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface HealthSummary {
  total: number;
  breached: number;
  byQueue: Record<string, number>;
  oldestMinutes: number;
}

export function summarizeHealth(rows: HealthRow[]): HealthSummary {
  const byQueue: Record<string, number> = {};
  let breached = 0;
  let oldest = 0;
  for (const r of rows) {
    byQueue[r.owner_queue] = (byQueue[r.owner_queue] ?? 0) + 1;
    if (r.breached) breached += 1;
    if (r.age_minutes > oldest) oldest = r.age_minutes;
  }
  return { total: rows.length, breached, byQueue, oldestMinutes: oldest };
}

/** Stable key for a row (a job can appear once per stage; invoices carry their own id). */
export function rowKey(r: HealthRow): string {
  return `${r.stage}:${r.invoice_id ?? ''}:${r.job_id ?? ''}`;
}

export const MIN_TAKEOVER_REASON = 3;
export const MAX_TAKEOVER_REASON = 500;

export function validateTakeoverReason(reason: string): string | null {
  const t = reason.trim();
  if (t.length < MIN_TAKEOVER_REASON) return `Enter a reason (at least ${MIN_TAKEOVER_REASON} characters).`;
  if (t.length > MAX_TAKEOVER_REASON) return `Reason must be at most ${MAX_TAKEOVER_REASON} characters.`;
  return null;
}
