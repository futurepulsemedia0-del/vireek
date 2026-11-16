// /staff/fairness-audit — outcome disparities of the AI call reviewer by detected language, region
// (country calling code) and customer type (Vireek employees only).
// Data: staff_fairness_overview() RPC (20290305000000_fairness_audit.sql), which re-checks staff access
// server-side and returns aggregated cells only. Statistics: supabase/functions/_shared/fairness/audit.ts.
// Method, limits and report template: docs/ai-governance/fairness-audit.md.
// Internal staff page: English copy like the other /staff pages; layout uses logical (RTL-safe) utilities.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { useSEO } from '@/lib/seo';
import {
  evaluate,
  type AuditReport,
  type GapStatus,
  type GroupResult,
  type MetricResult,
} from '../../../supabase/functions/_shared/fairness/audit';

interface Overview {
  generated_at: string;
  days: number;
  low_score_below: number;
  cells: Array<Record<string, unknown>>;
}

type LoadState = 'loading' | 'ready' | 'error' | 'forbidden';

const WINDOWS = [30, 90, 180, 365] as const;

const STATUS_STYLE: Record<GapStatus, string> = {
  gap_adverse: 'bg-danger/10 text-danger',
  gap_favorable: 'bg-success-500/10 text-success-500',
  no_material_gap: 'bg-bg-tertiary text-text-secondary',
};
const STATUS_LABEL: Record<GapStatus, string> = {
  gap_adverse: 'Review (adverse)',
  gap_favorable: 'Favorable gap',
  no_material_gap: 'No material gap',
};
const DIMENSION_TITLE: Record<string, string> = {
  language: 'Detected language',
  region: 'Region (country calling code)',
  customer_type: 'Customer type',
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

function fmtMetric(m: MetricResult, v: number): string {
  return m.key === 'mean_score' ? v.toFixed(1) : pct(v);
}
function fmtGap(m: MetricResult): string {
  return m.key === 'mean_score'
    ? `${signed(m.gap)} (${signed(m.ci_low)} to ${signed(m.ci_high)})`
    : `${signed(m.gap * 100)} pp (${signed(m.ci_low * 100)} to ${signed(m.ci_high * 100)})`;
}

function GroupRows({ g }: { g: GroupResult }) {
  if (g.suppressed) {
    return (
      <tr className="border-t border-border text-text-secondary">
        <th scope="row" className="py-2 pe-3 text-start font-medium text-text-primary">
          {g.group}
          {g.missing_data ? <span className="ms-2 text-xs text-text-secondary">(missing data)</span> : null}
        </th>
        <td colSpan={5} className="py-2 text-xs">Suppressed — {g.suppression_reason}. Counts hidden.</td>
      </tr>
    );
  }
  return (
    <>
      {g.metrics.map((m, i) => (
        <tr key={m.key} className={i === 0 ? 'border-t border-border' : ''}>
          <th scope="row" className="py-1.5 pe-3 text-start font-medium text-text-primary">
            {i === 0 ? (
              <>
                {g.group}
                {g.missing_data ? <span className="ms-2 text-xs font-normal text-text-secondary">(missing data)</span> : null}
                <span className="block text-xs font-normal text-text-secondary">{g.calls} calls · {g.reviewed} reviewed · {g.accounts}+ accounts</span>
              </>
            ) : <span className="sr-only">{g.group}</span>}
          </th>
          <td className="py-1.5 pe-3 text-text-secondary">{m.label}</td>
          <td className="py-1.5 pe-3 tabular-nums text-text-primary">{fmtMetric(m, m.value)}</td>
          <td className="py-1.5 pe-3 tabular-nums text-text-secondary">{fmtMetric(m, m.rest_value)}</td>
          <td className="py-1.5 pe-3 tabular-nums text-text-secondary">{fmtGap(m)}</td>
          <td className="py-1.5">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[m.status]}`}>{STATUS_LABEL[m.status]}</span>
          </td>
        </tr>
      ))}
    </>
  );
}

export function StaffFairnessAuditPage() {
  useSEO({ title: 'Fairness audit — Staff', description: 'Internal: AI reviewer outcome disparities.', canonical: 'https://vireek.com/staff/fairness-audit' });
  const [days, setDays] = useState<number>(90);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [state, setState] = useState<LoadState>('loading');
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
    const res = await supabase.rpc('staff_fairness_overview', { p_days: days, p_low_score: 60 });
    if (res.error) {
      setMessage(res.error.message);
      setState(res.error.message.includes('forbidden') ? 'forbidden' : 'error');
      return;
    }
    setOverview(res.data as Overview);
    setState('ready');
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const { report, evalError } = useMemo((): { report: AuditReport | null; evalError: string } => {
    if (!overview) return { report: null, evalError: '' };
    try {
      return { report: evaluate(overview.cells ?? []), evalError: '' };
    } catch (err) {
      return { report: null, evalError: err instanceof Error ? err.message : 'Could not evaluate the data.' };
    }
  }, [overview]);

  const shell = (children: ReactNode) => (
    <div className="min-h-screen bg-bg-primary">
      <Header />
      <main className="mx-auto max-w-6xl space-y-8 px-6 pb-24 pt-28">{children}</main>
    </div>
  );

  if (state === 'loading') {
    return shell(<div role="status" className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">Loading fairness audit…</div>);
  }
  if (state === 'forbidden' || state === 'error' || !overview || !report) {
    return shell(
      <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 p-6 text-sm text-danger">
        {state === 'forbidden' ? 'Staff access required.' : `Could not load the fairness audit: ${message || evalError || 'unknown error'}`}
        {state !== 'forbidden' && (
          <div className="mt-3"><Button type="button" variant="secondary" onClick={() => void load()}>Try again</Button></div>
        )}
      </div>,
    );
  }

  const s = report.summary;
  const empty = report.dimensions.every((d) => d.total_calls === 0);

  return shell(
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-text-primary">Fairness audit</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            AI reviewer outcomes compared across detected language, region and customer type. A flag is a prompt for human review,
            not a finding of unfairness. Protected attributes are never inferred or used.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-text-secondary" htmlFor="fairness-window">Window</label>
          <select
            id="fairness-window"
            className="rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {WINDOWS.map((w) => <option key={w} value={w}>Last {w} days</option>)}
          </select>
          <Button type="button" variant="secondary" onClick={() => void load()}>
            <RefreshCw size={14} className="me-2" aria-hidden="true" /> Refresh
          </Button>
        </div>
      </div>

      <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Groups evaluated', `${s.groups_evaluated} of ${s.groups_total}`],
          ['Suppressed (too small)', String(s.groups_suppressed)],
          ['Adverse gaps to review', String(s.adverse_gaps)],
          ['Favorable gaps', String(s.favorable_gaps)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="text-sm text-text-secondary">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">{value}</p>
          </div>
        ))}
      </section>
      <p className="text-xs text-text-secondary">
        Minimum {report.options.minReviewed} reviewed calls and {report.options.minAccounts} accounts per group · gap must be at least {report.options.minMeanGap} points / {report.options.minRateGap * 100} pp
        and significant at α {report.options.alpha} (Bonferroni over {report.comparisons_tested} comparisons) · low score = below {overview.low_score_below} · generated {new Date(overview.generated_at).toLocaleString()}
      </p>

      {empty ? (
        <div className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">No calls in this window.</div>
      ) : (
        report.dimensions.map((d) => (
          <section key={d.dimension} aria-label={DIMENSION_TITLE[d.dimension]} className="rounded-2xl border border-border bg-bg-secondary p-5">
            <h2 className="font-semibold text-text-primary">{DIMENSION_TITLE[d.dimension]}</h2>
            <p className="text-xs text-text-secondary">{d.total_calls} calls · {d.total_reviewed} reviewed</p>
            {d.groups.length === 0 ? (
              <p className="mt-3 text-sm text-text-secondary">No data.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="sr-only">{DIMENSION_TITLE[d.dimension]}: each group compared with all other calls</caption>
                  <thead>
                    <tr className="text-start text-xs text-text-secondary">
                      <th scope="col" className="pb-2 pe-3 text-start font-medium">Group</th>
                      <th scope="col" className="pb-2 pe-3 text-start font-medium">Metric</th>
                      <th scope="col" className="pb-2 pe-3 text-start font-medium">Group</th>
                      <th scope="col" className="pb-2 pe-3 text-start font-medium">Rest</th>
                      <th scope="col" className="pb-2 pe-3 text-start font-medium">Gap (CI)</th>
                      <th scope="col" className="pb-2 text-start font-medium">Flag</th>
                    </tr>
                  </thead>
                  <tbody>{d.groups.map((g) => <GroupRows key={g.group} g={g} />)}</tbody>
                </table>
              </div>
            )}
          </section>
        ))
      )}

      <section aria-label="Caveats" className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h2 className="font-semibold text-text-primary">Read this before acting on a flag</h2>
        <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-text-secondary">
          {report.caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <p className="mt-3 text-xs text-text-secondary">Full method and the report template: docs/ai-governance/fairness-audit.md</p>
      </section>
    </>,
  );
}
