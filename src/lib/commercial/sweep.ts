/** Commercial pack — turns one sweep-batch row (commercial_sla_sweep_batch) into an apply-result (PURE). */
import { capPauses, dueEscalations, evaluateTimer, validateCalendar, type EscalationStep, type Pause, type SlaCalendar } from './slaClock';

export interface SweepRow {
  timer_id: string;
  started_at: string;
  target_minutes: number;
  warn_at_pct: number;
  max_pause_minutes: number | null;
  escalation: EscalationStep[];
  calendar: SlaCalendar;
  pauses: Pause[];
  fired_keys: string[];
}

export interface SweepResult {
  timer_id: string;
  state: 'running' | 'at_risk' | 'paused' | 'breached';
  due_at: string | null;
  pct_elapsed: number;
  over_minutes: number;
  fired: Array<{ key: string; notify: string; at_pct: number }>;
}

/** Returns null for a row that cannot be evaluated (bad calendar / data); the caller logs and moves on. */
export function evaluateSweepRow(row: SweepRow, nowIso: string): SweepResult | null {
  if (validateCalendar(row.calendar).length > 0) return null;
  try {
    const pauses = capPauses(row.pauses ?? [], row.max_pause_minutes, Date.parse(nowIso));
    const ev = evaluateTimer({ startedAt: row.started_at, targetMinutes: row.target_minutes, calendar: row.calendar, pauses, warnAtPct: row.warn_at_pct }, nowIso);
    if (ev.state === 'met' || ev.state === 'missed') return null; // only reachable when stopped; sweep rows are never stopped
    const fired = dueEscalations(ev, row.escalation ?? [], new Set(row.fired_keys ?? [])).map((s) => ({ key: s.key, notify: s.notify, at_pct: s.atPct }));
    return { timer_id: row.timer_id, state: ev.state, due_at: ev.dueAt, pct_elapsed: ev.pctElapsed, over_minutes: ev.overByMinutes, fired };
  } catch {
    return null;
  }
}
