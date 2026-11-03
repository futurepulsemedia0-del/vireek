import { useEffect, useState } from 'react';
import { getMyComparison, type Comparison } from '@/lib/stateOfCalls';

const LABELS: Record<string, string> = { answer_rate: 'Answer rate', missed_call_rate: 'Missed-call rate', after_hours_share: 'After-hours share', emergency_share: 'Emergency share', booking_conversion: 'Booking conversion' };

/** "You vs. similar businesses" — contributors only. Peers come from PUBLISHED, k-anonymous cells; never from raw tenant data. */
export function ReportBenchmarkWidget() {
  const [data, setData] = useState<Comparison | null>(null);
  const [locked, setLocked] = useState(false);
  useEffect(() => { getMyComparison().then(setData).catch(() => setLocked(true)); }, []);
  if (locked) return <p className="rounded-xl border border-border p-4 text-sm text-text-secondary">Contribute anonymized statistics (Settings → Data sharing) to unlock “You vs. similar businesses”.</p>;
  if (!data) return null;
  if (!data.edition || !data.rows.length) return <p className="rounded-xl border border-border p-4 text-sm text-text-secondary">No published report edition to compare with yet.</p>;
  return (
    <section aria-labelledby="rb-h" className="rounded-xl border border-border bg-bg-secondary p-5">
      <h3 id="rb-h" className="text-base font-semibold text-text-primary">You vs. similar businesses</h3>
      <p className="text-xs text-text-secondary">{data.edition.title} · same period · peers = middle half of contributing businesses ({data.rows[0].peer_dim === 'trade' ? 'your trade' : 'all trades'}).</p>
      <table className="mt-3 w-full text-sm"><thead><tr className="text-left text-text-secondary"><th scope="col">Metric</th><th scope="col">You</th><th scope="col">Peers (p25–p75)</th></tr></thead>
        <tbody>{data.rows.map((r) => <tr key={r.metric_key}><th scope="row" className="py-1 text-left font-medium">{LABELS[r.metric_key] ?? r.metric_key}</th><td>{r.my_value === null ? 'Not enough calls' : `${r.my_value}%`}</td><td>{r.peer_p25}%–{r.peer_p75}% (median {r.peer_p50}%)</td></tr>)}</tbody></table>
    </section>
  );
}
