import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabase';
import type { DeviceClass, VitalName } from '@/lib/perf/vitals';

interface Row {
  route: string;
  metric: VitalName;
  device: DeviceClass;
  samples: number;
  p75: number;
  p75_prev: number | null;
  good_ratio: number;
}

/** Team budgets (stricter than Google's "good"), p75 per route + device. */
const BUDGET: Record<VitalName, number> = { LCP: 2000, CLS: 0.05, INP: 200, FCP: 1500, TTFB: 600 };
const REGRESSION_RATIO = 1.2;
const MIN_SAMPLES_FOR_REGRESSION = 50;

const fmt = (metric: VitalName, v: number) => (metric === 'CLS' ? v.toFixed(3) : `${Math.round(v)} ms`);
const isOver = (r: Row) => r.p75 > BUDGET[r.metric];
const isRegression = (r: Row) =>
  r.p75_prev !== null && r.p75_prev > 0 && r.samples >= MIN_SAMPLES_FOR_REGRESSION && r.p75 > r.p75_prev * REGRESSION_RATIO;

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; rows: Row[] };

export function StaffWebVitalsPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const { data, error } = await supabase.rpc('rum_vitals_summary', { p_days: days });
    setState(error ? { status: 'error' } : { status: 'ready', rows: (data ?? []) as Row[] });
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const flagged = state.status === 'ready' ? state.rows.filter((r) => isOver(r) || isRegression(r)).length : 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-bold text-text-primary">{t('net.vitals.title', 'Real-user web vitals')}</h1>
      <p className="mt-1 text-sm text-text-secondary">
        {t('net.vitals.subtitle', 'p75 from real visitors who accepted analytics cookies. Budgets: LCP 2.0 s, CLS 0.05, INP 200 ms, FCP 1.5 s, TTFB 600 ms.')}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-text-primary" htmlFor="vitals-days">
          {t('net.vitals.range', 'Range')}
        </label>
        <select
          id="vitals-days"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary"
        >
          {[7, 14, 30].map((d) => (
            <option key={d} value={d}>
              {t('net.vitals.days', { count: d, defaultValue: 'Last {{count}} days' })}
            </option>
          ))}
        </select>
        {state.status === 'ready' && flagged > 0 ? (
          <span role="status" className="rounded-full bg-danger/10 px-3 py-1 text-xs font-semibold text-danger">
            {t('net.vitals.flagged', { count: flagged, defaultValue: '{{count}} rows over budget or regressing' })}
          </span>
        ) : null}
      </div>

      <div className="mt-6">
        {state.status === 'loading' ? (
          <p role="status" className="text-sm text-text-secondary">
            {t('net.vitals.loading', 'Loading…')}
          </p>
        ) : state.status === 'error' ? (
          <div role="alert" className="rounded-xl border border-border bg-bg-secondary p-4 text-sm text-text-primary">
            {t('net.vitals.error', 'Could not load vitals (staff access required).')}{' '}
            <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">
              {t('net.offline.retry')}
            </button>
          </div>
        ) : state.rows.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('net.vitals.empty', 'Not enough samples yet (minimum 20 per row).')}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">{t('net.vitals.title', 'Real-user web vitals')}</caption>
              <thead className="bg-bg-secondary text-start text-text-secondary">
                <tr>
                  {['Route', 'Metric', 'Device', 'Samples', 'p75', 'vs previous'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start font-semibold">
                      {t(`net.vitals.col.${h}`, h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.rows.map((r) => {
                  const delta = r.p75_prev && r.p75_prev > 0 ? Math.round((r.p75 / r.p75_prev - 1) * 100) : null;
                  return (
                    <tr key={`${r.route}|${r.metric}|${r.device}`} className="border-t border-border text-text-primary">
                      <td className="px-3 py-2 font-mono text-xs">{r.route}</td>
                      <td className="px-3 py-2">{r.metric}</td>
                      <td className="px-3 py-2">{r.device}</td>
                      <td className="px-3 py-2">{r.samples}</td>
                      <td className={`px-3 py-2 font-semibold ${isOver(r) ? 'text-danger' : ''}`}>{fmt(r.metric, r.p75)}</td>
                      <td className={`px-3 py-2 ${isRegression(r) ? 'font-semibold text-danger' : 'text-text-secondary'}`}>
                        {delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
