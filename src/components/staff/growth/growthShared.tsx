import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import { useGrowthT } from '@/i18n/growthNamespace';
import type { Interval, MetricValue } from '@/lib/growth/growthMetrics';

export interface AsyncState<T> {
  data: T | null;
  error: boolean;
  loading: boolean;
  reload: () => void;
}

/** Loads on mount and whenever `key` changes; ignores stale responses. */
export function useAsync<T>(load: () => Promise<T>, key: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    loadRef.current().then(
      (d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}

export function useFormatters() {
  const { language } = useGrowthT();
  return {
    money: (cents: number, currency: string) => {
      try {
        return new Intl.NumberFormat(language, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
      } catch {
        return `${(cents / 100).toFixed(0)} ${currency.toUpperCase()}`;
      }
    },
    pct: (v: number, digits = 1) => new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: digits }).format(v),
    num: (v: number, digits = 1) => new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(v),
    date: (d: Date) => new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(d),
  };
}

export function AsyncBoundary<T>({ state, children }: { state: AsyncState<T>; children: (data: T) => ReactNode }) {
  const { t } = useGrowthT();
  if (state.loading && !state.data) {
    return (
      <div className="space-y-3" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (state.error || !state.data) {
    return (
      <div role="alert" className="rounded-xl bg-danger/10 p-4 text-sm text-text-primary">
        {t('common.loadFailed')}{' '}
        <button type="button" onClick={state.reload} className="focus-ring font-semibold underline">
          {t('common.retry')}
        </button>
      </div>
    );
  }
  return <>{children(state.data)}</>;
}

/** KPI tile that always shows: value or "insufficient", sample size, measured/estimated label and the formula. */
export function MetricTile({ label, formula, metric, format, interval }: { label: string; formula: string; metric: MetricValue; format: (v: number) => string; interval?: Interval | null }) {
  const { t } = useGrowthT();
  return (
    <Card interactive={false} className="space-y-1 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="text-2xl font-bold text-text-primary">{metric.value === null ? t('common.insufficient') : format(metric.value)}</p>
      <p className="text-xs text-text-secondary">
        {t(metric.label === 'estimated' ? 'common.estimated' : 'common.measured')} · {t('common.sampleSize', { n: metric.n })}
        {interval && metric.value !== null ? ` · ${t('common.ci95', { low: format(interval.low), high: format(interval.high) })}` : ''}
      </p>
      {metric.status === 'low_sample' && (
        <p role="note" className="rounded-lg bg-warning-500/10 px-2 py-1 text-xs text-text-primary">
          {t('common.lowSample', { min: 30 })}
        </p>
      )}
      {metric.reason && metric.status === 'insufficient' && <p className="text-xs text-text-secondary">{t(`reason.${metric.reason}`)}</p>}
      <p className="text-[11px] text-text-secondary">
        <span className="font-semibold">{t('common.formula')}:</span> {formula}
      </p>
    </Card>
  );
}

export function SectionTitle({ id, children, hint }: { id: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <h2 id={id} className="text-base font-semibold text-text-primary">
        {children}
      </h2>
      {hint && <p className="text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function DataTable({ caption, head, children }: { caption: string; head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-start text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-bg-secondary text-xs text-text-secondary">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 text-start font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border text-text-primary">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children }: { children: ReactNode }) => <td className="px-3 py-2 align-top">{children}</td>;

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="rounded-xl bg-warning-500/10 p-3 text-xs text-text-primary">
      {children}
    </p>
  );
}
