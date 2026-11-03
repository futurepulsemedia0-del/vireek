import { formatDate } from '@/lib/format';
import { useAgentReadinessT } from '@/i18n/agentReadinessNamespace';
import type { History } from '@/lib/agentReadinessCore';

const W = 320;
const H = 90;

function Line({ values, label, max }: { values: number[]; label: string; max: number }) {
  const step = values.length > 1 ? W / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - (Math.min(v, max) / Math.max(max, 1)) * (H - 8) - 4).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label={label}>
      <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke="currentColor" className="text-border" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="text-accent" />
    </svg>
  );
}

/** Two small charts, one table fallback for screen readers. Correlation only — the copy says so. */
export function HistoryChart({ history }: { history: History }) {
  const { t } = useAgentReadinessT();
  const scans = history.scans.filter((s) => s.score !== null);
  if (scans.length < 2) return <p className="text-sm text-text-secondary">{t('historyEmpty')}</p>;
  const fmt = (iso: string) => formatDate(iso);
  const calls = history.weekly_calls;
  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        <figure>
          <figcaption className="text-xs font-medium text-text-secondary">{t('historyScore')}</figcaption>
          <Line values={scans.map((s) => s.score as number)} max={100} label={t('historyScore')} />
        </figure>
        <figure>
          <figcaption className="text-xs font-medium text-text-secondary">{t('historyCalls')}</figcaption>
          {calls.length > 1 ? <Line values={calls.map((c) => c.calls)} max={Math.max(...calls.map((c) => c.calls))} label={t('historyCalls')} /> : <p className="text-sm text-text-secondary">{t('historyEmpty')}</p>}
        </figure>
      </div>
      <p className="mt-2 text-xs text-text-secondary">{t('historyNote')}</p>
      <table className="sr-only">
        <caption>{t('historyTable')}</caption>
        <thead><tr><th scope="col">{t('historyScore')}</th><th scope="col">{t('lastScan', { date: '' })}</th></tr></thead>
        <tbody>{scans.map((s) => <tr key={s.id}><td>{s.score}</td><td>{fmt(s.created_at)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
