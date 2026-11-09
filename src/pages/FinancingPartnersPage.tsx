import { useCallback, useEffect, useMemo, useState } from 'react';
import { Landmark, RefreshCw, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import {
  cancelQuoteOffer, createInsuranceReferral, createQuoteOffer, fetchAuditEvents, fetchDisclosure, fetchFunnelReport,
  fetchGate, fetchInsuranceReferrals, fetchQuoteOffers, fetchSendableQuotes, fetchWorkingCapitalOverview,
  setWorkingCapitalConsent, shareWorkingCapital,
  type AuditEvent, type Disclosure, type Gate, type InsuranceReferral, type QuoteOffer, type SendableQuote, type WcOverview,
} from '@/lib/financingPartnersApi';
import {
  FINANCING_STATUS_VIEW, INSURANCE_LINE_LABEL, INSURANCE_STATUS_VIEW, PARTNER_IS_LENDER_NOTICE, WC_SIGNAL_KEYS, WC_SIGNAL_LABEL,
  canGrantWorkingCapitalConsent, canSubmitInsuranceReferral, computeFunnelRates, effectiveOfferStatus, formatMoney, formatRate,
  gateMessage, isFinancingTerminal, type FunnelReport, type Tone,
} from '@/lib/financingPartners';

type Tab = 'quotes' | 'capital' | 'insurance' | 'audit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'quotes', label: 'Quote financing' }, { id: 'capital', label: 'Working capital' },
  { id: 'insurance', label: 'Insurance' }, { id: 'audit', label: 'Audit trail' },
];
const PARTNER_KEY = 'mock';

const TONE: Record<Tone, string> = {
  neutral: 'bg-bg-secondary text-text-secondary', accent: 'bg-accent/10 text-accent',
  success: 'bg-success-500/10 text-success-500', warning: 'bg-warning-500/10 text-warning-500', danger: 'bg-danger/10 text-danger',
};
const Pill = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[tone]}`}>{children}</span>
);
const dt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function CounselNote({ d }: { d: Disclosure }) {
  if (d.counsel_reviewed) return null;
  return <p className="mt-2 rounded-lg border border-warning-500/30 bg-warning-500/5 px-3 py-2 text-xs text-warning-500" role="note">Placeholder wording — REQUIRES COUNSEL before launch.</p>;
}

export function FinancingPartnersPage() {
  const [tab, setTab] = useState<Tab>('quotes');
  const [gate, setGate] = useState<Gate | null>(null);
  const [gateError, setGateError] = useState(false);
  const { toast } = useToast();
  const { isOwner } = useAuth();

  const loadGate = useCallback(async () => {
    setGateError(false);
    try { setGate(await fetchGate('consumer_financing')); } catch { setGateError(true); }
  }, []);
  useEffect(() => { void loadGate(); }, [loadGate]);

  return (
    <DashboardLayout activeLabel="Partner Financing">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary"><Landmark size={20} aria-hidden="true" /> Partner financing & insurance</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Offer customers financing through a partner, share business signals for working capital only with your consent, and request insurance introductions.
            Vireek does not make credit decisions, lend money or hold funds — the partner does.
          </p>
        </header>

        {gateError ? (
          <EmptyStateError onRetry={loadGate} />
        ) : !gate ? (
          <div aria-busy="true" aria-live="polite"><SkeletonStatGrid count={4} /></div>
        ) : !gate.allowed && gate.reason === 'forbidden' ? (
          <EmptyState variant="no-permission" icon={ShieldCheck} title="You don’t have access" description={gateMessage(gate.reason)} />
        ) : (
          <>
            <nav aria-label="Partner financing sections" className="flex gap-1 overflow-x-auto border-b border-border">
              {TABS.map((t) => (
                <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
                  className={`min-h-[44px] whitespace-nowrap px-4 text-sm font-medium ${tab === t.id ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'}`}>
                  {t.label}
                </button>
              ))}
            </nav>
            {tab === 'quotes' && <QuotesTab gate={gate} toast={toast} />}
            {tab === 'capital' && <CapitalTab isOwner={isOwner} toast={toast} />}
            {tab === 'insurance' && <InsuranceTab toast={toast} />}
            {tab === 'audit' && isOwner && <AuditTab />}
            {tab === 'audit' && !isOwner && <EmptyState variant="no-permission" title="Owner only" description="Only the account owner can read the audit trail." />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

type ToastFn = ReturnType<typeof useToast>['toast'];

function Unavailable({ gate }: { gate: Gate }) {
  return <EmptyState icon={Landmark} title="Not available" description={gateMessage(gate.reason)} />;
}

function QuotesTab({ gate, toast }: { gate: Gate; toast: ToastFn }) {
  const [offers, setOffers] = useState<QuoteOffer[] | null>(null);
  const [quotes, setQuotes] = useState<SendableQuote[]>([]);
  const [report, setReport] = useState<FunnelReport | null>(null);
  const [error, setError] = useState(false);
  const [quoteId, setQuoteId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const to = new Date(); const from = new Date(to.getTime() - 90 * 86_400_000);
      const [o, q, r] = await Promise.all([fetchQuoteOffers(), fetchSendableQuotes(), fetchFunnelReport(from, to)]);
      setOffers(o); setQuotes(q); setReport(r);
    } catch { setError(true); }
  }, []);
  useEffect(() => { if (gate.allowed) void load(); }, [gate.allowed, load]);

  const rates = useMemo(() => (report ? computeFunnelRates(report) : null), [report]);
  const offeredQuoteIds = useMemo(() => new Set((offers ?? []).filter((o) => !isFinancingTerminal(o.status)).map((o) => o.quote_id)), [offers]);

  if (!gate.allowed) return <Unavailable gate={gate} />;
  if (error) return <EmptyStateError onRetry={load} />;
  if (!offers || !report || !rates) return <div aria-busy="true"><SkeletonCardList count={3} /></div>;

  async function create() {
    if (!quoteId) return;
    setBusy('create');
    try { await createQuoteOffer(quoteId); toast('Financing offer attached to the quote.', 'success'); setQuoteId(''); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not create the offer.', 'error'); }
    finally { setBusy(null); }
  }
  async function cancel(id: string) {
    setBusy(id);
    try { await cancelQuoteOffer(id); toast('Offer canceled.', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not cancel.', 'error'); }
    finally { setBusy(null); }
  }

  const stat = (label: string, value: string, sub: string) => (
    <div className="rounded-2xl border border-border bg-bg-secondary/40 p-4">
      <p className="text-xs text-text-secondary">{label}</p><p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p><p className="mt-1 text-[11px] text-text-secondary">{sub}</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <section aria-label="Funnel, last 90 days" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stat('Offer rate', formatRate(rates.offerRate), `${report.totals.offered_quotes} of ${report.quotes_sent} sent quotes`)}
        {stat('Application rate', formatRate(rates.applicationRate), `${report.totals.submitted} of ${report.totals.offers} offers`)}
        {stat('Funded rate', formatRate(rates.fundedRate), `${report.totals.funded} of ${report.totals.offers} offers`)}
        {stat('Funded volume', formatMoney(report.totals.funded_amount_cents), 'Reported by partners')}
      </section>

      <section className="rounded-2xl border border-border p-4">
        <h2 className="text-sm font-semibold text-text-primary">Add financing to a quote</h2>
        <p className="mt-1 text-xs text-text-secondary">{PARTNER_IS_LENDER_NOTICE('The partner')} Customers see the partner’s hosted application, never a credit decision from Vireek.</p>
        {quotes.length === 0 ? (
          <EmptyState compact title="No sent or accepted quotes yet" />
        ) : (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="fin-quote">Quote</label>
            <select id="fin-quote" value={quoteId} onChange={(e) => setQuoteId(e.target.value)} className="min-h-[44px] flex-1 rounded-xl border border-border bg-bg-primary px-3 text-sm">
              <option value="">Choose a quote…</option>
              {quotes.map((q) => (
                <option key={q.id} value={q.id} disabled={offeredQuoteIds.has(q.id)}>
                  {q.customer_name} · {q.status}{offeredQuoteIds.has(q.id) ? ' · offer open' : ''}
                </option>
              ))}
            </select>
            <Button onClick={create} loading={busy === 'create'} disabled={!quoteId} disabledReason="Choose a quote first">Attach offer</Button>
          </div>
        )}
      </section>

      <section aria-label="Offers">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Offers</h2>
          <Button variant="ghost" size="sm" onClick={load} aria-label="Refresh"><RefreshCw size={14} aria-hidden="true" /></Button>
        </div>
        {offers.length === 0 ? (
          <EmptyState icon={Landmark} title="No financing offers yet" description="Attach an offer to a sent quote to get started." />
        ) : (
          <ul className="space-y-2">
            {offers.map((o) => {
              const status = effectiveOfferStatus(o.status, o.expires_at);
              const v = FINANCING_STATUS_VIEW[status];
              return (
                <li key={o.id} className="rounded-2xl border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><p className="font-medium text-text-primary">{formatMoney(o.amount_cents, o.currency)} · {o.partner_name}</p><p className="text-xs text-text-secondary">Created {dt(o.created_at)} · expires {dt(o.expires_at)}</p></div>
                    <Pill tone={v.tone}>{v.label}</Pill>
                  </div>
                  <p className="mt-2 text-xs text-text-secondary">{v.hint}</p>
                  {o.needs_review && <p role="alert" className="mt-2 rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-warning-500">The partner reported activity after this offer was closed. Contact the partner to confirm the status.</p>}
                  {!isFinancingTerminal(status) && (
                    <div className="mt-3"><Button variant="secondary" size="sm" onClick={() => cancel(o.id)} loading={busy === o.id}>Cancel offer</Button></div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function CapitalTab({ isOwner, toast }: { isOwner: boolean; toast: ToastFn }) {
  const [gate, setGate] = useState<Gate | null>(null);
  const [overview, setOverview] = useState<WcOverview | null>(null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [error, setError] = useState(false);
  const [scopes, setScopes] = useState<string[]>(WC_SIGNAL_KEYS);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const g = await fetchGate('working_capital'); setGate(g);
      if (!g.allowed || !isOwner) return;
      const [o, d] = await Promise.all([fetchWorkingCapitalOverview(PARTNER_KEY), fetchDisclosure('working_capital')]);
      setOverview(o); setDisclosure(d);
    } catch { setError(true); }
  }, [isOwner]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <EmptyStateError onRetry={load} />;
  if (!gate) return <div aria-busy="true"><SkeletonCardList count={2} /></div>;
  if (!gate.allowed) return <Unavailable gate={gate} />;
  if (!isOwner) return <EmptyState variant="no-permission" title="Owner only" description="Only the account owner can share business data with a partner." />;
  if (!overview) return <div aria-busy="true"><SkeletonCardList count={2} /></div>;

  const { computed, consent } = overview;
  const check = canGrantWorkingCapitalConsent({ acknowledged: ack, scopes, disclosureLoaded: !!disclosure });

  async function grant() {
    if (!disclosure) return;
    setBusy(true);
    try { await setWorkingCapitalConsent({ partnerKey: PARTNER_KEY, grant: true, scopes, disclosureVersion: disclosure.version }); toast('Consent saved.', 'success'); setAck(false); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save consent.', 'error'); } finally { setBusy(false); }
  }
  async function revoke() {
    if (!disclosure) return;
    setBusy(true);
    try { await setWorkingCapitalConsent({ partnerKey: PARTNER_KEY, grant: false, scopes: [], disclosureVersion: disclosure.version }); toast('Consent revoked. Nothing more will be shared.', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not revoke.', 'error'); } finally { setBusy(false); }
  }
  async function share() {
    setBusy(true);
    try { await shareWorkingCapital(PARTNER_KEY); toast('Shared with the partner.', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not share.', 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border p-4">
        <h2 className="text-sm font-semibold text-text-primary">Signals computed from your Vireek data</h2>
        <p className="mt-1 text-xs text-text-secondary">Informational only — not a credit score, offer or approval. Ranges and rounded figures; no customer or invoice details. Nothing leaves Vireek unless you consent below.</p>
        {computed.data_sufficiency === 'insufficient' ? (
          <EmptyState compact title="Not enough history yet" description="Keep using Vireek for invoices and jobs; signals appear after a few active months." />
        ) : (
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {Object.entries(computed.signals).map(([k, v]) => (
              <div key={k} className="rounded-xl bg-bg-secondary/50 p-3"><dt className="text-xs text-text-secondary">{WC_SIGNAL_LABEL[k] ?? k}</dt><dd className="mt-0.5 font-medium text-text-primary">{String(v)}</dd></div>
            ))}
          </dl>
        )}
      </section>

      <section className="rounded-2xl border border-border p-4">
        <h2 className="text-sm font-semibold text-text-primary">Sharing consent</h2>
        {consent.active ? (
          <div className="mt-2 space-y-3">
            <p className="text-sm text-text-secondary">Active until {consent.expires_at ? dt(consent.expires_at) : '—'}. Sharing: {consent.scopes.map((s) => WC_SIGNAL_LABEL[s] ?? s).join(', ')}.</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={share} loading={busy} disabled={computed.data_sufficiency === 'insufficient'} disabledReason="Not enough history to share yet">Share now with the partner</Button>
              <Button variant="secondary" onClick={revoke} loading={busy}>Revoke consent</Button>
            </div>
            <p className="text-xs text-text-secondary">Revoking stops future sharing; it cannot recall data already sent.</p>
          </div>
        ) : !disclosure ? (
          <EmptyState compact title="Disclosure not published yet" />
        ) : (
          <div className="mt-2 space-y-3">
            <fieldset><legend className="text-xs font-medium text-text-primary">Choose what the partner may receive</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {WC_SIGNAL_KEYS.map((k) => (
                  <label key={k} className="flex min-h-[44px] items-center gap-2 text-sm">
                    <input type="checkbox" checked={scopes.includes(k)} onChange={(e) => setScopes((s) => (e.target.checked ? [...s, k] : s.filter((x) => x !== k)))} className="h-4 w-4" />
                    {WC_SIGNAL_LABEL[k]}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="text-xs leading-relaxed text-text-secondary">{disclosure.body.replaceAll('{partner}', 'the partner')}</p>
            <CounselNote d={disclosure} />
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 h-4 w-4" />I have read this and authorize sharing the items selected above.</label>
            <Button onClick={grant} loading={busy} disabled={!check.ok} disabledReason={check.reason}>Grant consent</Button>
          </div>
        )}
      </section>
    </div>
  );
}

function InsuranceTab({ toast }: { toast: ToastFn }) {
  const [gate, setGate] = useState<Gate | null>(null);
  const [rows, setRows] = useState<InsuranceReferral[] | null>(null);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [error, setError] = useState(false);
  const [line, setLine] = useState('');
  const [ack, setAck] = useState(false);
  const [shareEmail, setShareEmail] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const g = await fetchGate('insurance_referral'); setGate(g);
      if (!g.allowed) return;
      const [r, d] = await Promise.all([fetchInsuranceReferrals(), fetchDisclosure('insurance_referral')]);
      setRows(r); setDisclosure(d);
    } catch { setError(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <EmptyStateError onRetry={load} />;
  if (!gate) return <div aria-busy="true"><SkeletonCardList count={2} /></div>;
  if (!gate.allowed) return <Unavailable gate={gate} />;
  if (!rows) return <div aria-busy="true"><SkeletonCardList count={2} /></div>;

  const check = canSubmitInsuranceReferral({ acknowledged: ack, line, disclosureLoaded: !!disclosure });
  async function submit() {
    if (!disclosure) return;
    setBusy(true);
    try { await createInsuranceReferral({ line, disclosureVersion: disclosure.version, shareEmail, partnerKey: PARTNER_KEY }); toast('Referral sent to the partner.', 'success'); setLine(''); setAck(false); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not send the referral.', 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border p-4">
        <h2 className="text-sm font-semibold text-text-primary">Request an insurance introduction</h2>
        {!disclosure ? <EmptyState compact title="Disclosure not published yet" /> : (
          <div className="mt-3 space-y-3">
            <label className="block text-xs font-medium text-text-primary" htmlFor="ins-line">Coverage</label>
            <select id="ins-line" value={line} onChange={(e) => setLine(e.target.value)} className="min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm sm:w-72">
              <option value="">Choose…</option>
              {Object.entries(INSURANCE_LINE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <p className="text-xs leading-relaxed text-text-secondary">{disclosure.body.replaceAll('{partner}', 'the partner')}</p>
            <CounselNote d={disclosure} />
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={shareEmail} onChange={(e) => setShareEmail(e.target.checked)} className="mt-1 h-4 w-4" />Also share my account email so the partner can contact me (optional).</label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 h-4 w-4" />I have read this disclosure.</label>
            <Button onClick={submit} loading={busy} disabled={!check.ok} disabledReason={check.reason}>Send referral</Button>
          </div>
        )}
      </section>
      <section aria-label="Referrals">
        <h2 className="mb-2 text-sm font-semibold text-text-primary">Your referrals</h2>
        {rows.length === 0 ? <EmptyState compact title="No referrals yet" /> : (
          <ul className="space-y-2">{rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border p-4">
              <div><p className="font-medium text-text-primary">{INSURANCE_LINE_LABEL[r.line] ?? r.line}</p><p className="text-xs text-text-secondary">{dt(r.created_at)} · email {r.contact_shared ? 'shared' : 'not shared'}</p></div>
              <Pill tone={INSURANCE_STATUS_VIEW[r.status].tone}>{INSURANCE_STATUS_VIEW[r.status].label}</Pill>
            </li>))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AuditTab() {
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async () => { setError(false); try { setRows(await fetchAuditEvents()); } catch { setError(true); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (error) return <EmptyStateError onRetry={load} />;
  if (!rows) return <div aria-busy="true"><SkeletonCardList count={4} rows={1} /></div>;
  if (rows.length === 0) return <EmptyState title="No activity yet" description="Offers, consents, shares and referrals are logged here, append-only." />;
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border">
      {rows.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
          <span className="font-mono text-xs text-text-primary">{a.action}</span>
          <span className="text-xs text-text-secondary">{a.actor_kind}{a.from_status || a.to_status ? ` · ${a.from_status ?? '—'} → ${a.to_status ?? '—'}` : ''} · {new Date(a.created_at).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
