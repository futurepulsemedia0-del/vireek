// Display helpers for the analytics screens. Pure. `null` always renders as an em dash, never as 0.
export const fmtPct = (bp: number | null | undefined): string => (bp === null || bp === undefined ? '—' : `${(bp / 100).toFixed(1)}%`);

export const fmtUsd = (cents: number | null | undefined): string =>
  cents === null || cents === undefined
    ? '—'
    : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export interface Delta { text: string; tone: 'good' | 'bad' | 'flat' | 'none' }

/** Change vs the previous period. `better` says which direction is good for this metric. */
export function fmtDelta(cur: number | null, prev: number | null, kind: 'pct' | 'usd', better: 'up' | 'down'): Delta {
  if (cur === null || prev === null) return { text: 'no comparison', tone: 'none' };
  const d = cur - prev;
  if (d === 0) return { text: 'no change', tone: 'flat' };
  const abs = Math.abs(d);
  const body = kind === 'pct' ? `${(abs / 100).toFixed(1)} pts` : fmtUsd(abs);
  const good = better === 'up' ? d > 0 : d < 0;
  return { text: `${d > 0 ? '+' : '-'}${body}`, tone: good ? 'good' : 'bad' };
}

export const rangeFromDays = (days: number, today = new Date()): { from: string; to: string } => {
  const to = today.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
};

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
