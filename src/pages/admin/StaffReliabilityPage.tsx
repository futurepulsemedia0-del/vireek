// /staff/reliability — synthetic monitoring + SLO error budgets (Vireek employees only).
// Data: staff_reliability_overview() + slo_multi_window_counts() RPCs
// (20271102000000_synthetic_monitoring_slo.sql). Both re-check profiles.is_staff server-side.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, TriangleAlert as AlertTriangle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import {
  burnRate,
  errorBudget,
  formatPct,
  pickCounts,
  regionsFor,
  windowsFor,
  type BudgetState,
  type SloDefinition,
  type WindowCountRow,
} from '../../../supabase/functions/_shared/synthetic/slo';

interface TargetRow {
  id: string;
  region: string;
  label: string;
  target_number_masked: string;
  interval_minutes: number;
  active: boolean;
  last_run: { status: string; started_at: string; failure_stage: string | null } | null;
}
interface RunRow {
  id: string;
  region: string;
  status: string;
  started_at: string;
  answer_latency_ms: number | null;
  asr_accuracy: number | null;
  booking_ok: boolean | null;
  webhook_ok: boolean | null;
  failure_stage: string | null;
  error: string | null;
}
interface LatencyRow { region: string; samples: number; p50_ms: number; p95_ms: number }
interface IncidentRow { id: string; title: string; impact: string; status: string; region: string | null; source: string; started_at: string }
interface Overview {
  slos: SloDefinition[];
  targets: TargetRow[];
  recent_runs: RunRow[];
  latency: LatencyRow[];
  incidents: IncidentRow[];
}

const STATE_STYLE: Record<BudgetState, string> = {
  no_data: 'bg-bg-tertiary text-text-secondary',
  healthy: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  exhausted: 'bg-danger/10 text-danger',
};
const STATE_LABEL: Record<BudgetState, string> = { no_data: 'No data', healthy: 'Healthy', warning: 'Burning', exhausted: 'Exhausted' };
const RUN_STYLE: Record<string, string> = {
  passed: 'text-success-500',
  failed: 'text-danger',
  error: 'text-warning-500',
  dialing: 'text-text-secondary',
  verifying: 'text-text-secondary',
};

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function StaffReliabilityPage() {
  useSEO({ title: 'Reliability — Staff', description: 'Internal: synthetic monitoring and SLOs.', canonical: 'https://vireek.com/staff/reliability' });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rows, setRows] = useState<WindowCountRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  const load = useCallback(async () => {
    setState((s) => (s === 'ready' ? s : 'loading'));
    const ov = await supabase.rpc('staff_reliability_overview', { p_days: 30 });
    if (ov.error) {
      setMessage(ov.error.message);
      setState(ov.error.message.includes('forbidden') ? 'forbidden' : 'error');
      return;
    }
    const data = ov.data as Overview;
    const windows = Array.from(new Set((data.slos ?? []).flatMap((d) => windowsFor(d.window_days)))).slice(0, 8);
    const counts = await supabase.rpc('slo_multi_window_counts', { p_windows_minutes: windows.length ? windows : [60] });
    if (counts.error) {
      setMessage(counts.error.message);
      setState('error');
      return;
    }
    setOverview(data);
    setRows((counts.data ?? []) as WindowCountRow[]);
    setState('ready');
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const sloCards = useMemo(() => {
    if (!overview) return [];
    return overview.slos.map((slo) => {
      const windowMin = slo.window_days * 1440;
      const regions = slo.region ? [slo.region] : regionsFor(rows, slo.sli);
      const all = errorBudget(pickCounts(rows, windowMin, slo.sli, slo.region), Number(slo.objective));
      const burn1h = burnRate(pickCounts(rows, 60, slo.sli, slo.region), Number(slo.objective));
      const perRegion = regions.map((r) => ({
        region: r,
        budget: errorBudget(pickCounts(rows, windowMin, slo.sli, r), Number(slo.objective)),
      }));
      return { slo, all, burn1h, perRegion };
    });
  }, [overview, rows]);

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-bg-primary">
        <Header />
        <main className="mx-auto max-w-6xl px-6 pt-28" aria-busy="true"><p className="text-text-secondary">Loading reliability data…</p></main>
      </div>
    );
  }
  if (state === 'forbidden' || state === 'error' || !overview) {
    return (
      <div className="min-h-screen bg-bg-primary">
        <Header />
        <main className="mx-auto max-w-6xl px-6 pt-28">
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 p-5 text-danger">
            <AlertTriangle size={18} className="mr-2 inline" aria-hidden="true" />
            {state === 'forbidden' ? 'Staff access required.' : `Could not load reliability data: ${message}`}
          </div>
        </main>
      </div>
    );
  }

  const openIncidents = overview.incidents.filter((i) => i.status !== 'resolved');

  return (
    <div className="min-h-screen bg-bg-primary">
      <Header />
      <main className="mx-auto max-w-6xl space-y-8 px-6 pb-24 pt-28">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Reliability</h1>
            <p className="mt-1 text-sm text-text-secondary">Synthetic test calls through the real AI path. 30-day error budgets, refreshed every minute.</p>
          </div>
          <Button type="button" variant="secondary" onClick={() => void load()}>
            <RefreshCw size={14} className="mr-2" aria-hidden="true" /> Refresh
          </Button>
        </div>

        {openIncidents.length > 0 && (
          <section aria-label="Open incidents" className="rounded-2xl border border-danger/30 bg-danger/10 p-5">
            <h2 className="font-semibold text-danger">Open incidents ({openIncidents.length})</h2>
            <ul className="mt-2 space-y-1 text-sm text-text-primary">
              {openIncidents.map((i) => (
                <li key={i.id}>{i.title} · {i.impact} · {i.source} · started {ago(i.started_at)}</li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="SLO error budgets" className="grid gap-4 md:grid-cols-2">
          {sloCards.map(({ slo, all, burn1h, perRegion }) => (
            <article key={slo.key} className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-text-primary">{slo.label}</h2>
                  <p className="text-xs text-text-secondary">Objective {formatPct(Number(slo.objective), 1)} over {slo.window_days} days</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATE_STYLE[all.state]}`}>{STATE_LABEL[all.state]}</span>
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                <div><dt className="text-text-secondary">SLI</dt><dd className="font-semibold tabular-nums text-text-primary">{formatPct(all.sli)}</dd></div>
                <div><dt className="text-text-secondary">Budget left</dt><dd className="font-semibold tabular-nums text-text-primary">{all.remaining === null ? '—' : formatPct(Math.max(all.remaining, -9.99), 0)}</dd></div>
                <div><dt className="text-text-secondary">Burn (1h)</dt><dd className="font-semibold tabular-nums text-text-primary">{burn1h === null ? '—' : `${burn1h.toFixed(1)}x`}</dd></div>
              </dl>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`Error budget consumed ${all.consumed === null ? 'unknown' : formatPct(Math.min(all.consumed, 1), 0)}`}>
                <div className={`h-full ${all.state === 'exhausted' ? 'bg-danger' : all.state === 'warning' ? 'bg-warning-500' : 'bg-success-500'}`} style={{ width: `${all.consumed === null ? 0 : Math.min(all.consumed, 1) * 100}%` }} />
              </div>
              <p className="mt-2 text-xs text-text-secondary">{all.good}/{all.total} good events</p>
              {perRegion.length > 1 && (
                <ul className="mt-3 divide-y divide-border text-sm">
                  {perRegion.map(({ region, budget }) => (
                    <li key={region} className="flex items-center justify-between py-1.5">
                      <span className="text-text-primary">{region}</span>
                      <span className="tabular-nums text-text-secondary">{formatPct(budget.sli)} · {budget.good}/{budget.total}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>

        <section aria-label="Answer latency" className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h2 className="font-semibold text-text-primary">Answer latency by region (30 days)</h2>
          {overview.latency.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">No samples yet.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead><tr className="text-left text-text-secondary"><th scope="col" className="py-1">Region</th><th scope="col" className="text-right">p50</th><th scope="col" className="text-right">p95</th><th scope="col" className="text-right">Samples</th></tr></thead>
              <tbody>
                {overview.latency.map((l) => (
                  <tr key={l.region} className="border-t border-border">
                    <td className="py-1.5 text-text-primary">{l.region}</td>
                    <td className="text-right tabular-nums">{l.p50_ms} ms</td>
                    <td className="text-right tabular-nums">{l.p95_ms} ms</td>
                    <td className="text-right tabular-nums">{l.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section aria-label="Probe targets" className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h2 className="font-semibold text-text-primary">Probe targets</h2>
          {overview.targets.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">No targets configured. See docs/runbooks/synthetic-monitoring.md.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border text-sm">
              {overview.targets.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-text-primary">{t.region} · {t.label} · {t.target_number_masked}</span>
                  <span className="text-text-secondary">
                    every {t.interval_minutes}m · {t.active ? 'active' : 'paused'} ·{' '}
                    {t.last_run ? <span className={RUN_STYLE[t.last_run.status]}>{t.last_run.status}{t.last_run.failure_stage ? ` (${t.last_run.failure_stage})` : ''} {ago(t.last_run.started_at)}</span> : 'never run'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Recent runs" className="rounded-2xl border border-border bg-bg-secondary p-5">
          <h2 className="font-semibold text-text-primary">Recent runs</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="text-left text-text-secondary"><th scope="col" className="py-1">When</th><th scope="col">Region</th><th scope="col">Status</th><th scope="col" className="text-right">Latency</th><th scope="col" className="text-right">ASR</th><th scope="col">Booking</th><th scope="col">Webhook</th></tr></thead>
              <tbody>
                {overview.recent_runs.map((r) => (
                  <tr key={r.id} className="border-t border-border" title={r.error ?? undefined}>
                    <td className="py-1.5">{ago(r.started_at)}</td>
                    <td>{r.region}</td>
                    <td className={RUN_STYLE[r.status]}>{r.status}{r.failure_stage ? ` · ${r.failure_stage}` : ''}</td>
                    <td className="text-right tabular-nums">{r.answer_latency_ms === null ? '—' : `${r.answer_latency_ms} ms`}</td>
                    <td className="text-right tabular-nums">{r.asr_accuracy === null ? '—' : formatPct(Number(r.asr_accuracy), 0)}</td>
                    <td>{r.booking_ok === null ? '—' : r.booking_ok ? 'ok' : 'failed'}</td>
                    <td>{r.webhook_ok === null ? '—' : r.webhook_ok ? 'ok' : 'failed'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
