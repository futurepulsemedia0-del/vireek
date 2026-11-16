/**
 * Staff — /staff/customer-health. Rule-based, explainable health + churn-risk per tenant.
 * Data: public.staff_customer_health() (staff-only RPC). Scoring: src/lib/customerHealth.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, HeartPulse } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { rankCustomers, type HealthSignals, type RiskLevel } from '@/lib/customerHealth';

const FILTERS: { value: RiskLevel | 'all'; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'high', label: 'High risk' },
  { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Healthy' },
];

export function StaffCustomerHealthPage() {
  const [rows, setRows] = useState<HealthSignals[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [filter, setFilter] = useState<RiskLevel | 'all'>('all');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setStatus('loading');
    const { data, error } = await supabase.rpc('staff_customer_health', { p_limit: 500 });
    if (error) { setStatus('error'); return; }
    setRows((data ?? []) as HealthSignals[]);
    setStatus('ready');
  }, []);
  useEffect(() => { void load(); }, [load]);

  const ranked = useMemo(() => rankCustomers(rows), [rows]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ranked.filter((r) =>
      (filter === 'all' || r.health.risk === filter) &&
      (!needle || r.signals.email.toLowerCase().includes(needle) || (r.signals.company_name ?? '').toLowerCase().includes(needle)));
  }, [ranked, filter, q]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <h1 className="text-2xl font-semibold text-text-primary">Customer health</h1>
      <p className="mt-1 text-sm text-text-secondary">Rule-based and explainable: every point lost shows its reason. Latest 500 accounts.</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Risk filter" className="flex gap-1 rounded-xl bg-bg-tertiary p-1">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" role="tab" aria-selected={filter === f.value} onClick={() => setFilter(f.value)}
              className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium ${filter === f.value ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>{f.label}</button>
          ))}
        </div>
        <input aria-label="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email or company"
          className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
      </div>

      <div className="mt-4">
        {status === 'loading' && <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>}
        {status === 'error' && <EmptyState icon={AlertCircle} title="Couldn’t load customer health" description="Staff access is required. Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />}
        {status === 'ready' && visible.length === 0 && <EmptyState icon={HeartPulse} title="No accounts match" description="Change the filter or search." />}
        {status === 'ready' && visible.length > 0 && (
          <ul className="space-y-2">
            {visible.map(({ signals: s, health: h }) => (
              <li key={s.account_id} className="rounded-xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text-primary">{s.company_name || s.email}</p>
                    <p className="truncate text-xs text-text-secondary">{s.email} · {s.plan} · calls 7d {s.calls_7d} / 30d {s.calls_30d}</p>
                  </div>
                  <p className="text-sm font-semibold text-text-primary" aria-label={`Health ${h.score} of 100, ${h.risk} risk`}>
                    {h.score}/100 · {h.risk === 'high' ? 'High risk' : h.risk === 'medium' ? 'Medium risk' : 'Healthy'}
                  </p>
                </div>
                {h.reasons.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {h.reasons.map((r) => <li key={r.code} className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-primary">{r.label} (−{r.points})</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
