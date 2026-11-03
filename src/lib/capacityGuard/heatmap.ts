import type { HoldRow } from './api';

export interface HeatCell { dayKey: string; hour: number; value: number; campaign: number; released: number }

/** Counts holds per local day x hour (start hour). Pure, so it is unit-tested without a DOM. */
export function buildHeatmap(holds: HoldRow[], dayKeyOf: (ms: number) => string, hourOf: (ms: number) => number): { days: string[]; cells: Map<string, HeatCell> } {
  const cells = new Map<string, HeatCell>();
  const days = new Set<string>();
  for (const h of holds) {
    const ms = Date.parse(h.slot_start);
    if (!Number.isFinite(ms)) continue;
    const dayKey = dayKeyOf(ms), hour = hourOf(ms);
    days.add(dayKey);
    const key = `${dayKey}|${hour}`;
    const c = cells.get(key) ?? { dayKey, hour, value: 0, campaign: 0, released: 0 };
    if (h.status === 'active') { if (h.kind === 'value') c.value += 1; else c.campaign += 1; } else c.released += 1;
    cells.set(key, c);
  }
  return { days: [...days].sort(), cells };
}

export interface Outcome { held: number; consumed: number; released: number; active: number; shadowActive: number }
/** Held-vs-released outcomes. "held" = every hold ever created in range. */
export function summarizeOutcomes(holds: HoldRow[]): Outcome {
  const o: Outcome = { held: holds.length, consumed: 0, released: 0, active: 0, shadowActive: 0 };
  for (const h of holds) {
    if (h.status === 'consumed') o.consumed += 1;
    else if (h.status === 'released') o.released += 1;
    else if (h.shadow) o.shadowActive += 1;
    else o.active += 1;
  }
  return o;
}

export interface WinStats { total: number; filled: number; winRate: number; estimateCents: number; realizedCents: number }
export function summarizeGaps(gaps: { status: string; recovered_estimate_cents: number | null; realized_cents: number | null }[]): WinStats {
  const closed = gaps.filter((g) => g.status !== 'open' && g.status !== 'offered');
  const filled = closed.filter((g) => g.status === 'filled');
  return {
    total: closed.length, filled: filled.length, winRate: closed.length ? filled.length / closed.length : 0,
    estimateCents: filled.reduce((a, g) => a + (g.recovered_estimate_cents ?? 0), 0),
    realizedCents: filled.reduce((a, g) => a + (g.realized_cents ?? 0), 0),
  };
}
