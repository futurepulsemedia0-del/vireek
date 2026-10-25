import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { HealthBadge } from '@/components/staff/HealthBadge';
import { RiskBadge } from '@/components/staff/RiskBadge';
import { getStaffSuccessOverview } from '@/lib/successToolsApi';
import {
  RISK_LABELS,
  averageAdoption,
  buildStaffSuccessRows,
  type RiskLevel,
  type StaffSuccessData,
  type SuccessAccountInput,
} from '@/lib/successTools';

type Filter = 'attention' | RiskLevel | 'all';
const FILTERS: [Filter, string][] = [
  ['attention', 'Needs attention'],
  ['high', 'High risk'],
  ['medium', 'Medium risk'],
  ['low', 'Low risk'],
  ['new', 'New'],
  ['all', 'All'],
];
const PAGE = 50;

interface AtRiskAccountsPanelProps {
  accounts: SuccessAccountInput[];
  onOpen: (accountId: string) => void;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4 hover:translate-y-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </Card>
  );
}

/** Staff view of accounts most likely to churn: the staff health score, layered with feature adoption and NPS. */
export function AtRiskAccountsPanel({ accounts, onOpen }: AtRiskAccountsPanelProps) {
  const [data, setData] = useState<StaffSuccessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>('attention');
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(false);
    try {
      setData(await getStaffSuccessOverview({ force }));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (data ? buildStaffSuccessRows(accounts, data) : []), [accounts, data]);
  const counts = useMemo(() => {
    const c: Record<RiskLevel, number> = { high: 0, medium: 0, low: 0, new: 0, churned: 0 };
    rows.forEach((r) => c[r.risk.level]++);
    return c;
  }, [rows]);
  const shown = useMemo(
    () => rows.filter((r) => (filter === 'all' ? true : filter === 'attention' ? r.risk.level === 'high' || r.risk.level === 'medium' : r.risk.level === filter)),
    [rows, filter],
  );

  if (loading && !data) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="space-y-2 p-4 hover:translate-y-0"><Skeleton className="h-4 w-56" /><Skeleton className="h-3 w-40" /></Card>
        ))}
      </div>
    );
  }
  if (error || !data) {
    return <EmptyState icon={AlertTriangle} title="Couldn’t load at-risk accounts" description="You may have lost staff access, or the connection dropped. Nothing was changed." action={{ label: 'Retry', onClick: () => void load(true) }} />;
  }

  const avg = averageAdoption(rows);
  const nps = data.nps;
  const unmeasured = data.catalog.filter((f) => !f.measured).length;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="High risk" value={String(counts.high)} hint={`${counts.medium} medium`} />
        <Kpi label="Avg feature adoption" value={avg === null ? '—' : `${avg}%`} hint="Excludes new and churned accounts" />
        <Kpi label={`NPS (${nps.days}d)`} value={nps.score === null ? '—' : String(nps.score)} hint={`${nps.responses} response${nps.responses === 1 ? '' : 's'} · ${nps.detractors} detractor${nps.detractors === 1 ? '' : 's'}`} />
        <Kpi label="Accounts scored" value={String(rows.length - counts.churned)} hint={`${counts.churned} churned excluded`} />
      </div>
      {unmeasured > 0 && (
        <p role="status" className="rounded-xl bg-warning-500/10 p-3 text-xs text-text-primary">
          {unmeasured} tracked feature{unmeasured === 1 ? ' is' : 's are'} not measurable on this database and {unmeasured === 1 ? 'is' : 'are'} left out of every adoption score.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by risk">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => { setFilter(id); setLimit(PAGE); }}
            className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium ${filter === id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
          >
            {label} · {id === 'all' ? rows.length : id === 'attention' ? counts.high + counts.medium : counts[id]}
          </button>
        ))}
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => void load(true)} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </Button>
      </div>

      {shown.length === 0 ? (
        <EmptyState icon={ShieldCheck} title={filter === 'attention' ? 'No accounts need attention' : `No ${filter === 'all' ? '' : RISK_LABELS[filter as RiskLevel].toLowerCase() + ' '}accounts`} description="Scores refresh every time you open this view." />
      ) : (
        <>
          <ul className="space-y-2">
            {shown.slice(0, limit).map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onOpen(r.id)} className="focus-ring w-full rounded-2xl border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-text-secondary">
                  <span className="flex flex-wrap items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-text-primary">{r.label}</span>
                      <span className="block truncate text-xs text-text-secondary">{r.email} · <span className="capitalize">{r.plan}</span></span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <RiskBadge level={r.risk.level} score={r.risk.score} />
                      <HealthBadge band={r.health.band} score={r.health.score} />
                    </span>
                  </span>
                  <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary">
                    <span>Adoption: {r.adoption.score === null ? 'n/a' : `${r.adoption.score}%`}</span>
                    <span>NPS: {r.nps ? `${r.nps.score}/10` : 'no response'}</span>
                  </span>
                  {r.risk.reasons.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-text-primary">
                      {r.risk.reasons.slice(0, 3).map((x, i) => <li key={i}>{x.text}</li>)}
                    </ul>
                  )}
                  {(r.risk.level === 'high' || r.risk.level === 'medium') && <span className="mt-2 block text-xs font-medium text-accent">Next: {r.risk.action}</span>}
                </button>
              </li>
            ))}
          </ul>
          {shown.length > limit && (
            <div className="text-center">
              <Button type="button" size="sm" variant="secondary" onClick={() => setLimit((l) => l + PAGE)}>Show more ({shown.length - limit} left)</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
