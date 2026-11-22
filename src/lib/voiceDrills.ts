// Voice resilience: drill schedule + evidence log. PURE helpers (no React, no network), unit-tested in voiceDrills.test.ts.
// Rule: the only thing that satisfies the schedule is a PASSED system-verified `forward_on` test call. Manual entries are
// evidence for the owner's own records; they never reset the clock, because only the test call is proof.
import type { CheckKind, CheckStatus } from '@/lib/voiceResilience';

export type ManualDrillKind = 'voicemail' | 'emergency_key' | 'owner_forward' | 'other';
export const MANUAL_DRILL_KINDS: readonly ManualDrillKind[] = ['voicemail', 'emergency_key', 'owner_forward', 'other'];
export type DrillOutcome = 'passed' | 'failed';
export type EvidenceOutcome = DrillOutcome | 'inconclusive';
export type EvidenceKind = CheckKind | ManualDrillKind;

export const MIN_INTERVAL_DAYS = 7;
export const MAX_INTERVAL_DAYS = 90;
export const DEFAULT_INTERVAL_DAYS = 30;
export const MAX_NOTE = 500;
export const DUE_SOON_DAYS = 3;
const DAY = 86_400_000;

export interface DrillSchedule { enabled: boolean; interval_days: number }
export interface CheckRow { id: string; kind: CheckKind; status: CheckStatus; started_at: string; finished_at: string | null }
export interface ManualRow { id: string; kind: ManualDrillKind; outcome: DrillOutcome; note: string | null; created_at: string }

export interface EvidenceEntry {
  id: string;
  source: 'system' | 'manual';
  kind: EvidenceKind;
  outcome: EvidenceOutcome;
  at: string;
  note: string | null;
}

export const isValidInterval = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= MIN_INTERVAL_DAYS && n <= MAX_INTERVAL_DAYS;

export const defaultSchedule = (): DrillSchedule => ({ enabled: true, interval_days: DEFAULT_INTERVAL_DAYS });

export function scheduleFromRow(row: Partial<DrillSchedule> | null | undefined): DrillSchedule {
  if (!row) return defaultSchedule();
  return { enabled: row.enabled !== false, interval_days: isValidInterval(row.interval_days) ? row.interval_days : DEFAULT_INTERVAL_DAYS };
}

/** Test-call status -> evidence outcome. `pending` is still running, so it is not evidence yet (null). */
export function checkOutcome(status: CheckStatus): EvidenceOutcome | null {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return null;
  return 'inconclusive'; // answered_by_human | expired | error: the test did not prove or disprove anything
}

const ts = (iso: string): number => { const n = Date.parse(iso); return Number.isNaN(n) ? 0 : n; };

/** One chronological log (newest first) of system-verified test calls and manual entries. */
export function buildEvidenceLog(checks: readonly CheckRow[], manual: readonly ManualRow[], limit = 200): EvidenceEntry[] {
  const out: EvidenceEntry[] = [];
  for (const c of checks) {
    const outcome = checkOutcome(c.status);
    if (outcome) out.push({ id: `c:${c.id}`, source: 'system', kind: c.kind, outcome, at: c.finished_at ?? c.started_at, note: null });
  }
  for (const m of manual) out.push({ id: `m:${m.id}`, source: 'manual', kind: m.kind, outcome: m.outcome, at: m.created_at, note: m.note });
  return out.sort((a, b) => ts(b.at) - ts(a.at) || (a.id < b.id ? -1 : 1)).slice(0, Math.max(0, limit));
}

export type DrillState = 'disabled' | 'never' | 'ok' | 'due_soon' | 'overdue';
export interface DrillStatus { state: DrillState; lastPassedAt: string | null; dueAt: string | null; daysLeft: number | null }

export function computeDrillStatus(schedule: DrillSchedule, log: readonly EvidenceEntry[], now: number): DrillStatus {
  const last = log.filter((e) => e.source === 'system' && e.kind === 'forward_on' && e.outcome === 'passed').reduce<number | null>((m, e) => (m === null || ts(e.at) > m ? ts(e.at) : m), null);
  const lastPassedAt = last === null ? null : new Date(last).toISOString();
  if (!schedule.enabled) return { state: 'disabled', lastPassedAt, dueAt: null, daysLeft: null };
  if (last === null) return { state: 'never', lastPassedAt: null, dueAt: null, daysLeft: null };
  const due = last + schedule.interval_days * DAY;
  const daysLeft = Math.ceil((due - now) / DAY);
  return { state: now >= due ? 'overdue' : daysLeft <= DUE_SOON_DAYS ? 'due_soon' : 'ok', lastPassedAt, dueAt: new Date(due).toISOString(), daysLeft };
}

export interface ManualDraft { kind: ManualDrillKind; outcome: DrillOutcome; note: string }
export type ManualErrorKey = 'kindInvalid' | 'noteTooLong';

export function validateManualDraft(d: ManualDraft): ManualErrorKey | null {
  if (!MANUAL_DRILL_KINDS.includes(d.kind)) return 'kindInvalid';
  if (d.note.trim().length > MAX_NOTE) return 'noteTooLong';
  return null;
}

export const buildManualPayload = (d: ManualDraft) => ({ action: 'drill_log', kind: d.kind, outcome: d.outcome, note: d.note.trim() || null });
