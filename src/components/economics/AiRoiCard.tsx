// Customer-facing ROI card built ONLY from the customer's own data. Every figure shows its formula and data source
// (hover or tap), "booked" / "measured" / "estimate" are labelled separately, and missing data reads "Not enough data yet".
import { useEffect, useState } from 'react';
import { fetchAiRoi } from '@/lib/aiRoi';
import type { AiRoi, Metric } from '../../../supabase/functions/_shared/economics/aiRoi';

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const KIND_LABEL: Record<Metric['kind'], string> = { measured: 'Measured', booked: 'Booked', estimated: 'Estimate' };
const KIND_STYLE: Record<Metric['kind'], string> = {
  measured: 'bg-accent/10 text-accent',
  booked: 'bg-bg-tertiary text-text-secondary',
  estimated: 'bg-warning-subtle text-warning-strong',
};

function show(m: Metric): string {
  if (m.status === 'not_enough_data' || m.value === null) return 'Not enough data yet';
  if (m.unit === 'cents') return usd(m.value);
  if (m.unit === 'hours') return `${m.value} h`;
  return m.value.toLocaleString('en-US');
}

function MetricRow({ m }: { m: Metric }) {
  const [open, setOpen] = useState(false);
  const id = `roi-why-${m.key}`;
  return (
    <li className="rounded-xl border border-border p-3" title={`${m.formula} — source: ${m.source}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-text-secondary">{m.label}</p>
          <p className={`mt-0.5 text-xl font-semibold tabular-nums ${m.status === 'ok' ? 'text-text-primary' : 'text-text-secondary'}`}>{show(m)}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${KIND_STYLE[m.kind]}`}>{KIND_LABEL[m.kind]}</span>
      </div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        className="focus-ring mt-1 min-h-[44px] text-xs font-medium text-accent underline">
        {open ? 'Hide how this is calculated' : 'How is this calculated?'}
      </button>
      {open && (
        <dl id={id} className="mt-1 space-y-1 text-xs text-text-secondary">
          <div><dt className="inline font-medium">Formula: </dt><dd className="inline">{m.formula}</dd></div>
          <div><dt className="inline font-medium">Data source: </dt><dd className="inline">{m.source}</dd></div>
          {m.note && <div><dt className="inline font-medium">Note: </dt><dd className="inline">{m.note}</dd></div>}
        </dl>
      )}
    </li>
  );
}

export function AiRoiCard({ defaultDays = 30 }: { defaultDays?: 30 | 90 }) {
  const [days, setDays] = useState<30 | 90>(defaultDays);
  const [data, setData] = useState<AiRoi | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null); setFailed(false);
    fetchAiRoi(days).then((d) => { if (live) setData(d); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [days]);

  return (
    <section aria-label="What the AI receptionist delivered" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text-primary">What your AI delivered (last {days} days)</h2>
        <div role="group" aria-label="Period" className="flex gap-1">
          {([30, 90] as const).map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
              className={`focus-ring min-h-[44px] rounded-lg px-3 text-sm ${days === d ? 'bg-accent text-on-accent' : 'bg-bg-tertiary text-text-secondary'}`}>{d}d</button>
          ))}
        </div>
      </div>

      {failed && <p role="alert" className="mt-3 text-sm text-danger">We couldn’t load these figures right now.</p>}
      {!failed && !data && <div role="status" aria-label="Loading" className="mt-3 h-40 animate-pulse rounded-xl bg-bg-tertiary" />}

      {data && (
        <>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {Object.values(data.metrics).map((m) => <MetricRow key={m.key} m={m} />)}
          </ul>

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-text-primary">AI-attributed revenue funnel</h3>
            <p className="mt-1 text-xs text-text-secondary">Revenue is only credited to the AI when the job was booked by it, completed, and its invoice is paid.</p>
            <ol className="mt-2 grid grid-cols-3 gap-2 text-center">
              {data.funnel.map((f) => (
                <li key={f.key} className="rounded-xl bg-bg-tertiary p-3">
                  <p className="text-xl font-semibold tabular-nums text-text-primary">{f.count}</p>
                  <p className="text-xs text-text-secondary">{f.label}</p>
                </li>
              ))}
            </ol>
            {data.paidWithoutAmount > 0 && <p className="mt-2 text-xs text-text-secondary">{data.paidWithoutAmount} paid job(s) have no amount recorded and add $0 above.</p>}
            {data.truncated && <p className="mt-2 text-xs text-text-secondary">Showing the 2,000 most recent AI bookings in this period.</p>}
          </div>
        </>
      )}
    </section>
  );
}
