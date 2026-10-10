/**
 * Financing Center — /dashboard/financing
 * Applications, eligibility, provider comparison, payment status and analytics
 * on top of the existing financing backend. See src/lib/financingCenter.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, BarChart3, CheckCircle2, Copy, Download, ExternalLink, Landmark, ListChecks,
  Loader2, RefreshCw, Scale, Search, Send, Wallet, X,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  createFinancingOffer,
  FINANCING_STATUS_META,
  formatApr,
  MIN_FINANCING_AMOUNT_CENTS,
  type FinancingConnection,
  type FinancingOffer,
} from '@/lib/financing';
import {
  analyticsByProvider,
  BLOCK_LABELS,
  buildEligibility,
  computeAnalytics,
  describeFinancingError,
  estimateMonthlyCents,
  eventLabel,
  fetchFinancingCenterData,
  fetchOfferEvents,
  filterOffers,
  formatAprShort,
  formatDays,
  formatPct,
  formatUsd,
  offerPaymentView,
  offersToCsv,
  PROVIDER_CATALOG,
  providerName,
  summarizePayments,
  WARNING_LABELS,
  type EligibilityRow,
  type FinancingCenterData,
  type FinancingJob,
  type FinancingOfferEvent,
  type OfferFilter,
  type Tone,
} from '@/lib/financingCenter';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4';
const POLL_MS = 30_000;
const EMPTY: never[] = [];

const TONE: Record<Tone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success-500/15 text-success-500',
  warning: 'bg-warning-500/15 text-warning-500',
  danger: 'bg-danger/15 text-danger',
};

const CONNECTION_META: Record<FinancingConnection['status'], { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'success' },
  pending: { label: 'Pending enrollment', tone: 'warning' },
  error: { label: 'Needs attention', tone: 'danger' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
};

type TabKey = 'overview' | 'applications' | 'eligibility' | 'providers' | 'payments';
const TABS: { key: TabKey; label: string; icon: typeof BarChart3 }[] = [
  { key: 'overview', label: 'Overview', icon: BarChart3 },
  { key: 'applications', label: 'Applications', icon: ListChecks },
  { key: 'eligibility', label: 'Eligibility', icon: CheckCircle2 },
  { key: 'providers', label: 'Providers', icon: Scale },
  { key: 'payments', label: 'Payments', icon: Wallet },
];
const FILTERS: { key: OfferFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'active', label: 'In progress' }, { key: 'approved', label: 'Approved' },
  { key: 'funded', label: 'Funded' }, { key: 'closed', label: 'Closed' },
];

const fmtDate = (s: string | null): string => (s ? new Date(s).toLocaleDateString() : '—');
const fmtDateTime = (s: string): string => new Date(s).toLocaleString();

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${TONE[tone]}`}>{children}</span>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
      {hint && <p className="text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function StatusPill({ offer }: { offer: FinancingOffer }) {
  const meta = FINANCING_STATUS_META[offer.status];
  return <Pill tone={meta.tone}>{meta.label}</Pill>;
}

// ------------------------------------------------------------------ drawer

function OfferDrawer({ offer, job, data, onClose }: { offer: FinancingOffer; job: FinancingJob | null; data: FinancingCenterData; onClose: () => void }) {
  const { toast } = useToast();
  const [events, setEvents] = useState<FinancingOfferEvent[] | null>(null);
  const [eventsFailed, setEventsFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setEventsFailed(false);
    fetchOfferEvents(offer.id)
      .then((e) => { if (!cancelled) setEvents(e); })
      .catch(() => { if (!cancelled) setEventsFailed(true); });
    return () => { cancelled = true; };
  }, [offer.id, offer.status]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const payment = offerPaymentView(offer, data.payments);
  const monthly = estimateMonthlyCents(offer);
  const copyLink = async () => {
    if (!offer.application_url) return;
    try { await navigator.clipboard.writeText(offer.application_url); toast('Application link copied.', 'success'); }
    catch { toast('Could not copy the link.', 'error'); }
  };

  const row = (label: string, value: ReactNode) => (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right font-medium text-text-primary">{value}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-labelledby="fin-drawer-title" onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-bg-primary p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="fin-drawer-title" className="text-base font-semibold text-text-primary">{offer.customer_name}</h2>
            <p className="mt-0.5 text-xs text-text-secondary">{providerName(offer.provider)} · {offer.id.slice(0, 8)}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><X size={16} /></button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2"><StatusPill offer={offer} /><Pill tone={payment.tone}>{payment.label}</Pill></div>
        <p className="mt-2 text-xs text-text-secondary">{payment.hint}</p>

        <div className="mt-4 divide-y divide-border rounded-2xl border border-border bg-bg-secondary px-4">
          {row('Requested', formatUsd(offer.requested_amount_cents, true))}
          {row('Approved', offer.approved_amount_cents === null ? '—' : formatUsd(offer.approved_amount_cents, true))}
          {row('Rate', offer.apr_bps === null ? '—' : formatApr(offer.apr_bps))}
          {row('Term', offer.term_months ? `${offer.term_months} months` : '—')}
          {row('Est. monthly payment', monthly === null ? '—' : formatUsd(monthly, true))}
          {row('Created', fmtDateTime(offer.created_at))}
          {row('Funded', offer.funded_at ? fmtDateTime(offer.funded_at) : '—')}
          {offer.decline_reason && row('Decline reason', offer.decline_reason)}
          {row('Email', offer.customer_email ?? '—')}
          {row('Phone', offer.customer_phone ?? '—')}
        </div>
        <p className="mt-1.5 text-[11px] text-text-secondary">Monthly payment is an estimate; the lender's loan agreement is authoritative.</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {offer.application_url && isActiveOffer(offer) && (
            <>
              <Button size="sm" variant="secondary" onClick={copyLink}><Copy size={14} /> Copy link</Button>
              <a href={offer.application_url} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary"><ExternalLink size={14} /> Open</a>
            </>
          )}
          {job?.customer_id && <Link to={`/dashboard/customers/${job.customer_id}`} className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">Customer</Link>}
          {job && <Link to="/dashboard/jobs" className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">Jobs</Link>}
          {job?.quote_id && <Link to="/dashboard/quotes" className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">Quotes</Link>}
          <Link to="/dashboard/payments" className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary">Payments</Link>
        </div>

        {job && (
          <div className={`${CARD} mt-4 text-sm`}>
            <p className="text-xs text-text-secondary">Linked job</p>
            <p className="font-medium text-text-primary">{job.service_type ?? 'Service'} · {job.customer_name}</p>
            <p className="text-xs text-text-secondary">Invoice {job.invoice_amount ? formatUsd(Math.round(Number(job.invoice_amount) * 100), true) : '—'} · {job.invoice_status.replace('_', ' ')}</p>
          </div>
        )}

        <h3 className="mt-5 text-sm font-semibold text-text-primary">Activity</h3>
        {events === null && !eventsFailed && <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary"><Loader2 size={13} className="animate-spin" /> Loading…</p>}
        {eventsFailed && <p role="alert" className="mt-2 text-xs text-danger">Could not load activity.</p>}
        {events && events.length === 0 && <p className="mt-2 text-xs text-text-secondary">No provider events received yet.</p>}
        {events && events.length > 0 && (
          <ol className="mt-3 space-y-3 border-l border-border pl-4">
            {events.map((ev) => (
              <li key={ev.id} className="relative">
                <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-accent" />
                <p className="text-sm font-medium text-text-primary">{eventLabel(ev.event_type)}</p>
                <p className="text-[11px] text-text-secondary">{fmtDateTime(ev.received_at)}</p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-text-secondary">Raw payload</summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-bg-tertiary p-2 text-[10px] text-text-secondary">{JSON.stringify(ev.raw_payload, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ launch modal

function LaunchModal({ row, onClose, onSent }: { row: EligibilityRow; onClose: () => void; onSent: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState(row.job.customer_phone ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !sending) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, sending]);

  const submit = async () => {
    const e = email.trim();
    const p = phone.trim();
    if (!e && !p) { setError('Add a customer email or phone number.'); return; }
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setError('Enter a valid email address.'); return; }
    setSending(true);
    setError(null);
    try {
      await createFinancingOffer({ job_id: row.job.id, customer_email: e || undefined, customer_phone: p || undefined });
      toast('Financing offer sent.', 'success');
      onSent();
    } catch (err) {
      setError(await describeFinancingError(err));
    } finally {
      setSending(false);
    }
  };

  const input = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !sending && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="fin-launch-title" onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-2xl border border-border bg-bg-primary p-5 shadow-xl">
        <h2 id="fin-launch-title" className="text-base font-semibold text-text-primary">Offer financing</h2>
        <p className="mt-1 text-sm text-text-secondary">{row.job.customer_name} · {formatUsd(row.amountCents, true)}{row.job.service_type ? ` · ${row.job.service_type}` : ''}</p>
        {row.warnings.includes('open_payment_link') && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-500/10 p-3 text-xs text-warning-500"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> A payment link is already open for this job. Make sure the customer isn't asked to pay twice.</p>
        )}
        <div className="mt-4 space-y-3">
          <label className="block text-xs font-medium text-text-secondary">Customer phone
            <input className={`${input} mt-1`} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
          </label>
          <label className="block text-xs font-medium text-text-secondary">Customer email
            <input className={`${input} mt-1`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </label>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <p className="mt-3 text-[11px] text-text-secondary">The customer receives a link to the lender's hosted application (soft credit check). Vireek never holds the loan or funds.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={sending}>{sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send offer</Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page

export function FinancingCenterPage() {
  const { toast } = useToast();
  const [data, setData] = useState<FinancingCenterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKey>('overview');
  const [filter, setFilter] = useState<OfferFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [launchRow, setLaunchRow] = useState<EligibilityRow | null>(null);
  const [showBlocked, setShowBlocked] = useState(false);

  const load = useCallback(async (mode: 'initial' | 'manual' | 'poll') => {
    if (mode === 'manual') setRefreshing(true);
    try {
      setData(await fetchFinancingCenterData());
      setLoadError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load financing data.';
      if (mode === 'initial') setLoadError(msg);
      else if (mode === 'manual') toast(msg, 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { void load('initial'); }, [load]);
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load('poll'); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const offers = useMemo(() => data?.offers ?? EMPTY, [data]);
  const connected = data?.connection?.status === 'connected';
  const analytics = useMemo(() => computeAnalytics(offers), [offers]);
  const byProvider = useMemo(() => analyticsByProvider(offers), [offers]);
  const payments = useMemo(() => summarizePayments(data?.payments ?? EMPTY), [data]);
  const eligibility = useMemo(
    () => (data ? buildEligibility({ jobs: data.jobs, offers: data.offers, payments: data.payments, quotes: data.quotes, connected }) : []),
    [data, connected],
  );
  const jobsById = useMemo(() => new Map((data?.jobs ?? []).map((j) => [j.id, j])), [data]);
  const visibleOffers = useMemo(() => filterOffers(offers, filter, query), [offers, filter, query]);
  const selected = selectedId ? offers.find((o) => o.id === selectedId) ?? null : null;
  const eligibleRows = eligibility.filter((r) => r.eligible);
  const eligibleCents = eligibleRows.reduce((s, r) => s + r.amountCents, 0);

  const exportCsv = () => {
    const blob = new Blob([offersToCsv(visibleOffers)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `financing-applications-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const connMeta = data?.connection ? CONNECTION_META[data.connection.status] : { label: 'Not enrolled', tone: 'neutral' as Tone };
  const providerIds = [...new Set([...Object.keys(PROVIDER_CATALOG), ...Object.keys(byProvider)])];

  return (
    <DashboardLayout activeLabel="Financing Center">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary"><Landmark size={20} /> Financing Center</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Offer customers point-of-sale financing and get paid up front. Track every application from offer to funding, with eligibility drawn from your jobs, quotes and payments.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data && <span className="hidden text-[11px] text-text-secondary sm:inline">Updated {new Date(data.loadedAt).toLocaleTimeString()}</span>}
            <Button size="sm" variant="secondary" onClick={() => void load('manual')} disabled={refreshing} aria-label="Refresh">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </header>

        {loading ? (
          <><SkeletonStatGrid count={6} /><SkeletonCardList count={3} /></>
        ) : loadError || !data ? (
          <EmptyStateError icon={Landmark} title="Couldn't load financing data" description={loadError ?? undefined} onRetry={() => { setLoading(true); void load('initial'); }} />
        ) : (
          <>
            {!connected && (
              <div role="status" className="flex items-start gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" />
                <div>
                  <p className="font-semibold text-text-primary">Financing isn't enabled for your account yet</p>
                  <p className="mt-0.5 text-text-secondary">
                    {data.connection?.last_error ?? 'Complete provider enrollment to start sending offers. Existing applications stay visible below.'}
                  </p>
                </div>
              </div>
            )}

            <nav aria-label="Financing sections" className="flex gap-1 overflow-x-auto rounded-2xl border border-border bg-bg-secondary p-1">
              {TABS.map(({ key, label, icon: Icon }) => (
                <button key={key} type="button" onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}
                  className={`focus-ring inline-flex items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors ${tab === key ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}>
                  <Icon size={14} /> {label}
                  {key === 'eligibility' && eligibleRows.length > 0 && <span className={`rounded-full px-1.5 text-[10px] ${tab === key ? 'bg-white/25' : 'bg-accent/15 text-accent'}`}>{eligibleRows.length}</span>}
                </button>
              ))}
            </nav>

            {tab === 'overview' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
                  <Stat label="Funded volume" value={formatUsd(analytics.fundedCents)} hint={`${analytics.funded} funded`} />
                  <Stat label="In pipeline" value={formatUsd(analytics.pipelineCents)} hint={`${analytics.active} in progress`} />
                  <Stat label="Conversion" value={formatPct(analytics.conversionRate)} hint="Offered → funded" />
                  <Stat label="Approval rate" value={formatPct(analytics.approvalRate)} hint="Of decided applications" />
                  <Stat label="Avg APR" value={formatAprShort(analytics.avgAprBps)} hint="Amount-weighted" />
                  <Stat label="Time to fund" value={formatDays(analytics.avgDaysToFund)} hint="Offer → payout" />
                </div>

                {eligibleRows.length > 0 && (
                  <button type="button" onClick={() => setTab('eligibility')} className="focus-ring flex w-full items-center justify-between gap-3 rounded-2xl border border-accent/30 bg-accent/10 p-4 text-left">
                    <span className="text-sm text-text-primary"><strong>{eligibleRows.length} job{eligibleRows.length === 1 ? '' : 's'}</strong> ({formatUsd(eligibleCents)}) can be offered financing right now.</span>
                    <span className="text-sm font-semibold text-accent">Review →</span>
                  </button>
                )}

                {analytics.total === 0 ? (
                  <EmptyState icon={Landmark} title="No financing offers yet" description="Offer financing on a job of $200 or more and track it here from offer to payout."
                    action={eligibleRows.length ? { label: 'See eligible jobs', onClick: () => setTab('eligibility') } : undefined} />
                ) : (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <section className={CARD} aria-label="Conversion funnel">
                      <h2 className="text-sm font-semibold text-text-primary">Conversion funnel</h2>
                      <ul className="mt-3 space-y-3">
                        {analytics.funnel.map((s) => (
                          <li key={s.key}>
                            <div className="flex justify-between text-xs"><span className="text-text-secondary">{s.label}</span><span className="font-medium text-text-primary">{s.count} · {formatPct(s.pct)}</span></div>
                            <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-tertiary"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(s.pct * 100, s.count > 0 ? 2 : 0)}%` }} /></div>
                          </li>
                        ))}
                      </ul>
                    </section>
                    <section className={CARD} aria-label="Funded volume by month">
                      <h2 className="text-sm font-semibold text-text-primary">Funded volume · last 6 months</h2>
                      <div className="mt-4 flex h-32 items-end gap-2">
                        {(() => {
                          const max = Math.max(...analytics.monthly.map((m) => m.fundedCents), 1);
                          return analytics.monthly.map((m) => (
                            <div key={m.month} className="flex flex-1 flex-col items-center gap-1" title={`${formatUsd(m.fundedCents)} · ${m.count} funded`}>
                              <div className="flex h-24 w-full items-end"><div className="w-full rounded-t-md bg-accent/80" style={{ height: `${(m.fundedCents / max) * 100}%`, minHeight: m.fundedCents > 0 ? 4 : 0 }} /></div>
                              <span className="text-[10px] text-text-secondary">{m.label}</span>
                            </div>
                          ));
                        })()}
                      </div>
                    </section>
                    {analytics.declineReasons.length > 0 && (
                      <section className={`${CARD} lg:col-span-2`} aria-label="Decline reasons">
                        <h2 className="text-sm font-semibold text-text-primary">Top decline reasons</h2>
                        <ul className="mt-2 divide-y divide-border text-sm">
                          {analytics.declineReasons.map((r) => (<li key={r.reason} className="flex justify-between py-2"><span className="text-text-secondary">{r.reason}</span><span className="font-medium text-text-primary">{r.count}</span></li>))}
                        </ul>
                      </section>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === 'applications' && (
              <section className="space-y-3" aria-label="Applications">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter applications">
                    {FILTERS.map((f) => (
                      <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
                        className={`focus-ring rounded-full px-3 py-1.5 text-xs font-semibold ${filter === f.key ? 'bg-accent text-white' : 'border border-border text-text-secondary hover:bg-bg-tertiary'}`}>{f.label}</button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="relative">
                      <span className="sr-only">Search applications</span>
                      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
                      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer, email, phone…" className="focus-ring w-56 rounded-xl border border-border bg-bg-secondary py-2 pl-8 pr-3 text-sm text-text-primary" />
                    </label>
                    <Button size="sm" variant="secondary" onClick={exportCsv} disabled={visibleOffers.length === 0}><Download size={14} /> CSV</Button>
                  </div>
                </div>

                {visibleOffers.length === 0 ? (
                  <EmptyState icon={ListChecks} title={offers.length === 0 ? 'No applications yet' : 'No applications match'} description={offers.length === 0 ? 'Offers you send to customers will appear here.' : 'Try a different filter or search.'} />
                ) : (
                  <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                    <table className="w-full min-w-[720px] text-left text-sm">
                      <thead className="text-[11px] uppercase tracking-wide text-text-secondary">
                        <tr><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Terms</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Created</th></tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {visibleOffers.map((o) => (
                          <tr key={o.id} onClick={() => setSelectedId(o.id)} className="cursor-pointer hover:bg-bg-tertiary/60">
                            <td className="px-4 py-3">
                              <button type="button" className="focus-ring rounded text-left font-medium text-text-primary">{o.customer_name}</button>
                              <p className="text-[11px] text-text-secondary">{providerName(o.provider)}</p>
                            </td>
                            <td className="px-4 py-3 text-text-primary">{formatUsd(o.approved_amount_cents ?? o.requested_amount_cents)}</td>
                            <td className="px-4 py-3 text-text-secondary">{o.apr_bps === null ? '—' : `${formatApr(o.apr_bps)} · ${o.term_months ?? '—'} mo`}</td>
                            <td className="px-4 py-3"><StatusPill offer={o} /></td>
                            <td className="px-4 py-3 text-text-secondary">{fmtDate(o.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {tab === 'eligibility' && (
              <section className="space-y-3" aria-label="Eligibility">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-text-secondary">Jobs with an invoice of {formatUsd(MIN_FINANCING_AMOUNT_CENTS)}+ that are unpaid and have no active offer.</p>
                  <label className="flex items-center gap-2 text-xs text-text-secondary">
                    <input type="checkbox" checked={showBlocked} onChange={(e) => setShowBlocked(e.target.checked)} /> Show ineligible
                  </label>
                </div>
                {(() => {
                  const rows = showBlocked ? eligibility : eligibleRows;
                  if (rows.length === 0) {
                    return <EmptyState icon={CheckCircle2} title="No eligible jobs right now" description="Set an invoice amount on a job to make it eligible for financing." />;
                  }
                  return (
                    <ul className="space-y-2">
                      {rows.slice(0, 100).map((r) => (
                        <li key={r.job.id} className={`${CARD} flex flex-wrap items-center justify-between gap-3`}>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-text-primary">{r.job.customer_name} <span className="font-normal text-text-secondary">· {r.job.service_type ?? 'Service'}</span></p>
                            <p className="text-xs text-text-secondary">
                              {formatUsd(r.amountCents, true)}
                              {r.quoteTotalCents !== null && r.quoteTotalCents !== r.amountCents && ` · accepted quote ${formatUsd(r.quoteTotalCents, true)}`}
                              {r.job.scheduled_datetime && ` · ${fmtDate(r.job.scheduled_datetime)}`}
                            </p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {r.blockers.map((b) => <Pill key={b} tone="neutral">{BLOCK_LABELS[b]}</Pill>)}
                              {r.warnings.map((w) => <Pill key={w} tone="warning">{WARNING_LABELS[w]}</Pill>)}
                            </div>
                          </div>
                          <Button size="sm" disabled={!r.eligible} onClick={() => setLaunchRow(r)}><Send size={14} /> Offer financing</Button>
                        </li>
                      ))}
                    </ul>
                  );
                })()}
              </section>
            )}

            {tab === 'providers' && (
              <section className="space-y-4" aria-label="Providers">
                <div className={`${CARD} flex flex-wrap items-center justify-between gap-3`}>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{providerName(data.connection?.provider ?? 'wisetack')}</p>
                    <p className="text-xs text-text-secondary">{data.connection?.external_merchant_id ? `Merchant ${data.connection.external_merchant_id}` : 'Hosted application flow · soft credit check'}</p>
                  </div>
                  <Pill tone={connMeta.tone}>{connMeta.label}</Pill>
                </div>
                <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="text-[11px] uppercase tracking-wide text-text-secondary">
                      <tr>{['Provider', 'Minimum', 'Offers', 'Approval', 'Conversion', 'Avg APR', 'Avg term', 'Time to fund', 'Funded'].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-border text-text-primary">
                      {providerIds.map((id) => {
                        const a = byProvider[id];
                        return (
                          <tr key={id}>
                            <td className="px-4 py-3 font-medium">{providerName(id)}</td>
                            <td className="px-4 py-3">{PROVIDER_CATALOG[id] ? formatUsd(PROVIDER_CATALOG[id].minAmountCents) : '—'}</td>
                            <td className="px-4 py-3">{a?.total ?? 0}</td>
                            <td className="px-4 py-3">{formatPct(a?.approvalRate ?? null)}</td>
                            <td className="px-4 py-3">{formatPct(a?.conversionRate ?? null)}</td>
                            <td className="px-4 py-3">{formatAprShort(a?.avgAprBps ?? null)}</td>
                            <td className="px-4 py-3">{a?.avgTermMonths ? `${a.avgTermMonths.toFixed(0)} mo` : '—'}</td>
                            <td className="px-4 py-3">{formatDays(a?.avgDaysToFund ?? null)}</td>
                            <td className="px-4 py-3">{formatUsd(a?.fundedCents ?? 0)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-text-secondary">Metrics come from your own applications. Additional lenders appear here automatically once they are enabled for your account.</p>
              </section>
            )}

            {tab === 'payments' && (
              <section className="space-y-4" aria-label="Payments">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat label="Funded via financing" value={formatUsd(analytics.fundedCents)} hint={`${analytics.funded} jobs`} />
                  <Stat label="Awaiting financing" value={formatUsd(analytics.pipelineCents)} hint={`${analytics.active} in progress`} />
                  <Stat label="Collected via payment links" value={formatUsd(payments.paidCents)} />
                  <Stat label="Open payment links" value={formatUsd(payments.openCents)} hint={`${payments.openCount} pending`} />
                </div>
                {offers.length === 0 ? (
                  <EmptyState icon={Wallet} title="No financed payments yet" description="Payment status for financing offers will show here." />
                ) : (
                  <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead className="text-[11px] uppercase tracking-wide text-text-secondary">
                        <tr><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Financing</th><th className="px-4 py-3">Payment</th></tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {offers.slice(0, 200).map((o) => {
                          const pv = offerPaymentView(o, data.payments);
                          return (
                            <tr key={o.id} onClick={() => setSelectedId(o.id)} className="cursor-pointer hover:bg-bg-tertiary/60">
                              <td className="px-4 py-3"><button type="button" className="focus-ring rounded text-left font-medium text-text-primary">{o.customer_name}</button></td>
                              <td className="px-4 py-3 text-text-primary">{formatUsd(o.approved_amount_cents ?? o.requested_amount_cents)}</td>
                              <td className="px-4 py-3"><StatusPill offer={o} /></td>
                              <td className="px-4 py-3" title={pv.hint}><Pill tone={pv.tone}>{pv.label}</Pill></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 text-sm">
                  <Link to="/dashboard/payments" className="focus-ring rounded-xl border border-border px-4 py-2.5 font-semibold text-text-primary hover:bg-bg-tertiary">Payments</Link>
                  <Link to="/dashboard/invoices" className="focus-ring rounded-xl border border-border px-4 py-2.5 font-semibold text-text-primary hover:bg-bg-tertiary">Invoices</Link>
                  <Link to="/dashboard/quotes" className="focus-ring rounded-xl border border-border px-4 py-2.5 font-semibold text-text-primary hover:bg-bg-tertiary">Quotes</Link>
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {data && selected && (
        <OfferDrawer offer={selected} job={selected.job_id ? jobsById.get(selected.job_id) ?? null : null} data={data} onClose={() => setSelectedId(null)} />
      )}
      {launchRow && (
        <LaunchModal row={launchRow} onClose={() => setLaunchRow(null)}
          onSent={() => { setLaunchRow(null); setTab('applications'); void load('manual'); }} />
      )}
    </DashboardLayout>
  );
}
