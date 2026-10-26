import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, CalendarClock, Download, Link2, Lock, Mail, Pause, Play, Plus, RefreshCw, ScrollText, Search, Send, Trash2, Unlink, X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  AGING_LABELS, PERIOD_MODE_LABELS, SCOPE_LABELS, WEEKDAYS, MAX_SELECTED_CUSTOMERS, SENDS_PAGE_SIZE,
  agingRows, defaultTimezone, deleteSchedule, describeSchedule, draftFromSchedule, emptyDraft, errMsg, fetchAccounts, fetchCustomerNames,
  fetchSchedules, fetchSends, fetchStatement, filterAccounts, fmtDate, fmtDateTime, isoToday, periodForPreset, runScheduleNow, saveSchedule,
  searchCustomers, sendStatementNow, setBillTo, setScheduleActive, statementFileName, statementToCsv, statusTone, summarizeAccounts,
  timezoneOptions, usd, validatePeriod, validateScheduleDraft,
  type AccountFilter, type PeriodPreset, type ScheduleDraft, type Statement, type StatementAccount, type StatementSchedule, type StatementSend,
} from '@/lib/statements';

type Tab = 'accounts' | 'schedules' | 'history';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>{children}</span>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="!p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text-primary sm:text-2xl">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </Card>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>
      {children}
      {error && <span role="alert" className="mt-1.5 block text-xs text-danger">{error}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Modal shell (bottom sheet on mobile, centered / side panel on larger screens)
// ---------------------------------------------------------------------------

function Sheet({ title, subtitle, onClose, wide = false, footer, children }: {
  title: string; subtitle?: string; onClose: () => void; wide?: boolean; footer?: ReactNode; children: ReactNode;
}) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <>
      <div className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="stmt-sheet-title"
        className={`fixed inset-x-0 bottom-0 top-10 z-[131] flex flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-primary shadow-xl sm:inset-y-6 sm:mx-auto sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id="stmt-sheet-title" className="truncate text-lg font-semibold text-text-primary">{title}</h2>
            {subtitle && <p className="truncate text-xs text-text-secondary">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -mr-1 rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer && <div className="border-t border-border bg-bg-secondary/60 px-4 py-3 sm:px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Linked accounts (consolidated billing)
// ---------------------------------------------------------------------------

function LinkedAccountsDialog({ payerId, payerName, members, onClose, onChanged }: {
  payerId: string; payerName: string; members: Array<{ id: string; name: string }>; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchCustomers>>>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const children = members.filter((m) => m.id !== payerId);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    const id = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      searchCustomers(q)
        .then((r) => { if (id === seq.current) setResults(r); })
        .catch((e) => { if (id === seq.current) toast(errMsg(e), 'error'); })
        .finally(() => { if (id === seq.current) setSearching(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [query, toast]);

  const change = async (customerId: string, payer: string | null, ok: string) => {
    setBusyId(customerId);
    try { await setBillTo(customerId, payer); toast(ok, 'success'); await onChanged(); setQuery(''); }
    catch (e) { toast(errMsg(e), 'error'); }
    finally { setBusyId(null); }
  };

  return (
    <Sheet title="Linked accounts" subtitle={`Billed together on ${payerName}'s statement`} onClose={onClose}>
      <p className="text-sm text-text-secondary">
        Customers linked here roll into one consolidated statement under {payerName}. Their invoices stay on their own records.
      </p>
      <h3 className="mt-5 text-sm font-semibold text-text-primary">Currently linked ({children.length})</h3>
      {children.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">No accounts are linked yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
          {children.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <span className="min-w-0 truncate text-sm text-text-primary">{c.name}</span>
              <Button type="button" size="sm" variant="ghost" disabled={busyId === c.id} onClick={() => void change(c.id, null, `${c.name} unlinked.`)}>
                <Unlink size={14} /> Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <Input label="Add a customer" placeholder="Search by name…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
        {searching && <p className="mt-2 text-xs text-text-secondary">Searching…</p>}
        {!searching && query.trim().length >= 2 && results.length === 0 && <p className="mt-2 text-sm text-text-secondary">No customers match.</p>}
        {results.length > 0 && (
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {results.filter((r) => r.id !== payerId).map((r) => {
              const linkedHere = r.bill_to_customer_id === payerId;
              const linkedElsewhere = !!r.bill_to_customer_id && !linkedHere;
              return (
                <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary">{r.name}</span>
                    {r.email && <span className="block truncate text-xs text-text-secondary">{r.email}</span>}
                  </span>
                  {linkedHere ? <Pill className="bg-bg-tertiary text-text-secondary">Linked</Pill> : (
                    <Button type="button" size="sm" variant="secondary" disabled={busyId === r.id}
                      title={linkedElsewhere ? 'This will move it from its current payer' : undefined}
                      onClick={() => void change(r.id, payerId, `${r.name} linked.`)}>
                      <Link2 size={14} /> {linkedElsewhere ? 'Move here' : 'Link'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Statement viewer
// ---------------------------------------------------------------------------

function StatementDialog({ account, onClose, onSent, onLinksChanged }: {
  account: StatementAccount; onClose: () => void; onSent: () => Promise<void>; onLinksChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [preset, setPreset] = useState<PeriodPreset>('last_month');
  const [range, setRange] = useState(() => periodForPreset('last_month'));
  const [consolidate, setConsolidate] = useState(true);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [recipient, setRecipient] = useState(account.email ?? '');
  const [showLinks, setShowLinks] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  const periodError = validatePeriod(range.from, range.to);

  useEffect(() => {
    if (periodError) { setLoading(false); setStatement(null); return; }
    const id = ++seq.current;
    setLoading(true); setError(null);
    fetchStatement(account.customer_id, range.from, range.to, consolidate)
      .then((s) => { if (id === seq.current) setStatement(s); })
      .catch((e) => { if (id === seq.current) { setStatement(null); setError(errMsg(e)); } })
      .finally(() => { if (id === seq.current) setLoading(false); });
  }, [account.customer_id, range.from, range.to, consolidate, periodError, reloadKey]);

  const applyPreset = (p: PeriodPreset) => {
    setPreset(p);
    if (p !== 'custom') setRange(periodForPreset(p));
  };

  const download = () => {
    if (!statement) return;
    const blob = new Blob([statementToCsv(statement)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = statementFileName(statement); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const send = async () => {
    if (!statement || sending) return;
    setSending(true);
    try {
      const r = await sendStatementNow({
        customerId: account.customer_id, from: range.from, to: range.to, consolidate,
        recipient: recipient.trim() && recipient.trim() !== (account.email ?? '') ? recipient.trim() : undefined,
      });
      toast(`Statement sent to ${String(r.recipient ?? recipient)}.`, 'success');
      await onSent();
    } catch (e) { toast(errMsg(e), 'error'); }
    finally { setSending(false); }
  };

  const aging = statement ? agingRows(statement.aging) : [];
  const canSend = !!statement && !loading && !periodError && recipient.trim().length > 3;

  return (
    <>
      <Sheet
        wide title={`Statement · ${account.name}`}
        subtitle={statement ? `${fmtDate(statement.period_from)} – ${fmtDate(statement.period_to)}${statement.consolidated ? ` · ${statement.members.length} linked accounts` : ''}` : undefined}
        onClose={onClose}
        footer={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Input label="Send to" type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="customer@example.com" autoComplete="off" />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={download} disabled={!statement || loading}><Download size={14} /> CSV</Button>
              <Button type="button" size="sm" onClick={() => void send()} disabled={!canSend || sending}><Send size={14} /> {sending ? 'Sending…' : 'Send statement'}</Button>
            </div>
          </div>
        )}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Period">
            <select className={selectClass} value={preset} onChange={(e) => applyPreset(e.target.value as PeriodPreset)}>
              <option value="last_month">Last month</option><option value="this_month">This month</option>
              <option value="last_30">Last 30 days</option><option value="ytd">Year to date</option><option value="custom">Custom range</option>
            </select>
          </Field>
          <Field label="From" error={periodError ?? undefined}>
            <input type="date" className={selectClass} value={range.from} max={range.to} disabled={preset !== 'custom'} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
          </Field>
          <Field label="To">
            <input type="date" className={selectClass} value={range.to} min={range.from} max={isoToday()} disabled={preset !== 'custom'} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          </Field>
        </div>

        {account.child_count > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary/50 px-3 py-2.5">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent,#203ad8)]" checked={consolidate} onChange={(e) => setConsolidate(e.target.checked)} />
              Consolidated across {account.child_count} linked account{account.child_count === 1 ? '' : 's'}
            </label>
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowLinks(true)}><Link2 size={14} /> Manage links</Button>
          </div>
        )}
        {account.child_count === 0 && (
          <div className="mt-3"><Button type="button" size="sm" variant="ghost" onClick={() => setShowLinks(true)}><Link2 size={14} /> Link accounts to bill together</Button></div>
        )}

        {loading ? (
          <div className="mt-4"><SkeletonCardList count={2} rows={3} /></div>
        ) : error ? (
          <div className="mt-4"><EmptyStateError icon={AlertTriangle} title="Couldn't build this statement" description={error} onRetry={() => setReloadKey((k) => k + 1)} /></div>
        ) : statement ? (
          <FadeIn>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Opening balance" value={usd(statement.opening_cents)} />
              <Stat label="Charges" value={usd(statement.charges_cents + statement.refunds_cents)} />
              <Stat label="Payments" value={usd(-statement.payments_cents)} />
              <Stat label="Balance due" value={usd(statement.closing_cents)} sub={`as of ${fmtDate(statement.period_to)}`} />
            </div>

            <h3 className="mt-6 text-sm font-semibold text-text-primary">Aging</h3>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {aging.map((a) => (
                <div key={a.key} className="rounded-xl border border-border p-2.5">
                  <p className="text-[11px] text-text-secondary">{a.label}</p>
                  <p className={`mt-0.5 text-sm font-semibold ${a.key !== 'current' && a.cents > 0 ? 'text-danger' : 'text-text-primary'}`}>{usd(a.cents)}</p>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(a.share * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <h3 className="mt-6 text-sm font-semibold text-text-primary">Open invoices ({statement.open_invoices.length})</h3>
            {statement.open_invoices.length === 0 ? (
              <p className="mt-2 text-sm text-text-secondary">Nothing is owed as of this date.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {statement.open_invoices.map((o) => (
                  <li key={o.invoice_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-text-primary">{o.invoice_number ?? 'Invoice'}{statement.consolidated && <span className="font-normal text-text-secondary"> · {o.customer_name}</span>}</span>
                      <span className="block text-xs text-text-secondary">Due {fmtDate(o.due_date)} · {o.days_past_due > 0 ? `${o.days_past_due} days past due` : AGING_LABELS.current}</span>
                    </span>
                    <span className="text-sm font-semibold text-text-primary">{usd(o.balance_cents)}</span>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="mt-6 text-sm font-semibold text-text-primary">Activity ({statement.lines.length})</h3>
            {statement.lines.length === 0 ? (
              <p className="mt-2 text-sm text-text-secondary">No invoices, payments or refunds in this period.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {statement.lines.map((l, i) => (
                  <li key={`${l.reference}-${i}`} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 px-3 py-2.5">
                    <span className="min-w-0 truncate text-sm text-text-primary">{l.description}</span>
                    <span className={`text-right text-sm font-medium ${l.credit_cents ? 'text-success-500' : 'text-text-primary'}`}>
                      {l.credit_cents ? `−${usd(l.credit_cents)}` : usd(l.charge_cents)}
                    </span>
                    <span className="text-xs text-text-secondary">{fmtDate(l.date)}{statement.consolidated && l.customer_name ? ` · ${l.customer_name}` : ''}</span>
                    <span className="text-right text-xs text-text-secondary">Balance {usd(l.balance_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </FadeIn>
        ) : null}
      </Sheet>
      {showLinks && (
        <LinkedAccountsDialog
          payerId={account.customer_id} payerName={account.name} members={statement?.members ?? []}
          onClose={() => setShowLinks(false)}
          onChanged={async () => { await onLinksChanged(); setReloadKey((k) => k + 1); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Schedule editor
// ---------------------------------------------------------------------------

function ScheduleDialog({ initial, onClose, onSaved }: { initial: ScheduleDraft; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<ScheduleDraft>(initial);
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchCustomers>>>([]);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const seq = useRef(0);
  const zones = useMemo(() => timezoneOptions(draft.timezone), [draft.timezone]);
  const errors = validateScheduleDraft(draft);
  const set = <K extends keyof ScheduleDraft>(k: K, v: ScheduleDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  useEffect(() => {
    if (initial.customer_ids.length === 0) return;
    fetchCustomerNames(initial.customer_ids).then(setNames).catch(() => undefined);
  }, [initial.customer_ids]);

  useEffect(() => {
    const q = query.trim();
    if (draft.scope !== 'selected' || q.length < 2) { setResults([]); return; }
    const id = ++seq.current;
    const t = setTimeout(() => {
      searchCustomers(q).then((r) => { if (id === seq.current) setResults(r); }).catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [query, draft.scope]);

  const save = async () => {
    setTouched(true);
    if (Object.keys(errors).length > 0 || saving) return;
    setSaving(true);
    try { await saveSchedule(draft); toast('Schedule saved.', 'success'); await onSaved(); onClose(); }
    catch (e) { toast(errMsg(e), 'error'); setSaving(false); }
  };

  return (
    <Sheet
      title={draft.id ? 'Edit schedule' : 'New statement schedule'} subtitle="Statements are emailed automatically" onClose={onClose}
      footer={(
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save schedule'}</Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <Input label="Name" value={draft.name} maxLength={80} placeholder="e.g. Monthly statements" onChange={(e) => set('name', e.target.value)} error={touched ? errors.name : undefined} />

        <Field label="Who gets a statement">
          <select className={selectClass} value={draft.scope} onChange={(e) => set('scope', e.target.value as ScheduleDraft['scope'])}>
            {Object.entries(SCOPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>

        {draft.scope === 'selected' && (
          <div>
            <Input label={`Customers (${draft.customer_ids.length}/${MAX_SELECTED_CUSTOMERS})`} placeholder="Search by name to add…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" error={touched ? errors.customers : undefined} />
            {results.length > 0 && (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {results.filter((r) => !draft.customer_ids.includes(r.id)).map((r) => (
                  <li key={r.id}>
                    <button type="button" className="focus-ring flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-bg-tertiary"
                      onClick={() => { setNames((n) => ({ ...n, [r.id]: r.name })); set('customer_ids', [...draft.customer_ids, r.id]); setQuery(''); setResults([]); }}>
                      <span className="truncate text-sm text-text-primary">{r.name}</span><Plus size={14} className="shrink-0 text-text-secondary" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {draft.customer_ids.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {draft.customer_ids.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary py-1 pl-2.5 pr-1 text-xs text-text-primary">
                    {names[id] ?? 'Customer'}
                    <button type="button" aria-label={`Remove ${names[id] ?? 'customer'}`} className="focus-ring rounded-full p-0.5 hover:bg-bg-secondary"
                      onClick={() => set('customer_ids', draft.customer_ids.filter((x) => x !== id))}><X size={12} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <Field label="Statement period">
          <select className={selectClass} value={draft.period_mode} onChange={(e) => set('period_mode', e.target.value as ScheduleDraft['period_mode'])}>
            {Object.entries(PERIOD_MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Repeats">
            <select className={selectClass} value={draft.frequency} onChange={(e) => set('frequency', e.target.value as ScheduleDraft['frequency'])}>
              <option value="monthly">Monthly</option><option value="weekly">Weekly</option>
            </select>
          </Field>
          {draft.frequency === 'weekly' ? (
            <Field label="Day">
              <select className={selectClass} value={draft.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </Field>
          ) : (
            <Field label="Day of month" error={touched ? errors.month_day : undefined}>
              <select className={selectClass} value={draft.month_day} onChange={(e) => set('month_day', Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
          )}
          <Field label="Send at">
            <select className={selectClass} value={draft.send_hour} onChange={(e) => set('send_hour', Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`}</option>)}
            </select>
          </Field>
          <Field label="Timezone">
            <select className={selectClass} value={draft.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </Field>
        </div>

        <Input label="Skip balances under ($)" inputMode="decimal" value={draft.min_balance_dollars} onChange={(e) => set('min_balance_dollars', e.target.value)} error={touched ? errors.min_balance : undefined}
          helperText="Customers owing less than this are skipped." />

        <label className="flex items-start gap-2 text-sm text-text-primary">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={draft.consolidate} onChange={(e) => set('consolidate', e.target.checked)} />
          <span>Consolidated billing<span className="block text-xs text-text-secondary">Linked accounts get one statement under their payer instead of separate ones.</span></span>
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" className="h-4 w-4" checked={draft.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active
        </label>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function AccountsTab({ accounts, onOpen, onQuickSend }: { accounts: StatementAccount[]; onOpen: (a: StatementAccount) => void; onQuickSend: (a: StatementAccount) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AccountFilter>('balance');
  const shown = useMemo(() => filterAccounts(accounts, query, filter), [accounts, query, filter]);
  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input aria-label="Search accounts" className={`${selectClass} pl-9`} placeholder="Search by name, email or phone…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select aria-label="Filter accounts" className={`${selectClass} sm:w-48`} value={filter} onChange={(e) => setFilter(e.target.value as AccountFilter)}>
          <option value="balance">With a balance</option><option value="overdue">Overdue only</option><option value="all">All customers</option>
        </select>
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={ScrollText} title={accounts.length === 0 ? 'No customers yet' : 'No accounts match'}
          description={accounts.length === 0 ? 'Customers appear here once you have invoiced them.' : 'Try another search or switch the filter to “All customers”.'} />
      ) : (
        <ul className="space-y-2">
          {shown.map((a) => (
            <li key={a.customer_id}>
              <Card className="!p-3 sm:!p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button type="button" onClick={() => onOpen(a)} className="focus-ring min-w-0 flex-1 rounded-lg text-left">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-text-primary">{a.name}</span>
                      {a.child_count > 0 && <Pill className="bg-accent/10 text-accent"><Link2 size={11} /> {a.child_count} linked</Pill>}
                      {a.overdue_cents > 0 && <Pill className="bg-danger/10 text-danger">Overdue {usd(a.overdue_cents)}</Pill>}
                      {!a.email && <Pill className="bg-warning-500/10 text-warning-500">No email</Pill>}
                    </span>
                    <span className="mt-0.5 block text-xs text-text-secondary">
                      {a.invoice_count} open invoice{a.invoice_count === 1 ? '' : 's'}{a.oldest_due ? ` · oldest due ${fmtDate(a.oldest_due)}` : ''} · {a.last_sent_at ? `last statement ${fmtDateTime(a.last_sent_at)}` : 'never sent'}
                    </span>
                  </button>
                  <div className="flex items-center gap-3">
                    <span className="text-base font-semibold text-text-primary">{usd(a.balance_cents)}</span>
                    <Button type="button" size="sm" variant="secondary" onClick={() => onQuickSend(a)} aria-label={`Open statement for ${a.name}`}><Mail size={14} /> Statement</Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SchedulesTab({ schedules, onNew, onEdit, onChanged }: {
  schedules: StatementSchedule[]; onNew: () => void; onEdit: (s: StatementSchedule) => void; onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<StatementSchedule | null>(null);

  const run = async (id: string, fn: () => Promise<string | void>, key: string) => {
    setBusy(`${key}:${id}`);
    try { const msg = await fn(); if (msg) toast(msg, 'success'); await onChanged(); }
    catch (e) { toast(errMsg(e), 'error'); }
    finally { setBusy(null); }
  };

  if (schedules.length === 0) {
    return <EmptyState icon={CalendarClock} title="No schedules yet" description="Set up a schedule and statements go out to your customers automatically — no more chasing balances by hand." action={{ label: 'Create a schedule', onClick: onNew }} />;
  }
  return (
    <>
      <ul className="space-y-2">
        {schedules.map((s) => (
          <li key={s.id}>
            <Card className="!p-3 sm:!p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-text-primary">{s.name}</h3>
                    <Pill className={s.is_active ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}>{s.is_active ? 'Active' : 'Paused'}</Pill>
                    {s.last_status && <Pill className={statusTone(s.last_status)}>Last run: {s.last_status}</Pill>}
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">{describeSchedule(s)} · {PERIOD_MODE_LABELS[s.period_mode]} · {SCOPE_LABELS[s.scope]}{s.consolidate ? ' · consolidated' : ''}</p>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    {s.is_active && s.next_run_at ? `Next run ${fmtDateTime(s.next_run_at)}` : 'Not scheduled'}
                    {s.last_run_at ? ` · last ran ${fmtDateTime(s.last_run_at)}` : ''}
                    {s.last_summary && typeof s.last_summary.sent === 'number' ? ` · ${s.last_summary.sent} sent${s.last_summary.failed ? `, ${s.last_summary.failed} failed` : ''}${s.last_summary.skipped ? `, ${s.last_summary.skipped} skipped` : ''}` : ''}
                  </p>
                  {s.paused_reason && <p className="mt-1 text-xs text-warning-500">{s.paused_reason}</p>}
                  {s.last_summary?.problems?.[0] && s.last_status !== 'sent' && <p className="mt-1 text-xs text-danger">{s.last_summary.problems[0]}</p>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null}
                    onClick={() => void run(s.id, async () => { const r = await runScheduleNow(s.id); const sum = (r.summary ?? {}) as { sent?: number; skipped?: number; failed?: number }; return `Ran “${s.name}”: ${sum.sent ?? 0} sent, ${sum.skipped ?? 0} skipped, ${sum.failed ?? 0} failed.`; }, 'run')}>
                    <Send size={14} /> {busy === `run:${s.id}` ? 'Running…' : 'Run now'}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run(s.id, async () => { await setScheduleActive(s.id, !s.is_active); return s.is_active ? 'Schedule paused.' : 'Schedule resumed.'; }, 'toggle')}>
                    {s.is_active ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Resume</>}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => onEdit(s)}>Edit</Button>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}><Trash2 size={14} /></Button>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!deleting} title="Delete this schedule?" confirmLabel="Delete schedule"
        description={`“${deleting?.name ?? ''}” will stop sending statements. Past delivery history is kept.`}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => { if (!deleting) return; const id = deleting.id; setDeleting(null); await run(id, async () => { await deleteSchedule(id); return 'Schedule deleted.'; }, 'delete'); }}
      />
    </>
  );
}

function HistoryTab({ sends, hasMore, loadingMore, onMore }: { sends: StatementSend[]; hasMore: boolean; loadingMore: boolean; onMore: () => void }) {
  if (sends.length === 0) return <EmptyState icon={Mail} title="Nothing sent yet" description="Every statement you send — manually or on a schedule — is logged here." />;
  return (
    <div>
      <ul className="space-y-2">
        {sends.map((s) => (
          <li key={s.id}>
            <Card className="!p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{s.customer_name}{s.consolidated && <span className="font-normal text-text-secondary"> · consolidated</span>}</p>
                  <p className="text-xs text-text-secondary">
                    {fmtDateTime(s.created_at)} · {s.trigger === 'schedule' ? 'Scheduled' : `Manual${s.sent_by_email ? ` by ${s.sent_by_email}` : ''}`} · {fmtDate(s.period_from)} – {fmtDate(s.period_to)}{s.recipient ? ` · ${s.recipient}` : ''}
                  </p>
                  {s.error && <p className="mt-0.5 text-xs text-danger">{s.error}</p>}
                </div>
                <div className="flex items-center gap-2"><span className="text-sm font-semibold text-text-primary">{usd(s.closing_balance_cents)}</span><Pill className={statusTone(s.status)}>{s.status}</Pill></div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {hasMore && <div className="mt-4 flex justify-center"><Button type="button" variant="secondary" size="sm" onClick={onMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more'}</Button></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CustomerStatementsPage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;

  const [tab, setTab] = useState<Tab>('accounts');
  const [accounts, setAccounts] = useState<StatementAccount[]>([]);
  const [schedules, setSchedules] = useState<StatementSchedule[]>([]);
  const [sends, setSends] = useState<StatementSend[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sendsLoaded, setSendsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<StatementAccount | null>(null);
  const [editing, setEditing] = useState<ScheduleDraft | null>(null);

  const loadAccounts = useCallback(async () => { setAccounts(await fetchAccounts()); }, []);
  const loadSchedules = useCallback(async () => { setSchedules(await fetchSchedules()); }, []);
  const loadSends = useCallback(async () => {
    const rows = await fetchSends(0);
    setSends(rows); setHasMore(rows.length === SENDS_PAGE_SIZE); setSendsLoaded(true);
  }, []);

  const loadAll = useCallback(async () => {
    setFailed(null);
    try { await Promise.all([loadAccounts(), loadSchedules()]); }
    catch (e) { setFailed(errMsg(e)); }
  }, [loadAccounts, loadSchedules]);

  useEffect(() => {
    if (!user || !canAccess) { setLoading(false); return; }
    setLoading(true);
    void loadAll().finally(() => setLoading(false));
  }, [user, canAccess, loadAll]);

  useEffect(() => {
    if (tab !== 'history' || sendsLoaded || !canAccess) return;
    loadSends().catch((e) => toast(errMsg(e), 'error'));
  }, [tab, sendsLoaded, canAccess, loadSends, toast]);

  const refresh = async () => {
    setRefreshing(true);
    try { await Promise.all([loadAll(), sendsLoaded ? loadSends() : Promise.resolve()]); }
    finally { setRefreshing(false); }
  };

  const more = async () => {
    setLoadingMore(true);
    try {
      const rows = await fetchSends(sends.length);
      setSends((s) => [...s, ...rows]); setHasMore(rows.length === SENDS_PAGE_SIZE);
    } catch (e) { toast(errMsg(e), 'error'); }
    finally { setLoadingMore(false); }
  };

  const totals = useMemo(() => summarizeAccounts(accounts), [accounts]);

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Customer Statements">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: 'accounts', label: 'Accounts', badge: totals.withBalance || undefined },
    { id: 'schedules', label: 'Schedules', badge: schedules.filter((s) => s.is_active).length || undefined },
    { id: 'history', label: 'History' },
  ];

  return (
    <DashboardLayout activeLabel="Customer Statements">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent"><ScrollText size={22} /></span>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Customer Statements</h1>
            <p className="text-sm text-text-secondary">Send statements of account, bill linked sites together, and put it all on a schedule.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading || refreshing}><RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh</Button>
          <Button type="button" size="sm" onClick={() => { setTab('schedules'); setEditing(emptyDraft(defaultTimezone())); }}><Plus size={14} /> New schedule</Button>
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : failed ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn't load statements" description={failed} onRetry={() => { setLoading(true); void loadAll().finally(() => setLoading(false)); }} />
      ) : (
        <FadeIn>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Outstanding" value={usd(totals.outstanding)} sub={`${totals.withBalance} account${totals.withBalance === 1 ? '' : 's'} owe`} />
            <Stat label="Overdue" value={usd(totals.overdue)} />
            <Stat label="Consolidated payers" value={String(totals.consolidated)} />
            <Stat label="Active schedules" value={String(schedules.filter((s) => s.is_active).length)} />
          </div>

          <div role="tablist" aria-label="Statement sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" id={`stmt-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`stmt-panel-${t.id}`} onClick={() => setTab(t.id)}
                className={`focus-ring -mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.id ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
                {t.label}{t.badge ? <span className="ml-1.5 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[11px]">{t.badge}</span> : null}
              </button>
            ))}
          </div>

          <div role="tabpanel" id={`stmt-panel-${tab}`} aria-labelledby={`stmt-tab-${tab}`}>
            {tab === 'accounts' && <AccountsTab accounts={accounts} onOpen={setOpen} onQuickSend={setOpen} />}
            {tab === 'schedules' && <SchedulesTab schedules={schedules} onNew={() => setEditing(emptyDraft(defaultTimezone()))} onEdit={(s) => setEditing(draftFromSchedule(s))} onChanged={loadSchedules} />}
            {tab === 'history' && (sendsLoaded ? <HistoryTab sends={sends} hasMore={hasMore} loadingMore={loadingMore} onMore={() => void more()} /> : <SkeletonCardList count={3} rows={2} />)}
          </div>
        </FadeIn>
      )}

      {open && (
        <StatementDialog
          account={open} onClose={() => setOpen(null)}
          onSent={async () => { await Promise.all([loadAccounts(), sendsLoaded ? loadSends() : Promise.resolve()]); }}
          onLinksChanged={loadAccounts}
        />
      )}
      {editing && <ScheduleDialog initial={editing} onClose={() => setEditing(null)} onSaved={loadSchedules} />}
    </DashboardLayout>
  );
}
