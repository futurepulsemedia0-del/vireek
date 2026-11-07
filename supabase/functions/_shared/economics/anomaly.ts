// supabase/functions/_shared/economics/anomaly.ts
// Pure anomaly rules for the economics sweep. No I/O.

export interface SpikeOptions { ratio: number; minDays: number; absFloorMicro: number }
export const DEFAULT_SPIKE: SpikeOptions = { ratio: 2.5, minDays: 5, absFloorMicro: 20_000 }; // 2.5x median AND >= $0.02/call over it

export interface SpikeVerdict { spike: boolean; medianMicro: number | null; ratio: number | null; reason: "ok" | "insufficient_history" | "spike" | "no_today" }

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** `history` = prior days' micro-USD per call (days with no calls omitted); `today` = today's, or null. */
export function detectCostSpike(history: readonly number[], today: number | null, o: SpikeOptions = DEFAULT_SPIKE): SpikeVerdict {
  if (today === null || !Number.isFinite(today)) return { spike: false, medianMicro: null, ratio: null, reason: "no_today" };
  const h = history.filter((x) => Number.isFinite(x) && x >= 0);
  if (h.length < o.minDays) return { spike: false, medianMicro: null, ratio: null, reason: "insufficient_history" };
  const med = median(h);
  const ratio = med > 0 ? today / med : null;
  const spike = (ratio === null ? today > o.absFloorMicro : ratio > o.ratio) && today - med > o.absFloorMicro;
  return { spike, medianMicro: med, ratio, reason: spike ? "spike" : "ok" };
}

export function correlationShortfall(withCorrelation: number, total: number, minPct = 90): { alert: boolean; pct: number | null } {
  if (total <= 0) return { alert: false, pct: null };
  const pct = (withCorrelation / total) * 100;
  return { alert: pct < minPct, pct };
}
