/**
 * /dashboard/sales/present/:id — full-screen, tablet-first presentation for the customer.
 *
 * Deliberately outside DashboardLayout: the customer is looking at this screen, so no
 * internal navigation, margins or commission data appear here. Everything is read from
 * one RPC (get_sales_presentation) because quotes are owner-only under RLS.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, CircleDollarSign, Home, Layers, Loader2, Scale, XCircle } from 'lucide-react';
import { EmptyStateError } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LadderView, type PaymentMode } from '@/components/sales/LadderView';
import { RepairReplacePanel } from '@/components/sales/RepairReplacePanel';
import { HomeHistoryPanel } from '@/components/sales/HomeHistoryPanel';
import { CloseSaleSheet } from '@/components/sales/CloseSaleSheet';
import { useToast } from '@/contexts/ToastContext';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { dollarsToCents } from '@/lib/commissionEngine';
import {
  buildLadder,
  defaultDepositCents,
  defaultSelectedOptionId,
  describeTerm,
  monthlyForTerm,
  money,
  moneyExact,
  resolvePaymentTerms,
  salesErrorMessage,
  validateDeposit,
  type PresentationPayload,
} from '@/lib/inHomeSales';
import { closeSalesLost, getSalesPresentation, markSalesPresented, signJobPhotoUrls } from '@/lib/inHomeSalesApi';

type Tab = 'options' | 'compare' | 'home';

function LostDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onCancel);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Not today">
      <div ref={ref} className="w-full max-w-md rounded-t-3xl border border-border bg-bg-primary p-6 sm:rounded-3xl">
        <h2 className="text-lg font-bold text-text-primary">Not buying today?</h2>
        <p className="mb-4 text-sm text-text-secondary">A quick note helps the team follow up and learn.</p>
        <Input label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wants a second quote, price, timing" maxLength={500} />
        <div className="mt-5 flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>Keep presenting</Button>
          <Button className="flex-1" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(reason); } finally { setBusy(false); } }}>
            {busy ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : null} Mark as lost
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SalesPresentationPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [payload, setPayload] = useState<PresentationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('options');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<PaymentMode>('total');
  const [termMonths, setTermMonths] = useState<number | null>(null);
  const [depositText, setDepositText] = useState<string | null>(null); // null = follow the default
  const [signedUrls, setSignedUrls] = useState<Map<string, string>>(new Map());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const presentedMarked = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const p = await getSalesPresentation(id);
      setPayload(p);
      setSelectedId((cur) => cur ?? p.presentation.selected_option_id ?? defaultSelectedOptionId(buildLadder(p.quote.options, p.quote.tax_percent)));
    } catch (e) {
      setError(salesErrorMessage(e, 'Could not load this presentation.'));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!payload || presentedMarked.current || payload.presentation.status !== 'draft') return;
    presentedMarked.current = true;
    void markSalesPresented(payload.presentation.id).catch(() => { presentedMarked.current = false; });
  }, [payload]);

  useEffect(() => {
    const paths = payload?.job_photos.map((p) => p.storage_path) ?? [];
    if (paths.length === 0) return;
    let cancelled = false;
    void signJobPhotoUrls(paths).then((m) => { if (!cancelled) setSignedUrls(m); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [payload?.job_photos]);

  const ladder = useMemo(() => (payload ? buildLadder(payload.quote.options, payload.quote.tax_percent) : []), [payload]);
  const terms = useMemo(() => resolvePaymentTerms(payload?.financing.terms ?? []), [payload?.financing.terms]);
  const term = terms.find((t) => t.term_months === termMonths) ?? terms[Math.floor((terms.length - 1) / 2)];
  const entry = ladder.find((l) => l.option.id === selectedId) ?? null;

  const defaultDeposit = entry && payload ? defaultDepositCents(entry.totalCents, payload.quote.deposit_percent) : 0;
  const parsedDeposit = depositText === null ? defaultDeposit : dollarsToCents(depositText);
  const depositError = entry && parsedDeposit !== null ? validateDeposit(parsedDeposit, entry.totalCents) : depositText !== null ? 'Enter a valid deposit.' : null;
  const depositCents = parsedDeposit !== null && !depositError ? parsedDeposit : 0;

  if (error) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <EmptyStateError icon={XCircle} title="Presentation unavailable" description={error} onRetry={() => void load()} />
        <Link to="/dashboard/sales" className="focus-ring mt-4 inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary"><ArrowLeft size={16} /> Back to appointments</Link>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6" aria-busy="true" aria-label="Loading presentation">
        <div className="h-10 w-72 animate-pulse rounded-xl bg-bg-tertiary" />
        <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="h-72 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
      </div>
    );
  }

  const sp = payload.presentation;
  const closed = sp.status === 'sold' || sp.status === 'lost';
  const monthly = entry && mode === 'monthly' ? monthlyForTerm(entry.totalCents, depositCents, term) : null;
  const tabs: { id: Tab; label: string; icon: typeof Layers }[] = [
    { id: 'options', label: 'Your options', icon: Layers },
    { id: 'compare', label: 'Repair vs replace', icon: Scale },
    { id: 'home', label: 'Your home', icon: Home },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary pb-28">
      <header className="sticky top-0 z-30 border-b border-border bg-bg-primary/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-bold text-text-primary">Prepared for {payload.quote.customer_name}</p>
            {payload.job.address && <p className="truncate text-sm text-text-secondary">{payload.job.address}</p>}
          </div>
          <Link to="/dashboard/sales" className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">
            <ArrowLeft size={16} aria-hidden="true" /> Exit
          </Link>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2" aria-label="Presentation sections">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
              className={`focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-semibold ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary'}`}>
              <t.icon size={16} aria-hidden="true" /> {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6">
        {sp.status === 'sold' && (
          <div role="status" className="flex items-center gap-3 rounded-2xl border border-success-500/30 bg-success-500/10 p-4 text-success-500">
            <CheckCircle2 size={20} aria-hidden="true" />
            <span className="text-sm font-semibold">Sold — {moneyExact(sp.sold_total_cents ?? 0)}. Thank you!</span>
          </div>
        )}
        {sp.status === 'lost' && (
          <div role="status" className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">This presentation was closed without a sale{sp.lost_reason ? `: ${sp.lost_reason}` : '.'}</div>
        )}
        {payload.quote.presentation_note && tab === 'options' && (
          <p className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-primary">{payload.quote.presentation_note}</p>
        )}

        {tab === 'options' && (
          <>
            {ladder.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">This estimate has no options yet.</p>
            ) : (
              <>
                <section aria-label="Payment display" className="flex flex-wrap items-end gap-4 rounded-2xl border border-border bg-bg-secondary p-4">
                  <div role="radiogroup" aria-label="Show prices as" className="flex gap-1 rounded-xl border border-border bg-bg-tertiary p-1">
                    {([['total', 'Total price'], ['monthly', 'Monthly payment']] as const).map(([m, label]) => (
                      <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                        className={`focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-lg px-4 text-sm font-semibold ${mode === m ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary'}`}>
                        {m === 'monthly' && <CircleDollarSign size={16} aria-hidden="true" />} {label}
                      </button>
                    ))}
                  </div>
                  {mode === 'monthly' && (
                    <label className="text-sm text-text-secondary">
                      Term
                      <select className="focus-ring mt-1 block min-h-[44px] rounded-xl border border-border bg-bg-primary px-3 text-base text-text-primary" value={term.term_months} onChange={(e) => setTermMonths(Number(e.target.value))}>
                        {terms.map((t) => <option key={t.term_months} value={t.term_months}>{describeTerm(t)}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="w-40">
                    <Input label="Deposit today ($)" inputMode="decimal" disabled={closed} value={depositText ?? (defaultDeposit / 100).toFixed(2)} onChange={(e) => setDepositText(e.target.value)} error={depositError ?? undefined} />
                  </div>
                  {mode === 'monthly' && (
                    <p className="basis-full text-xs text-text-secondary">
                      {term.source === 'lender' ? 'Based on terms recently approved for our customers.' : 'Indicative estimate only.'} Final approval and terms are set by the lender.
                    </p>
                  )}
                </section>
                <LadderView ladder={ladder} selectedId={selectedId} onSelect={setSelectedId} mode={mode} term={term} depositCents={depositCents} locked={closed} />
              </>
            )}
          </>
        )}
        {tab === 'compare' && <RepairReplacePanel ladder={ladder} equipment={payload.equipment} onChoose={(optionId) => { setSelectedId(optionId); setTab('options'); toast('Option selected.', 'info'); }} />}
        {tab === 'home' && <HomeHistoryPanel equipment={payload.equipment} history={payload.history} estimatePhotos={payload.quote.photos} jobPhotos={payload.job_photos} signedUrls={signedUrls} />}
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg-primary/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-text-secondary">{entry ? entry.option.name : 'Choose an option'}</p>
            <p className="text-xl font-bold text-text-primary">
              {entry ? (monthly !== null ? `${moneyExact(monthly)}/mo` : money(entry.totalCents)) : '—'}
              {entry && depositCents > 0 && <span className="ml-2 text-sm font-medium text-text-secondary">{money(depositCents)} deposit</span>}
            </p>
          </div>
          <div className="flex gap-3">
            {sp.status === 'sold' ? (
              <Button onClick={() => setSheetOpen(true)}>Deposit & next steps</Button>
            ) : sp.status === 'lost' ? (
              <Button variant="secondary" onClick={() => navigate('/dashboard/sales')}>Back to appointments</Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setLostOpen(true)}>Not today</Button>
                <Button disabled={!entry || Boolean(depositError)} onClick={() => setSheetOpen(true)}>Choose this option</Button>
              </>
            )}
          </div>
        </div>
      </div>

      {ladder.length > 0 && (entry || sp.status === 'sold') && (
        <CloseSaleSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          payload={payload}
          entry={(sp.status === 'sold' ? ladder.find((l) => l.option.id === sp.selected_option_id) : null) ?? entry ?? ladder[0]}
          depositCents={sp.status === 'sold' ? sp.deposit_due_cents : depositCents}
          termMonths={sp.status === 'sold' ? sp.financing_term_months : mode === 'monthly' ? term.term_months : null}
          onChanged={load}
        />
      )}
      {lostOpen && (
        <LostDialog
          onCancel={() => setLostOpen(false)}
          onConfirm={async (reason) => {
            try {
              await closeSalesLost(sp.id, reason);
              setLostOpen(false);
              await load();
            } catch (e) {
              toast(salesErrorMessage(e), 'error');
            }
          }}
        />
      )}
    </div>
  );
}
