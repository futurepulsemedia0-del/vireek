// Home Demand Exchange — detected, qualified service demand, ranked against
// your technicians and routed into the systems you already use (Leads,
// Quotes, Jobs, Dispatch, Capacity Exchange, Labor Marketplace).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightLeft,
  Check,
  CircleAlert,
  ChevronDown,
  Loader2,
  Lock,
  Radar,
  RefreshCw,
  Sparkles,
  Store,
  X,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { describeAssignResult } from '@/lib/technicianCapacity';
import { TRADE_CATEGORY_LABELS, TRADE_CATEGORY_OPTIONS } from '@/lib/laborMarketplace';
import { describeNetworkError } from '@/lib/contractorNetwork';
import {
  OPEN_STATUSES,
  ROUTE_LABELS,
  SOURCE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  URGENCY_COLORS,
  URGENCY_LABELS,
  DEMAND_SOURCES,
  summarizeDemand,
  type DemandSource,
  type DemandUrgency,
} from '@/lib/homeDemandExchange';
import {
  convertOpportunity,
  defaultDurationMinutes,
  describeDemandError,
  dismissOpportunity,
  fetchOpportunities,
  getOwnerId,
  matchOpportunity,
  postToCapacityExchange,
  reopenOpportunity,
  scanDemand,
  type DemandOpportunity,
  type MatchResult,
} from '@/lib/homeDemandExchangeApi';

const selectClass =
  'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary transition-colors focus-visible:border-accent';

const DISMISS_REASONS = ['Not a fit', 'Already handled', 'Customer declined', 'Bad data'] as const;

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const formatWindow = (a: string, b: string): string => {
  const f = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${f(a)} – ${f(b)}`;
};

/** Value for <input type="datetime-local"> in local time, tomorrow 09:00. */
const defaultSlot = (): string => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Match panel
// ---------------------------------------------------------------------------

function MatchPanel({
  result,
  selectedTech,
  onSelectTech,
}: {
  result: MatchResult;
  selectedTech: string | null;
  onSelectTech: (id: string) => void;
}) {
  const { matches, recommendation } = result;
  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
          {ROUTE_LABELS[recommendation.route]}
        </span>
        <p className="text-sm text-text-secondary">{recommendation.reason}</p>
      </div>
      {matches.length === 0 ? (
        <p className="text-sm text-text-secondary">No technicians on your team yet.</p>
      ) : (
        <ul className="space-y-3">
          {matches.slice(0, 3).map((m, i) => (
            <li key={m.technician_id} className={`rounded-lg border p-3 ${selectedTech === m.technician_id ? 'border-accent' : 'border-border'}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    #{i + 1} {m.name}
                  </p>
                  {m.blockers.length > 0 && <p className="text-xs text-danger">{m.blockers.join(' · ')}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-lg font-bold text-text-primary">{m.score}</span>
                  <Button size="sm" variant={selectedTech === m.technician_id ? 'primary' : 'secondary'} disabled={!m.eligible} onClick={() => onSelectTech(m.technician_id)}>
                    {selectedTech === m.technician_id ? 'Selected' : 'Select'}
                  </Button>
                </div>
              </div>
              <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {m.factors.map((f) => (
                  <div key={f.key} title={f.detail}>
                    <div className="flex justify-between text-xs text-text-secondary">
                      <dt>
                        {f.label} · {f.weight}
                      </dt>
                      <dd>{Math.round(f.score * 100)}%</dd>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" role="presentation">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(f.score * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </dl>
              {m.est_margin_pct !== null && (
                <p className="mt-2 text-xs text-text-secondary">Estimated margin with this technician: ~{Math.round(m.est_margin_pct)}%</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opportunity card
// ---------------------------------------------------------------------------

function OpportunityCard({ opp, onChanged }: { opp: DemandOpportunity; onChanged: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [tech, setTech] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [slot, setSlot] = useState(defaultSlot);
  const [dismissing, setDismissing] = useState(false);

  const isOpen = OPEN_STATUSES.includes(opp.status);
  const isProperty = opp.scope === 'property';

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(key === 'exchange' ? describeNetworkError(e) : describeDemandError(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const rank = () =>
    run('match', async () => {
      const res = await matchOpportunity(opp);
      setMatch(res);
      setTech(res.matches.find((m) => m.eligible)?.technician_id ?? null);
      setOpen(true);
      onChanged();
    });

  const convert = (kind: 'lead' | 'quote' | 'job') =>
    run(kind, async () => {
      if (kind === 'job' && !slot) {
        toast('Pick a date and time first.', 'error');
        return;
      }
      const res = await convertOpportunity(opp, {
        createQuote: kind === 'quote',
        createJob: kind === 'job',
        scheduledAt: kind === 'job' ? new Date(slot).toISOString() : null,
        durationMinutes: defaultDurationMinutes(opp.est_value_cents),
        technicianId: kind === 'job' ? tech : null,
      });
      if (res.assignment) {
        const { message, ok } = describeAssignResult(res.assignment);
        toast(`Job created. ${message}`, ok ? 'success' : 'error');
      } else if (res.assignmentError) {
        toast('Job created, but it could not be assigned. Assign it from the Dispatch Board.', 'error');
      } else {
        toast(kind === 'lead' ? 'Lead created.' : kind === 'quote' ? 'Lead and draft quote created.' : 'Job scheduled.', 'success');
      }
      setScheduling(false);
      onChanged();
    });

  const exchange = () =>
    run('exchange', async () => {
      const { offered } = await postToCapacityExchange(opp);
      toast(
        offered > 0 ? 'Posted. The first offer went to the best-matched partner.' : 'Posted, but no partner qualifies right now. It stays in the open handoff feed.',
        'success',
      );
      onChanged();
    });

  const dismiss = (reason: string) =>
    run('dismiss', async () => {
      await dismissOpportunity(opp.id, reason);
      setDismissing(false);
      onChanged();
    });

  const reopen = () =>
    run('reopen', async () => {
      await reopenOpportunity(opp.id);
      onChanged();
    });

  const failedGates = opp.qualification.filter((g) => !g.passed);

  return (
    <article className="rounded-xl border border-border bg-bg-secondary p-5" aria-label={opp.title}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${URGENCY_COLORS[opp.urgency]}`}>{URGENCY_LABELS[opp.urgency]}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[opp.status]}`}>{STATUS_LABELS[opp.status]}</span>
            <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary">{SOURCE_LABELS[opp.source_kind]}</span>
            <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary">{TRADE_CATEGORY_LABELS[opp.trade_category]}</span>
            {!isProperty && <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary">Market signal</span>}
          </div>
          <h3 className="text-base font-semibold text-text-primary">{opp.title}</h3>
          {opp.summary && <p className="text-sm text-text-secondary">{opp.summary}</p>}
          <p className="text-xs text-text-secondary">
            {isProperty ? `Est. ${usd(opp.est_value_cents)}` : opp.est_value_cents > 0 ? `Modeled exposure ${usd(opp.est_value_cents)}` : 'Capacity planning signal'}
            {opp.est_margin_pct !== null && ` · ~${Math.round(opp.est_margin_pct)}% margin`} · Window {formatWindow(opp.window_start, opp.window_end)}
          </p>
        </div>
        <div className="shrink-0 text-center" aria-label={`Demand score ${opp.demand_score} out of 100`}>
          <p className="text-2xl font-bold text-text-primary">{opp.demand_score}</p>
          <p className="text-xs text-text-secondary">score</p>
        </div>
      </div>

      {opp.best_match && isOpen && !match && (
        <p className="mt-3 text-xs text-text-secondary">
          Last match: {ROUTE_LABELS[opp.best_match.route]}
          {opp.best_match.technician_name ? ` · ${opp.best_match.technician_name} (${opp.best_match.score}/100)` : ''}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {isOpen && (
          <>
            <Button size="sm" variant="secondary" onClick={() => void rank()} disabled={busy !== null}>
              {busy === 'match' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Rank best fit
            </Button>
            {isProperty && (
              <>
                <Button size="sm" variant="secondary" onClick={() => void convert('lead')} disabled={busy !== null}>
                  {busy === 'lead' && <Loader2 size={14} className="animate-spin" />} Create lead
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void convert('quote')} disabled={busy !== null}>
                  {busy === 'quote' && <Loader2 size={14} className="animate-spin" />} Lead + draft quote
                </Button>
                <Button size="sm" variant="primary" onClick={() => setScheduling((v) => !v)} disabled={busy !== null}>
                  Schedule job
                </Button>
              </>
            )}
            <Button size="sm" variant="secondary" onClick={() => void exchange()} disabled={busy !== null || !!opp.handoff_id}>
              {busy === 'exchange' ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}{' '}
              {opp.handoff_id ? 'On Capacity Exchange' : 'Offer to Capacity Exchange'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissing((v) => !v)} disabled={busy !== null}>
              <X size={14} /> Dismiss
            </Button>
          </>
        )}
        {opp.status === 'dismissed' && (
          <Button size="sm" variant="secondary" onClick={() => void reopen()} disabled={busy !== null}>
            {busy === 'reopen' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Reopen
          </Button>
        )}
        {opp.status === 'converted' && (
          <>
            {opp.lead_id && <Link className="focus-ring rounded text-sm text-accent hover:underline" to="/dashboard/leads">Open Leads</Link>}
            {opp.quote_id && <Link className="focus-ring rounded text-sm text-accent hover:underline" to="/dashboard/quotes">Open Quotes</Link>}
            {opp.job_id && <Link className="focus-ring rounded text-sm text-accent hover:underline" to="/dashboard/jobs">Open Jobs</Link>}
          </>
        )}
        {opp.handoff_id && (
          <Link className="focus-ring rounded text-sm text-accent hover:underline" to="/dashboard/network/capacity-exchange">
            View on Capacity Exchange
          </Link>
        )}
        {match?.recommendation.route === 'marketplace' && (
          <Link className="focus-ring inline-flex items-center gap-1 rounded text-sm text-accent hover:underline" to="/dashboard/labor-marketplace">
            <Store size={14} /> Labor Marketplace
          </Link>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="focus-ring ml-auto inline-flex items-center gap-1 rounded text-sm text-text-secondary hover:text-text-primary"
        >
          Why this matters <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {scheduling && isOpen && isProperty && (
        <div className="mt-3 space-y-3 rounded-xl border border-border bg-bg-primary p-4">
          <Input label="Date and time" type="datetime-local" value={slot} onChange={(e) => setSlot(e.target.value)} />
          <p className="text-xs text-text-secondary">
            {tech && match ? `Will be assigned to ${match.matches.find((m) => m.technician_id === tech)?.name ?? 'the selected technician'} through Dispatch.` : 'Rank best fit first to assign a technician now, or assign later from the Dispatch Board.'}
          </p>
          <Button size="sm" variant="primary" onClick={() => void convert('job')} disabled={busy !== null || !slot}>
            {busy === 'job' && <Loader2 size={14} className="animate-spin" />} Create job
          </Button>
        </div>
      )}

      {dismissing && (
        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Dismiss reason">
          {DISMISS_REASONS.map((r) => (
            <Button key={r} size="sm" variant="secondary" onClick={() => void dismiss(r)} disabled={busy !== null}>
              {r}
            </Button>
          ))}
        </div>
      )}

      {match && isOpen && (
        <div className="mt-3">
          <MatchPanel result={match} selectedTech={tech} onSelectTech={setTech} />
        </div>
      )}

      {open && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Evidence</h4>
            <ul className="space-y-1 text-sm text-text-primary">
              {opp.evidence.map((e, i) => (
                <li key={`${e.label}-${i}`}>
                  <span className="font-medium">{e.label}:</span> <span className="text-text-secondary">{e.detail}</span>
                </li>
              ))}
              <li>
                <span className="font-medium">Confidence:</span> <span className="text-text-secondary">{Math.round(opp.confidence * 100)}%</span>
              </li>
            </ul>
          </div>
          {isProperty && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Qualification</h4>
              <ul className="space-y-1 text-sm">
                {opp.qualification.map((g) => (
                  <li key={g.key} className="flex items-start gap-2">
                    {g.passed ? <Check size={14} className="mt-0.5 shrink-0 text-success-500" /> : <CircleAlert size={14} className="mt-0.5 shrink-0 text-warning-500" />}
                    <span className="text-text-secondary">
                      <span className="font-medium text-text-primary">{g.label}.</span> {g.detail}
                    </span>
                  </li>
                ))}
              </ul>
              {failedGates.length > 0 && isOpen && <p className="mt-2 text-xs text-text-secondary">Not qualified yet — you can still act on it manually.</p>}
            </div>
          )}
        </div>
      )}
      {opp.dismissed_reason && opp.status === 'dismissed' && <p className="mt-2 text-xs text-text-secondary">Dismissed: {opp.dismissed_reason}</p>}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type StatusTab = 'open' | 'converted' | 'dismissed';

export function HomeDemandExchangePage() {
  const { permissions } = useAuth();
  const { toast } = useToast();
  const canView = !!permissions?.can_view_billing;

  const [rows, setRows] = useState<DemandOpportunity[]>([]);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState<StatusTab>('open');
  const [trade, setTrade] = useState('all');
  const [urgency, setUrgency] = useState<'all' | DemandUrgency>('all');
  const [source, setSource] = useState<'all' | DemandSource>('all');
  const loadedOnce = useRef(false);
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchOpportunities();
      setRows(data);
      setLoadFailed(false);
      loadedOnce.current = true;
    } catch {
      if (!loadedOnce.current) setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    void refresh();
    getOwnerId().then(setOwnerId).catch(() => undefined);
    return () => window.clearTimeout(refreshTimer.current);
  }, [canView, refresh]);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 400);
  }, [refresh]);

  const realtime = useRealtimeSubscription({
    channelName: 'home-demand-opportunities',
    table: 'home_demand_opportunities',
    event: '*',
    filter: ownerId ? `user_id=eq.${ownerId}` : undefined,
    onChange: scheduleRefresh,
    enabled: !!ownerId && canView,
  });

  const runScan = async () => {
    setScanning(true);
    try {
      const r = await scanDemand();
      const parts = [`${r.created} new`, `${r.updated} refreshed`];
      if (r.expired > 0) parts.push(`${r.expired} expired`);
      toast(`Scan complete: ${parts.join(', ')}.`, 'success');
      if (r.unavailableSources.length > 0) {
        toast(`Some sources could not be read and were skipped: ${r.unavailableSources.map((s) => SOURCE_LABELS[s as DemandSource] ?? s).join(', ')}.`, 'error');
      }
      await refresh();
    } catch (e) {
      toast(describeDemandError(e), 'error');
    } finally {
      setScanning(false);
    }
  };

  const summary = useMemo(() => summarizeDemand(rows), [rows]);

  const visible = useMemo(() => {
    return rows
      .filter((r) => {
        if (tab === 'open') return OPEN_STATUSES.includes(r.status);
        if (tab === 'converted') return r.status === 'converted';
        return r.status === 'dismissed' || r.status === 'expired';
      })
      .filter((r) => (trade === 'all' ? true : r.trade_category === trade))
      .filter((r) => (urgency === 'all' ? true : r.urgency === urgency))
      .filter((r) => (source === 'all' ? true : r.source_kind === source))
      .sort((a, b) => b.demand_score - a.demand_score);
  }, [rows, tab, trade, urgency, source]);

  const tabs: { key: StatusTab; label: string }[] = [
    { key: 'open', label: `Open (${summary.open})` },
    { key: 'converted', label: 'Converted' },
    { key: 'dismissed', label: 'Dismissed / expired' },
  ];

  return (
    <DashboardLayout activeLabel="Home Demand Exchange">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold text-text-primary sm:text-2xl">
              <Radar size={22} className="text-accent" /> Home Demand Exchange
              {canView && <LiveIndicator status={realtime} />}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Vireek reads equipment health, predicted failures, weather, warranties, permits, rebates and market events, qualifies the real
              demand, ranks the best technician, and hands it to Leads, Quotes, Jobs, Dispatch or Capacity Exchange.
            </p>
          </div>
          {canView && (
            <Button variant="primary" onClick={() => void runScan()} disabled={scanning}>
              {scanning ? <Loader2 size={16} className="animate-spin" /> : <Radar size={16} />} {scanning ? 'Scanning…' : 'Scan for demand'}
            </Button>
          )}
        </div>

        {!canView && (
          <EmptyState icon={Lock} title="Billing access required" description="This page shows pipeline value and margin, so it follows your billing permission. Ask an account owner for access." />
        )}

        {canView && loading && !loadedOnce.current && <SkeletonCardList count={3} />}

        {canView && loadFailed && !loadedOnce.current && (
          <EmptyState icon={CircleAlert} title="Couldn't load demand" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void refresh() }} />
        )}

        {canView && loadedOnce.current && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Open opportunities" value={String(summary.open)} hint={`${summary.qualified} qualified`} />
              <StatCard label="Pipeline (est.)" value={usd(summary.pipelineCents)} hint="Property opportunities only" />
              <StatCard label="Expected margin (est.)" value={usd(summary.expectedMarginCents)} />
              <StatCard label="Converted this month" value={String(summary.convertedThisMonth)} />
            </div>

            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Status">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={`focus-ring rounded-full border px-3 py-1.5 text-sm transition-colors ${tab === t.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent/40'}`}
                >
                  {t.label}
                </button>
              ))}
              <div className="ml-auto flex flex-wrap gap-2">
                <select aria-label="Filter by source" className={selectClass} value={source} onChange={(e) => setSource(e.target.value as 'all' | DemandSource)}>
                  <option value="all">All sources</option>
                  {DEMAND_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABELS[s]}
                      {summary.bySource[s] > 0 ? ` (${summary.bySource[s]})` : ''}
                    </option>
                  ))}
                </select>
                <select aria-label="Filter by trade" className={selectClass} value={trade} onChange={(e) => setTrade(e.target.value)}>
                  <option value="all">All trades</option>
                  {TRADE_CATEGORY_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {TRADE_CATEGORY_LABELS[t]}
                    </option>
                  ))}
                </select>
                <select aria-label="Filter by urgency" className={selectClass} value={urgency} onChange={(e) => setUrgency(e.target.value as 'all' | DemandUrgency)}>
                  <option value="all">Any urgency</option>
                  {(Object.keys(URGENCY_LABELS) as DemandUrgency[]).map((u) => (
                    <option key={u} value={u}>
                      {URGENCY_LABELS[u]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyState
                icon={Radar}
                title={rows.length === 0 ? 'No demand detected yet' : 'Nothing matches these filters'}
                description={
                  rows.length === 0
                    ? 'Run your first scan. Vireek will check equipment, predictions, weather, warranties, permits and rebates for work worth pursuing.'
                    : 'Try a different tab or clear a filter.'
                }
                action={rows.length === 0 ? { label: 'Scan for demand', onClick: () => void runScan() } : undefined}
              />
            ) : (
              <div className="space-y-3">
                {visible.map((o) => (
                  <OpportunityCard key={o.id} opp={o} onChanged={() => void refresh()} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
