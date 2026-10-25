/**
 * Results (Value Scoreboard) — /dashboard/results
 *
 * What Vireek delivered this month, with every number traceable to a record in the account.
 * Measured (backed by a paid invoice) and estimated (your assumptions) are always shown apart.
 * Owners can edit assumptions and mark items "not due to Vireek"; billing-enabled team members can read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, ChevronLeft, ChevronRight, Download, Info, Loader2, Save, Send, TrendingUp, Undo2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { commonTimeZones } from '@/lib/executiveReport';
import {
  STATEMENT_STATUS_LABEL,
  TYPE_LABELS,
  currentMonthWindow,
  defaultSettingsDraft,
  downloadBoardPdf,
  evidencePath,
  featureLabel,
  fetchSettings,
  fetchStatements,
  formatHours,
  formatMoney,
  formatMultiple,
  formatShare,
  hasAnyEvents,
  importHistory,
  loadScoreboard,
  methodology,
  monthLabel,
  resolveTimezone,
  reviewEvent,
  rowToDraft,
  saveSettings,
  sendSummaryNow,
  shiftMonth,
  validateSettings,
  type Scoreboard,
  type ValueEvent,
  type ValueSettingsDraft,
  type ValueSettingsRow,
  type ValueStatementRecord,
} from '@/lib/valueScoreboard';
import { costLine } from '../../supabase/functions/_shared/value-scoreboard/render';

const selectClass =
  'w-full rounded-xl border border-border bg-bg-secondary px-4 py-3 text-base text-text-primary focus-visible:border-accent focus-visible:outline-none';
const PAGE_SIZE = 40;

type Filter = 'all' | 'measured' | 'estimated' | 'excluded';
interface OwnerInfo { plan: string | null; currency: string; company: string }

const amountText = (e: ValueEvent) => (e.unit === 'minutes' ? formatHours(e.amount) : formatMoney(e.amount, e.currency ?? 'USD'));

function Badge({ confidence }: { confidence: ValueEvent['confidence'] | 'excluded' }) {
  const style =
    confidence === 'measured' ? 'bg-success-500/10 text-success-500'
      : confidence === 'estimated' ? 'bg-warning-500/10 text-warning-500'
        : 'bg-bg-tertiary text-text-secondary';
  const label = confidence === 'measured' ? 'Measured' : confidence === 'estimated' ? 'Estimated' : 'Not due to Vireek';
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>{label}</span>;
}

function SplitBar({ measured, estimated }: { measured: number; estimated: number }) {
  const total = measured + estimated;
  const m = total > 0 ? (measured / total) * 100 : 0;
  return (
    <div
      className="flex h-3 w-full overflow-hidden rounded-full bg-bg-tertiary"
      role="img"
      aria-label={total > 0 ? `${Math.round(m)}% measured, ${Math.round(100 - m)}% estimated` : 'No value recorded yet'}
    >
      <div className="bg-success-500" style={{ width: `${m}%` }} />
      <div className="bg-warning-500" style={{ width: `${total > 0 ? 100 - m : 0}%` }} />
    </div>
  );
}

function TrendChart({ board }: { board: Scoreboard }) {
  const max = Math.max(1, ...board.trend.map((t) => t.totalCents));
  return (
    <div className="flex h-44 items-end gap-3" role="group" aria-label="Monthly value trend">
      {board.trend.map((t) => {
        const current = t.month === board.window.month;
        return (
          <div key={t.month} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[11px] text-text-secondary">{t.totalCents > 0 ? formatMoney(t.totalCents, board.currency).replace(/\.00$/, '') : '—'}</span>
            <div
              className={`flex w-full max-w-[56px] flex-col justify-end overflow-hidden rounded-t-md ${current ? 'ring-2 ring-accent/40' : ''}`}
              style={{ height: `${Math.max(2, (t.totalCents / max) * 100)}%` }}
              title={`${t.label}: ${formatMoney(t.measuredCents, board.currency)} measured, ${formatMoney(t.estimatedCents, board.currency)} estimated`}
            >
              <div className="bg-warning-500" style={{ flexGrow: t.estimatedCents }} />
              <div className="bg-success-500" style={{ flexGrow: t.measuredCents }} />
            </div>
            <span className={`text-[11px] ${current ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>{t.label.slice(0, 3)}</span>
          </div>
        );
      })}
    </div>
  );
}

function EventDrawer({
  event, excluded, canReview, busy, assumptions, onClose, onReview,
}: {
  event: ValueEvent;
  excluded: boolean;
  canReview: boolean;
  busy: boolean;
  assumptions: string;
  onClose: () => void;
  onReview: (decision: 'not_due_to_vireek' | 'restored', note: string) => void;
}) {
  const [note, setNote] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const link = evidencePath(event.evidence_ref);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="vs-drawer-title"
        className="h-full w-full max-w-md overflow-y-auto bg-bg-secondary p-6 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="vs-drawer-title" className="text-lg font-semibold text-text-primary">How this was calculated</h2>
            <p className="mt-1 text-sm text-text-secondary">{featureLabel(event.source_feature)} · {TYPE_LABELS[event.type]}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary">
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <span className="text-3xl font-bold text-text-primary">{amountText(event)}</span>
          <Badge confidence={excluded ? 'excluded' : event.confidence} />
        </div>
        <p className="mt-1 text-xs text-text-secondary">{new Date(event.occurred_at).toLocaleString()}</p>

        <h3 className="mt-6 text-sm font-semibold text-text-primary">Method</h3>
        <p className="mt-1 text-sm leading-relaxed text-text-secondary">{event.method_note}</p>
        {event.confidence === 'estimated' && assumptions && (
          <p className="mt-2 rounded-xl bg-bg-tertiary p-3 text-xs text-text-secondary">
            Your current assumptions: {assumptions}. This estimate keeps the assumptions it was created with; changes apply to new events only.
          </p>
        )}

        <h3 className="mt-6 text-sm font-semibold text-text-primary">Evidence</h3>
        <p className="mt-1 break-all font-mono text-xs text-text-secondary">{event.evidence_ref}</p>
        {link ? (
          <Link to={link} className="mt-2 inline-block text-sm font-medium text-accent hover:underline">Open the underlying record →</Link>
        ) : (
          <p className="mt-2 text-xs text-text-secondary">This item has no linkable record (for example demo or manually entered data).</p>
        )}
        {event.supersedes_ref && (
          <p className="mt-3 text-xs text-text-secondary">Replaces the earlier estimate <span className="font-mono">{event.supersedes_ref}</span>, so it is not counted twice.</p>
        )}

        {canReview && (
          <div className="mt-8 border-t border-border pt-5">
            {excluded ? (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onReview('restored', '')}>
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Undo2 size={16} />} Count this again
              </Button>
            ) : (
              <>
                <Textarea id="vs-note" label="Why was this not due to Vireek? (optional)" value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} />
                <Button variant="secondary" size="sm" className="mt-3" disabled={busy} onClick={() => onReview('not_due_to_vireek', note)}>
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Ban size={16} />} Not due to Vireek
                </Button>
                <p className="mt-2 text-xs text-text-secondary">It leaves your totals immediately. The decision is kept in an audit trail and can be undone.</p>
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

export function ValueScoreboardPage() {
  const { profile, teamMember, isOwner, profileLoading } = useAuth();
  const { toast } = useToast();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [importing, setImporting] = useState(false);
  const [tz, setTz] = useState('America/New_York');
  const [month, setMonth] = useState<string | null>(null);
  const [board, setBoard] = useState<Scoreboard | null>(null);
  const [owner, setOwner] = useState<OwnerInfo>({ plan: null, currency: 'USD', company: '' });
  const [settingsRow, setSettingsRow] = useState<ValueSettingsRow | null>(null);
  const [draft, setDraft] = useState<ValueSettingsDraft>(defaultSettingsDraft());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const [statements, setStatements] = useState<ValueStatementRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<{ event: ValueEvent; excluded: boolean } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const importTried = useRef(false);
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  const load = useCallback(async (wanted?: string) => {
    if (!ownerId) return;
    setLoading(true);
    setError(false);
    try {
      const settings = await fetchSettings(ownerId);
      const zone = await resolveTimezone(ownerId, settings);
      let info: OwnerInfo = { plan: profile?.plan ?? null, currency: ((profile as { invoice_currency?: string | null } | null)?.invoice_currency || 'USD').toUpperCase(), company: profile?.company_name ?? '' };
      if (!isOwner) {
        const { data } = await supabase.from('profiles').select('plan,invoice_currency,company_name').eq('id', ownerId).maybeSingle();
        const row = data as { plan: string | null; invoice_currency: string | null; company_name: string | null } | null;
        info = row
          ? { plan: row.plan, currency: (row.invoice_currency || 'USD').toUpperCase(), company: row.company_name ?? '' }
          : { plan: null, currency: info.currency, company: '' };
      }

      if (isOwner && !importTried.current) {
        importTried.current = true;
        if (!(await hasAnyEvents(ownerId))) {
          setImporting(true);
          try { await importHistory(90); } catch { /* the page still works; the owner can retry from the empty state */ }
          setImporting(false);
        }
      }

      const m = wanted ?? currentMonthWindow(new Date(), zone).month;
      const b = await loadScoreboard({
        ownerId, month: m, timezone: zone, currency: info.currency, plan: info.plan,
        subscriptionOverrideCents: settings?.subscription_cents_override ?? null,
      });
      setTz(zone);
      setMonth(m);
      setOwner(info);
      setSettingsRow(settings);
      setDraft(settings ? rowToDraft(settings) : defaultSettingsDraft());
      setBoard(b);
      setShown(PAGE_SIZE);
      void fetchStatements(ownerId).then(setStatements).catch(() => setStatements([]));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId, isOwner, profile]);

  useEffect(() => { if (!profileLoading && ownerId) void load(); }, [profileLoading, ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentMonth = useMemo(() => currentMonthWindow(new Date(), tz).month, [tz]);
  const goMonth = (delta: number) => { if (month) void load(shiftMonth(month, delta)); };

  const rows = useMemo(() => {
    if (!board) return [] as { event: ValueEvent; excluded: boolean }[];
    const eff = board.events.map((event) => ({ event, excluded: false }));
    const exc = board.excludedEvents.map((event) => ({ event, excluded: true }));
    if (filter === 'excluded') return exc;
    if (filter === 'measured') return eff.filter((r) => r.event.confidence === 'measured');
    if (filter === 'estimated') return eff.filter((r) => r.event.confidence === 'estimated');
    return [...eff, ...exc].sort((a, b) => Date.parse(b.event.occurred_at) - Date.parse(a.event.occurred_at));
  }, [board, filter]);

  const assumptionsText = settingsRow
    ? `average ticket ${settingsRow.avg_ticket_cents ? formatMoney(settingsRow.avg_ticket_cents, owner.currency) : 'from your business profile'}, close rate ${settingsRow.close_rate_bp / 100}%, ${settingsRow.minutes_per_handled_call} minutes per handled call`
    : 'defaults (3 minutes per handled call, 25% close rate, average job value from your business profile)';

  const onReview = async (decision: 'not_due_to_vireek' | 'restored', note: string) => {
    if (!ownerId || !selected) return;
    setReviewing(true);
    try {
      await reviewEvent(ownerId, selected.event.id, decision, note);
      toast(decision === 'restored' ? 'Counted again.' : 'Removed from your results.', 'success');
      setSelected(null);
      if (month) await load(month);
    } catch {
      toast('Could not save that decision. Try again.', 'error');
    } finally {
      setReviewing(false);
    }
  };

  const onSaveSettings = async () => {
    if (!ownerId) return;
    const errs = validateSettings(draft);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSavingSettings(true);
    try {
      await saveSettings(ownerId, draft);
      toast('Settings saved.', 'success');
      if (month) await load(month);
    } catch {
      toast('Could not save settings. Try again.', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const onSend = async () => {
    if (!month) return;
    setSending(true);
    try {
      const r = await sendSummaryNow(month);
      toast(r.ok ? 'Summary sent.' : 'Could not deliver the summary. Check the recipients.', r.ok ? 'success' : 'error');
      if (ownerId) void fetchStatements(ownerId).then(setStatements).catch(() => undefined);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the summary.', 'error');
    } finally {
      setSending(false);
    }
  };

  const onPdf = async (b: Scoreboard) => {
    try { await downloadBoardPdf(b, owner.company || 'Your business'); } catch { toast('Could not build the PDF.', 'error'); }
  };

  const set = <K extends keyof ValueSettingsDraft>(k: K, v: ValueSettingsDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  if (profileLoading || (loading && !board)) {
    return (
      <DashboardLayout activeLabel="Results">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          {importing && <p className="mb-4 flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" /> Importing your last 90 days…</p>}
          <SkeletonCardList count={3} />
        </div>
      </DashboardLayout>
    );
  }

  const b = board;
  const isEmpty = !!b && b.counts.measured + b.counts.estimated + b.excludedEvents.length === 0 && b.trend.every((t) => t.totalCents === 0 && t.totalMinutes === 0);

  return (
    <DashboardLayout activeLabel="Results">
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-text-primary">Results</h1>
            <p className="max-w-2xl text-sm text-text-secondary">
              What Vireek delivered for your business. Every figure links to the record behind it, and verified (measured) value is never mixed with estimates.
            </p>
          </div>
          {month && (
            <div className="flex items-center gap-2" role="group" aria-label="Choose month">
              <Button variant="secondary" size="sm" aria-label="Previous month" onClick={() => goMonth(-1)} disabled={loading}><ChevronLeft size={16} /></Button>
              <span className="min-w-[9rem] text-center text-sm font-semibold text-text-primary">{monthLabel(month)}</span>
              <Button variant="secondary" size="sm" aria-label="Next month" onClick={() => goMonth(1)} disabled={loading || month >= currentMonth}><ChevronRight size={16} /></Button>
            </div>
          )}
        </header>

        {error || !b ? (
          <EmptyState icon={TrendingUp} title="Couldn't load your results" description="Check your connection and try again. If you're a team member, you need billing access to view this page." action={{ label: 'Retry', onClick: () => void load(month ?? undefined) }} />
        ) : (
          <>
            {isEmpty && (
              <EmptyState
                icon={TrendingUp}
                title="No value recorded for this period yet"
                description="Results appear automatically as Vireek answers calls after hours, recovers missed opportunities and saves your team time."
                action={isOwner ? { label: 'Import last 90 days', onClick: () => { setImporting(true); void importHistory(90).then((n) => { toast(n > 0 ? `Imported ${n} items.` : 'Nothing new to import.', 'info'); return load(month ?? undefined); }).catch(() => toast('Could not import history.', 'error')).finally(() => setImporting(false)); } } : undefined}
              />
            )}

            <section aria-labelledby="vs-hero" className="grid gap-4 md:grid-cols-3">
              <Card className="md:col-span-2">
                <h2 id="vs-hero" className="text-sm font-medium text-text-secondary">Verified revenue · {b.window.label}</h2>
                <p className="mt-2 text-4xl font-bold text-success-500">{formatMoney(b.money.measuredCents, b.currency)}</p>
                <p className="mt-1 text-sm text-text-secondary">Backed by paid invoices in your account ({b.counts.measured} {b.counts.measured === 1 ? 'item' : 'items'}).</p>
                <div className="mt-5"><SplitBar measured={b.money.measuredCents} estimated={b.money.estimatedCents} /></div>
                <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-text-secondary">
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-success-500" />Measured {formatMoney(b.money.measuredCents, b.currency)}</span>
                  <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-warning-500" />Estimated {formatMoney(b.money.estimatedCents, b.currency)} (kept separate)</span>
                </p>
              </Card>
              <Card>
                <h2 className="text-sm font-medium text-text-secondary">Time saved (estimated)</h2>
                <p className="mt-2 text-4xl font-bold text-text-primary">{formatHours(b.hours.totalMinutes)}</p>
                <p className="mt-1 text-sm text-text-secondary">Staff time freed by calls Vireek handled. Shown on its own, never converted to dollars.</p>
              </Card>
            </section>

            <section aria-labelledby="vs-cost">
              <Card>
                <h2 id="vs-cost" className="text-lg font-semibold text-text-primary">Value vs. subscription cost</h2>
                <p className="mt-2 text-sm text-text-secondary">{costLine(b)}</p>
                {b.cost.multiple !== null && b.cost.netCents !== null && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl bg-bg-tertiary p-4"><p className="text-xs text-text-secondary">Verified only</p><p className="text-xl font-bold text-text-primary">{formatMultiple(b.cost.measuredMultiple)}</p></div>
                    <div className="rounded-xl bg-bg-tertiary p-4"><p className="text-xs text-text-secondary">Including estimates</p><p className="text-xl font-bold text-text-primary">{formatMultiple(b.cost.multiple)}</p></div>
                    <div className="rounded-xl bg-bg-tertiary p-4"><p className="text-xs text-text-secondary">Net of subscription</p><p className="text-xl font-bold text-text-primary">{formatMoney(b.cost.netCents, b.currency)}</p></div>
                  </div>
                )}
              </Card>
            </section>

            <section aria-labelledby="vs-trend" className="grid gap-4 lg:grid-cols-2">
              <Card>
                <h2 id="vs-trend" className="mb-4 text-lg font-semibold text-text-primary">Trend</h2>
                <TrendChart board={b} />
              </Card>
              <Card>
                <h2 className="mb-4 text-lg font-semibold text-text-primary">By feature</h2>
                {b.byFeature.length === 0 ? (
                  <p className="text-sm text-text-secondary">Nothing recorded this month.</p>
                ) : (
                  <ul className="space-y-4">
                    {b.byFeature.map((r) => (
                      <li key={r.feature}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="font-medium text-text-primary">{r.label}</span>
                          <span className="text-text-secondary">{r.totalCents > 0 ? formatShare(r.shareBp) : formatHours(r.measuredMinutes + r.estimatedMinutes)}</span>
                        </div>
                        {r.totalCents > 0 && <div className="mt-1.5"><SplitBar measured={r.measuredCents} estimated={r.estimatedCents} /></div>}
                        <p className="mt-1 text-xs text-text-secondary">
                          {formatMoney(r.measuredCents, b.currency)} measured · {formatMoney(r.estimatedCents, b.currency)} estimated
                          {r.measuredMinutes + r.estimatedMinutes > 0 && r.totalCents > 0 ? ` · ${formatHours(r.measuredMinutes + r.estimatedMinutes)} saved` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {b.otherCurrencies.length > 0 && (
                  <p className="mt-4 text-xs text-text-secondary">
                    Also recorded in other currencies (never added to the totals): {b.otherCurrencies.map((o) => formatMoney(o.measuredCents + o.estimatedCents, o.currency)).join(', ')}.
                  </p>
                )}
              </Card>
            </section>

            <section aria-labelledby="vs-items">
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="vs-items" className="text-lg font-semibold text-text-primary">Every item behind these numbers</h2>
                  <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter items">
                    {(['all', 'measured', 'estimated', 'excluded'] as Filter[]).map((f) => (
                      <button
                        key={f}
                        role="tab"
                        aria-selected={filter === f}
                        onClick={() => { setFilter(f); setShown(PAGE_SIZE); }}
                        className={`rounded-full px-3 py-1 text-xs font-medium ${filter === f ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                      >
                        {f === 'all' ? 'All' : f === 'measured' ? 'Measured' : f === 'estimated' ? 'Estimated' : `Not due to Vireek (${b.excludedEvents.length})`}
                      </button>
                    ))}
                  </div>
                </div>
                {b.counts.duplicates + b.counts.superseded > 0 && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary"><Info size={14} /> {b.counts.duplicates} duplicate and {b.counts.superseded} superseded items were ignored so nothing is counted twice.</p>
                )}
                {rows.length === 0 ? (
                  <p className="mt-6 text-sm text-text-secondary">No items in this view.</p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-left text-sm">
                      <thead className="text-xs text-text-secondary">
                        <tr><th className="py-2 pr-3 font-medium">Date</th><th className="py-2 pr-3 font-medium">Feature</th><th className="py-2 pr-3 font-medium">Type</th><th className="py-2 pr-3 text-right font-medium">Amount</th><th className="py-2 pr-3 font-medium">Basis</th><th className="py-2" /></tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, shown).map(({ event, excluded }) => (
                          <tr key={event.id} className="border-t border-border/70">
                            <td className="whitespace-nowrap py-2.5 pr-3 text-text-secondary">{new Date(event.occurred_at).toLocaleDateString(undefined, { timeZone: tz, month: 'short', day: 'numeric' })}</td>
                            <td className="py-2.5 pr-3 text-text-primary">{featureLabel(event.source_feature)}</td>
                            <td className="py-2.5 pr-3 text-text-secondary">{TYPE_LABELS[event.type]}</td>
                            <td className={`whitespace-nowrap py-2.5 pr-3 text-right font-semibold ${excluded ? 'text-text-secondary line-through' : 'text-text-primary'}`}>{amountText(event)}</td>
                            <td className="py-2.5 pr-3"><Badge confidence={excluded ? 'excluded' : event.confidence} /></td>
                            <td className="py-2.5 text-right"><button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setSelected({ event, excluded })}>How calculated</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > shown && <div className="mt-3 text-center"><Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>Show more ({rows.length - shown} left)</Button></div>}
                    {b.eventsTruncated && <p className="mt-2 text-xs text-text-secondary">Totals above include every item; this list is capped for size.</p>}
                  </div>
                )}
              </Card>
            </section>

            <section aria-labelledby="vs-method">
              <Card>
                <h2 id="vs-method" className="mb-3 text-lg font-semibold text-text-primary">How we count</h2>
                <dl className="grid gap-4 sm:grid-cols-2">
                  {methodology.map((m) => (<div key={m.title}><dt className="text-sm font-semibold text-text-primary">{m.title}</dt><dd className="mt-1 text-sm leading-relaxed text-text-secondary">{m.body}</dd></div>))}
                </dl>
              </Card>
            </section>

            <section aria-labelledby="vs-statements">
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="vs-statements" className="text-lg font-semibold text-text-primary">Monthly summary</h2>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void onPdf(b)}><Download size={16} /> Download PDF</Button>
                    {isOwner && <Button size="sm" onClick={() => void onSend()} disabled={sending}>{sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} Email {monthLabel(b.window.month)}</Button>}
                  </div>
                </div>
                {statements.length === 0 ? (
                  <p className="mt-4 text-sm text-text-secondary">Your first summary is generated at the start of next month once monthly email is on, or you can email one now.</p>
                ) : (
                  <ul className="mt-4 divide-y divide-border/70">
                    {statements.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                        <div><p className="font-medium text-text-primary">{s.period_label}</p><p className="text-xs text-text-secondary">{formatMoney(s.measured_cents, s.currency)} measured · {formatMoney(s.estimated_cents, s.currency)} estimated · {formatHours(s.saved_minutes)}</p></div>
                        <div className="flex items-center gap-3">
                          <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">{STATEMENT_STATUS_LABEL[s.status]}</span>
                          <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => void onPdf(s.snapshot)}>PDF</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>

            {isOwner && (
              <section aria-labelledby="vs-settings">
                <Card>
                  <h2 id="vs-settings" className="text-lg font-semibold text-text-primary">Results settings</h2>
                  <p className="mt-1 text-sm text-text-secondary">These assumptions only affect <strong>estimates</strong>, and only new events. Measured value always uses the real invoice.</p>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <Input id="vs-avg" label="Average ticket" value={draft.avgTicket} placeholder="Blank = average job value from your business profile" inputMode="decimal" error={errors.avgTicket} onChange={(e) => set('avgTicket', e.target.value)} />
                    <Input id="vs-close" label="Close rate (%)" value={draft.closeRate} inputMode="decimal" error={errors.closeRate} helperText="Share of booked after-hours calls that end up paid." onChange={(e) => set('closeRate', e.target.value)} />
                    <Input id="vs-min" label="Minutes saved per handled call" value={draft.minutesPerCall} inputMode="numeric" error={errors.minutesPerCall} helperText="Only calls of 20 seconds or more count." onChange={(e) => set('minutesPerCall', e.target.value)} />
                    <Input id="vs-sub" label="Monthly subscription cost" value={draft.subscriptionOverride} placeholder="Blank = your plan's list price" inputMode="decimal" error={errors.subscriptionOverride} helperText={`In ${owner.currency}. Use for annual, discounted or custom plans.`} onChange={(e) => set('subscriptionOverride', e.target.value)} />
                    <div>
                      <label htmlFor="vs-tz" className="mb-1.5 block text-sm font-medium text-text-primary">Time zone for months</label>
                      <select id="vs-tz" className={selectClass} value={draft.timezone} onChange={(e) => set('timezone', e.target.value)}>
                        <option value="">Automatic ({tz})</option>
                        {commonTimeZones(browserZone).map((z) => <option key={z} value={z}>{z}</option>)}
                      </select>
                      {errors.timezone && <p className="mt-1 text-xs text-danger">{errors.timezone}</p>}
                    </div>
                    <Input id="vs-hour" label="Send monthly email at (hour, 0–23)" value={draft.sendHour} inputMode="numeric" error={errors.sendHour} onChange={(e) => set('sendHour', e.target.value)} />
                  </div>
                  <div className="mt-4"><Input id="vs-rcpt" label="Extra email recipients" value={draft.extraRecipients} placeholder="partner@example.com, bookkeeper@example.com" error={errors.extraRecipients} helperText="You always receive it too." onChange={(e) => set('extraRecipients', e.target.value)} /></div>
                  <div className="mt-5 space-y-3">
                    <Toggle id="vs-email" checked={draft.emailEnabled} onChange={(v) => set('emailEnabled', v)} label="Email me this summary on the 1st of every month" hint="Includes a PDF. Sent in your time zone." />
                    <Toggle id="vs-consent" checked={draft.caseStudyConsent} onChange={(v) => set('caseStudyConsent', v)} label="Allow Vireek to use my results in case studies" hint="Off by default. Vireek staff otherwise only ever see anonymized totals across many accounts." />
                  </div>
                  <Button className="mt-6" onClick={() => void onSaveSettings()} disabled={savingSettings}>{savingSettings ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save settings</Button>
                </Card>
              </section>
            )}
          </>
        )}
      </div>

      {selected && (
        <EventDrawer
          event={selected.event}
          excluded={selected.excluded}
          canReview={isOwner}
          busy={reviewing}
          assumptions={assumptionsText}
          onClose={() => setSelected(null)}
          onReview={(d, n) => void onReview(d, n)}
        />
      )}
    </DashboardLayout>
  );
}
