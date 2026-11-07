// Results Plan — integrity signals in BOTH directions (pure). Flags are leads for review, never auto-accusations.

export interface WeekStat {
  weekStart: string;
  /** Sarah-booked jobs whose scheduled date has passed. */
  due: number;
  /** Of those, how many got a completion mark. */
  marked: number;
  /** Jobs the owner flipped from completed -> something else after a charge was posted. */
  relabeledAfterCharge: number;
  /** Jobs we qualified this week. */
  qualified: number;
}

export type FlagCode = 'completion_marking_drop' | 'relabel_after_charge' | 'qualification_spike';
export interface Flag { code: FlagCode; severity: 'info' | 'warn' | 'high'; detail: string }

export const ANOMALY_DEFAULTS = {
  minDue: 8, // PLACEHOLDER: ignore tiny samples
  dropRatio: 0.5, // PLACEHOLDER: this week's rate < 50% of baseline
  minBaselineWeeks: 4,
  relabelHigh: 3,
  spikeMultiple: 2.5,
};

const rate = (w: WeekStat) => (w.due > 0 ? w.marked / w.due : null);

/** `weeks` oldest -> newest; the last element is the week under test. */
export function detectAnomalies(weeks: readonly WeekStat[], cfg = ANOMALY_DEFAULTS): Flag[] {
  const flags: Flag[] = [];
  if (weeks.length < 2) return flags;
  const cur = weeks[weeks.length - 1];
  const base = weeks.slice(0, -1).filter((w) => w.due >= cfg.minDue);
  if (base.length >= cfg.minBaselineWeeks && cur.due >= cfg.minDue) {
    const baseRate = base.reduce((s, w) => s + (rate(w) ?? 0), 0) / base.length;
    const curRate = rate(cur) ?? 0;
    if (baseRate > 0 && curRate < baseRate * cfg.dropRatio) {
      flags.push({
        code: 'completion_marking_drop',
        severity: curRate < baseRate * cfg.dropRatio * 0.5 ? 'high' : 'warn',
        detail: `Completion marking fell to ${Math.round(curRate * 100)}% from a ${Math.round(baseRate * 100)}% baseline.`,
      });
    }
  }
  if (cur.relabeledAfterCharge > 0) {
    flags.push({
      code: 'relabel_after_charge',
      severity: cur.relabeledAfterCharge >= cfg.relabelHigh ? 'high' : 'warn',
      detail: `${cur.relabeledAfterCharge} job(s) re-labelled after a charge was posted.`,
    });
  }
  const prior = weeks.slice(0, -1);
  if (prior.length >= cfg.minBaselineWeeks) {
    const avg = prior.reduce((s, w) => s + w.qualified, 0) / prior.length;
    if (avg >= 1 && cur.qualified > avg * cfg.spikeMultiple && cur.qualified >= cfg.minDue) {
      flags.push({ code: 'qualification_spike', severity: 'info', detail: `Qualified ${cur.qualified} jobs vs ${avg.toFixed(1)}/week average (check our own over-counting).` });
    }
  }
  return flags;
}
