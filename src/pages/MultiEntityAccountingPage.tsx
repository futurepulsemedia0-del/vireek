import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowRightLeft, BookOpen, Building2, CheckCircle2, Download, Lock, Network, Pencil, Plus, RefreshCw, X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { fetchChartOfAccounts, type ChartOfAccount } from '@/lib/accounting';
import {
  ENTITY_TYPE_LABELS, IC_KIND_LABELS, IC_STATUS_LABELS, METHOD_LABELS, PRESET_LABELS,
  buildReport, defaultIncludedIds, draftFromEntity, emptyEntityDraft, emptyIcDraft, emptyJournalLine, errMsg, icPositions,
  isoToday, journalTotals, money, outstandingCents, parseAmountToCents, periodForPreset, reportFileName, reportToCsv,
  validateEntityDraft, validateIcDraft, validateJournal, validatePeriod, validateSettlement,
  type AccountingEntity, type BalanceRow, type ConsolidatedReport, type EntityDraft, type EntityErrors, type IcDraft, type IcErrors, type IcKind, type IcStatus,
  type IcTransaction, type JournalLineDraft, type PeriodPreset, type ReportLine,
} from '@/lib/multiEntity';
import {
  fetchBalances, fetchEntities, fetchIntercompany, postEntityJournal, postIntercompany, saveEntity, settleIntercompany,
  setupMultiEntity, voidIntercompany,
} from '@/lib/multiEntityApi';

type Tab = 'reports' | 'entities' | 'intercompany';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function statusTone(s: IcStatus): string {
  if (s === 'settled') return 'bg-success-500/10 text-success-500';
  if (s === 'partially_settled') return 'bg-warning-500/10 text-warning-500';
  if (s === 'void') return 'bg-danger/10 text-danger';
  return 'bg-accent/10 text-accent';
}

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

function SelectField({ label, value, onChange, options, error, disabled, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>;
  error?: string; disabled?: boolean; placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-invalid={!!error} className={selectClass}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <p role="alert" className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

function Sheet({ title, subtitle, onClose, wide = false, footer, children }: {
  title: string; subtitle?: string; onClose: () => void; wide?: boolean; footer?: ReactNode; children: ReactNode;
}) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  return (
    <>
      <div className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="me-sheet-title"
        className={`fixed inset-x-0 bottom-0 top-10 z-[131] flex flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-primary shadow-xl sm:inset-y-6 sm:mx-auto sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id="me-sheet-title" className="truncate text-lg font-semibold text-text-primary">{title}</h2>
            {subtitle && <p className="truncate text-xs text-text-secondary">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -mr-1 rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer && <div className="border-t border-border bg-bg-secondary/60 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">{footer}</div>}
      </div>
    </>
  );
}

function SubmitError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{message}</p>;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function EntityDialog({ initial, existing, onClose, onSaved }: {
  initial: EntityDraft; existing: AccountingEntity[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const errors = validateEntityDraft(draft, existing);
  const set = <K extends keyof EntityDraft>(k: K, v: EntityDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const shown: EntityErrors = showErrors ? errors : {};

  const save = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || saving) return;
    setSaving(true); setSubmitError(null);
    try {
      await saveEntity(draft);
      toast(draft.id ? 'Entity updated.' : 'Entity created.', 'success');
      await onSaved();
      onClose();
    } catch (e) { setSubmitError(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <Sheet
      title={draft.id ? 'Edit entity' : 'New entity'} subtitle="A legal entity with its own books" onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save entity'}</Button></div>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Code" value={draft.code} onChange={(e) => set('code', e.target.value)} error={shown.code} maxLength={20} placeholder="TX-LLC" autoComplete="off" />
        <Input label="Name" value={draft.name} onChange={(e) => set('name', e.target.value)} error={shown.name} maxLength={120} autoComplete="off" />
      </div>
      <Input label="Legal name (optional)" value={draft.legal_name} onChange={(e) => set('legal_name', e.target.value)} error={shown.legal_name} maxLength={200} autoComplete="off" />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Entity type" value={draft.entity_type} onChange={(v) => set('entity_type', v as EntityDraft['entity_type'])}
          options={Object.entries(ENTITY_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
        <Input label="Country / region (optional)" value={draft.country} onChange={(e) => set('country', e.target.value)} error={shown.country} maxLength={60} autoComplete="off" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Ownership %" value={draft.ownership_pct} onChange={(e) => set('ownership_pct', e.target.value)} error={shown.ownership_pct}
          inputMode="decimal" disabled={draft.is_primary} helperText="Below 100% creates a non-controlling interest." />
        <SelectField label="Consolidation" value={draft.consolidation_method} onChange={(v) => set('consolidation_method', v as EntityDraft['consolidation_method'])}
          disabled={draft.is_primary} options={Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label }))} />
      </div>
      {draft.id && !draft.is_primary && (
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={draft.is_active} onChange={(e) => set('is_active', e.target.checked)} className="h-4 w-4" />
          Entity is active
        </label>
      )}
      <SubmitError message={submitError} />
    </Sheet>
  );
}

function IntercompanyDialog({ entities, onClose, onSaved }: { entities: AccountingEntity[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const active = entities.filter((e) => e.is_active);
  const [draft, setDraft] = useState<IcDraft>(() => ({ ...emptyIcDraft(), from_entity_id: active.find((e) => e.is_primary)?.id ?? '' }));
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const key = useRef(newKey());
  const errors = validateIcDraft(draft, entities);
  const shown: IcErrors = showErrors ? errors : {};
  const set = <K extends keyof IcDraft>(k: K, v: IcDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const options = active.map((e) => ({ value: e.id, label: `${e.code} · ${e.name}` }));
  const cents = parseAmountToCents(draft.amount);
  const from = active.find((e) => e.id === draft.from_entity_id);
  const to = active.find((e) => e.id === draft.to_entity_id);

  const save = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || cents === null || saving) return;
    setSaving(true); setSubmitError(null);
    try {
      await postIntercompany({ ...draft, amount_cents: cents, idempotency_key: key.current });
      toast('Intercompany transaction posted to both entities.', 'success');
      await onSaved();
      onClose();
    } catch (e) { setSubmitError(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <Sheet
      title="New intercompany transaction" subtitle="Posts matching entries in both entities' books" onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving}>{saving ? 'Posting…' : 'Post transaction'}</Button></div>}
    >
      <SelectField label="Provided by" value={draft.from_entity_id} onChange={(v) => set('from_entity_id', v)} options={options} placeholder="Select entity" error={shown.from_entity_id} />
      <SelectField label="Received by" value={draft.to_entity_id} onChange={(v) => set('to_entity_id', v)} options={options} placeholder="Select entity" error={shown.to_entity_id} />
      <SelectField label="Type" value={draft.kind} onChange={(v) => set('kind', v as IcKind)} options={Object.entries(IC_KIND_LABELS).map(([value, label]) => ({ value, label }))} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Date" type="date" value={draft.txn_date} onChange={(e) => set('txn_date', e.target.value)} error={shown.txn_date} />
        <Input label="Amount" value={draft.amount} onChange={(e) => set('amount', e.target.value)} error={shown.amount} inputMode="decimal" placeholder="0.00" autoComplete="off" />
      </div>
      <Textarea label="Description (optional)" rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} error={shown.description} maxLength={500} />
      {from && to && cents !== null && cents > 0 && from.id !== to.id && (
        <p className="rounded-xl bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
          {from.name} records a {money(cents)} receivable; {to.name} records a {money(cents)} payable. Both are eliminated in consolidated reports.
        </p>
      )}
      <SubmitError message={submitError} />
    </Sheet>
  );
}

function SettleDialog({ txn, label, onClose, onSaved }: { txn: IcTransaction; label: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState((outstandingCents(txn) / 100).toFixed(2));
  const [date, setDate] = useState(() => { const t = isoToday(); return t < txn.txn_date ? txn.txn_date : t; });
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const errors = validateSettlement(amount, date, txn);
  const shown: { amount?: string; date?: string } = showErrors ? errors : {};

  const save = async () => {
    setShowErrors(true);
    const cents = parseAmountToCents(amount);
    if (errors.amount || errors.date || cents === null || saving) return;
    setSaving(true); setSubmitError(null);
    try {
      await settleIntercompany(txn.id, date, cents);
      toast('Settlement recorded in both entities.', 'success');
      await onSaved();
      onClose();
    } catch (e) { setSubmitError(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <Sheet
      title="Record settlement" subtitle={`${txn.txn_number} · ${label}`} onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Record settlement'}</Button></div>}
    >
      <p className="text-sm text-text-secondary">Outstanding: <span className="font-semibold text-text-primary">{money(outstandingCents(txn))}</span>. The paying entity's cash is reduced and the receiving entity's cash is increased.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Amount paid" value={amount} onChange={(e) => setAmount(e.target.value)} error={shown.amount} inputMode="decimal" autoComplete="off" />
        <Input label="Payment date" type="date" value={date} onChange={(e) => setDate(e.target.value)} error={shown.date} />
      </div>
      <SubmitError message={submitError} />
    </Sheet>
  );
}

function VoidDialog({ txn, label, onClose, onSaved }: { txn: IcTransaction; label: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const tooShort = reason.trim().length < 3;

  const save = async () => {
    if (tooShort || saving) return;
    setSaving(true); setSubmitError(null);
    try {
      await voidIntercompany(txn.id, reason);
      toast('Transaction voided and reversed in both entities.', 'success');
      await onSaved();
      onClose();
    } catch (e) { setSubmitError(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <Sheet
      title="Void transaction" subtitle={`${txn.txn_number} · ${label}`} onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Keep it</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving || tooShort}>{saving ? 'Voiding…' : 'Void and reverse'}</Button></div>}
    >
      <p className="text-sm text-text-secondary">Reversing entries are posted in both entities today. This cannot be undone.</p>
      <Textarea label="Reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      <SubmitError message={submitError} />
    </Sheet>
  );
}

function JournalDialog({ entity, onClose, onSaved }: { entity: AccountingEntity; onClose: () => void; onSaved: () => Promise<void> }) {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<ChartOfAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [date, setDate] = useState(isoToday());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<JournalLineDraft[]>([emptyJournalLine(), emptyJournalLine()]);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchChartOfAccounts().then((a) => { if (live) setAccounts(a); }).catch((e) => { if (live) setLoadError(errMsg(e)); });
    return () => { live = false; };
  }, []);

  const totals = journalTotals(lines);
  const diff = totals.debit - totals.credit;
  const setLine = (i: number, patch: Partial<JournalLineDraft>) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const save = async () => {
    const { error, payload } = validateJournal(date, memo, lines);
    if (error) { setSubmitError(error); return; }
    if (saving) return;
    setSaving(true); setSubmitError(null);
    try {
      await postEntityJournal(entity.id, date, memo, payload);
      toast(`Journal entry posted to ${entity.name}.`, 'success');
      await onSaved();
      onClose();
    } catch (e) { setSubmitError(errMsg(e)); }
    finally { setSaving(false); }
  };

  return (
    <Sheet
      wide title="Post journal entry" subtitle={`${entity.code} · ${entity.name}`} onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`text-sm font-medium ${diff === 0 && totals.debit > 0 ? 'text-success-500' : 'text-text-secondary'}`}>
            Debits {money(totals.debit)} · Credits {money(totals.credit)}{diff !== 0 ? ` · Off by ${money(Math.abs(diff))}` : ''}
          </p>
          <div className="flex gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="button" size="sm" onClick={() => void save()} disabled={saving || !accounts}>{saving ? 'Posting…' : 'Post entry'}</Button></div>
        </div>
      }
    >
      {loadError ? (
        <SubmitError message={`Couldn't load the chart of accounts: ${loadError}`} />
      ) : !accounts ? (
        <p className="text-sm text-text-secondary">Loading accounts…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Input label="Memo (optional)" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} autoComplete="off" />
          </div>
          <div className="space-y-3">
            {lines.map((l, i) => (
              <div key={i} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[1fr_8rem_8rem]">
                <SelectField label={`Account (line ${i + 1})`} value={l.account_id} onChange={(v) => setLine(i, { account_id: v })} placeholder="Select account"
                  options={accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} />
                <Input label="Debit" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} inputMode="decimal" placeholder="0.00" autoComplete="off" />
                <Input label="Credit" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} inputMode="decimal" placeholder="0.00" autoComplete="off" />
              </div>
            ))}
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, emptyJournalLine()])}><Plus size={14} /> Add line</Button>
        </>
      )}
      <SubmitError message={submitError} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

interface Section { heading: string; lines: ReportLine[]; total?: { label: string; cents: number } }

function StatementTable({ title, sections, footer, showElim }: {
  title: string; sections: Section[]; showElim: boolean; footer: Array<{ label: string; cents: number; strong?: boolean }>;
}) {
  const cols = showElim ? 4 : 2;
  return (
    <Card className="overflow-hidden !p-0">
      <h3 className="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="text-xs text-text-secondary">
              <th scope="col" className="px-4 py-2 text-left font-medium">Account</th>
              {showElim && <th scope="col" className="px-3 py-2 text-right font-medium">Combined</th>}
              {showElim && <th scope="col" className="px-3 py-2 text-right font-medium">Eliminations</th>}
              <th scope="col" className="px-4 py-2 text-right font-medium">{showElim ? 'Consolidated' : 'Amount'}</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <SectionRows key={s.heading} section={s} showElim={showElim} cols={cols} />
            ))}
            {footer.map((f) => (
              <tr key={f.label} className="border-t border-border bg-bg-secondary/60">
                <th scope="row" colSpan={cols - 1} className={`px-4 py-2 text-left ${f.strong ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary'}`}>{f.label}</th>
                <td className={`px-4 py-2 text-right tabular-nums ${f.strong ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>{money(f.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SectionRows({ section, showElim, cols }: { section: Section; showElim: boolean; cols: number }) {
  return (
    <>
      <tr className="bg-bg-tertiary/50"><th scope="colgroup" colSpan={cols} className="px-4 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary">{section.heading}</th></tr>
      {section.lines.length === 0 && <tr><td colSpan={cols} className="px-4 py-2 text-xs text-text-secondary">No activity</td></tr>}
      {section.lines.map((l) => (
        <tr key={l.account_id} className="border-t border-border/60">
          <td className="px-4 py-2 text-text-primary"><span className="text-text-secondary">{l.code}</span> {l.name}</td>
          {showElim && <td className="px-3 py-2 text-right tabular-nums text-text-secondary">{money(l.combined_cents)}</td>}
          {showElim && <td className="px-3 py-2 text-right tabular-nums text-text-secondary">{l.elimination_cents ? money(l.elimination_cents) : '—'}</td>}
          <td className="px-4 py-2 text-right tabular-nums text-text-primary">{money(l.consolidated_cents)}</td>
        </tr>
      ))}
      {section.total && (
        <tr className="border-t border-border">
          <th scope="row" colSpan={cols - 1} className="px-4 py-2 text-left font-semibold text-text-primary">{section.total.label}</th>
          <td className="px-4 py-2 text-right font-semibold tabular-nums text-text-primary">{money(section.total.cents)}</td>
        </tr>
      )}
    </>
  );
}

function ReportsTab({ entities, report, loading, error, onRetry, preset, range, onPreset, onRange, view, onView, excluded, onToggle, periodError, onExport }: {
  entities: AccountingEntity[]; report: ConsolidatedReport; loading: boolean; error: string | null; onRetry: () => void;
  preset: PeriodPreset; range: { from: string; to: string }; onPreset: (p: PeriodPreset) => void; onRange: (from: string, to: string) => void;
  view: string; onView: (v: string) => void; excluded: string[]; onToggle: (id: string) => void; periodError: string | null; onExport: () => void;
}) {
  const consolidatable = entities.filter((e) => e.is_active && e.consolidation_method === 'full');
  const t = report.totals;
  const empty = report.revenue.length + report.expenses.length + report.assets.length + report.liabilities.length + report.equity.length === 0;
  const showNci = report.consolidated && (t.nci_equity_cents !== 0 || t.nci_net_income_cents !== 0);

  let body: ReactNode;
  if (periodError) body = <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{periodError}</p>;
  else if (error) body = <EmptyStateError icon={AlertTriangle} title="Couldn't load the report" description={error} onRetry={onRetry} />;
  else if (loading) body = <SkeletonCardList count={2} rows={4} />;
  else if (report.entity_ids.length === 0) body = <EmptyState icon={Building2} title="No entities selected" description="Select at least one entity to build a report." />;
  else if (empty) body = <EmptyState icon={BookOpen} title="No ledger activity" description="Nothing is posted for the selected entities in this period. Post a journal entry or an intercompany transaction to get started." />;
  else {
    body = (
      <FadeIn>
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Revenue" value={money(t.revenue_cents)} />
          <Stat label="Net income" value={money(t.net_income_cents)} sub={showNci ? `${money(t.parent_net_income_cents)} to owners` : undefined} />
          <Stat label="Total assets" value={money(t.total_assets_cents)} />
          <Stat label="Intercompany eliminated" value={money(report.eliminations.revenue_cents)} sub={report.consolidated ? 'revenue and expense' : 'single entity view'} />
        </div>
        {report.consolidated && (
          report.checks.intercompany_ok ? (
            <p className="mb-4 flex items-center gap-2 rounded-xl border border-success-500/30 bg-success-500/10 px-3 py-2 text-sm text-success-500"><CheckCircle2 size={16} /> Intercompany balances agree across all included entities.</p>
          ) : (
            <p role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-warning-500">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>Intercompany accounts do not agree: revenue vs expense differ by {money(Math.abs(report.checks.trade_difference_cents))} and receivable vs payable by {money(Math.abs(report.checks.balance_difference_cents))}. Review manual postings to the intercompany accounts.</span>
            </p>
          )
        )}
        {!report.checks.balanced && (
          <p role="alert" className="mb-4 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"><AlertTriangle size={16} /> The balance sheet is out of balance by {money(Math.abs(t.total_assets_cents - t.total_liabilities_equity_cents))}.</p>
        )}
        <div className="grid gap-4 xl:grid-cols-2">
          <StatementTable
            title="Income statement" showElim={report.consolidated}
            sections={[
              { heading: 'Revenue', lines: report.revenue, total: { label: 'Total revenue', cents: t.revenue_cents } },
              { heading: 'Expenses', lines: report.expenses, total: { label: 'Total expenses', cents: t.expense_cents } },
            ]}
            footer={[
              { label: 'Net income', cents: t.net_income_cents, strong: true },
              ...(showNci ? [{ label: 'Attributable to non-controlling interest', cents: t.nci_net_income_cents }, { label: 'Attributable to owners', cents: t.parent_net_income_cents }] : []),
            ]}
          />
          <StatementTable
            title={`Balance sheet as of ${range.to}`} showElim={report.consolidated}
            sections={[
              { heading: 'Assets', lines: report.assets, total: { label: 'Total assets', cents: t.total_assets_cents } },
              { heading: 'Liabilities', lines: report.liabilities, total: { label: 'Total liabilities', cents: t.total_liabilities_cents } },
              { heading: 'Equity', lines: report.equity },
            ]}
            footer={[
              { label: 'Cumulative earnings', cents: t.cumulative_earnings_cents },
              ...(t.unreconciled_cents !== 0 ? [{ label: 'Intercompany difference (unreconciled)', cents: t.unreconciled_cents }] : []),
              { label: 'Total liabilities and equity', cents: t.total_liabilities_equity_cents, strong: true },
              ...(showNci ? [{ label: 'Of which non-controlling interest', cents: t.nci_equity_cents }] : []),
            ]}
          />
        </div>
      </FadeIn>
    );
  }

  return (
    <div>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField label="Period" value={preset} onChange={(v) => onPreset(v as PeriodPreset)} options={Object.entries(PRESET_LABELS).map(([value, label]) => ({ value, label }))} />
        <Input label="From" type="date" value={range.from} onChange={(e) => onRange(e.target.value, range.to)} />
        <Input label="To (balance sheet as of)" type="date" value={range.to} onChange={(e) => onRange(range.from, e.target.value)} />
        <SelectField label="View" value={view} onChange={onView}
          options={[{ value: 'consolidated', label: 'Consolidated' }, ...entities.filter((e) => e.is_active).map((e) => ({ value: e.id, label: `${e.code} only` }))]} />
      </div>
      {view === 'consolidated' && consolidatable.length > 1 && (
        <fieldset className="mb-4 flex flex-wrap items-center gap-2">
          <legend className="sr-only">Entities included in the consolidation</legend>
          {consolidatable.map((e) => (
            <label key={e.id} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-primary">
              <input type="checkbox" checked={!excluded.includes(e.id)} onChange={() => onToggle(e.id)} className="h-3.5 w-3.5" />
              {e.code}
            </label>
          ))}
        </fieldset>
      )}
      {body}
      {!periodError && !error && !loading && !empty && report.entity_ids.length > 0 && (
        <div className="mt-4 flex justify-end"><Button type="button" variant="secondary" size="sm" onClick={onExport}><Download size={14} /> Export CSV</Button></div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entities + Intercompany tabs
// ---------------------------------------------------------------------------

function EntitiesTab({ entities, isOwner, onEdit, onJournal }: {
  entities: AccountingEntity[]; isOwner: boolean; onEdit: (e: AccountingEntity) => void; onJournal: (e: AccountingEntity) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {entities.map((e) => (
        <Card key={e.id} className="!p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-semibold text-text-primary">{e.name}</p>
              <p className="truncate text-xs text-text-secondary">{e.code}{e.legal_name ? ` · ${e.legal_name}` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {e.is_primary && <Pill className="bg-accent/10 text-accent">Primary</Pill>}
              {!e.is_active && <Pill className="bg-bg-tertiary text-text-secondary">Inactive</Pill>}
              {e.consolidation_method === 'excluded' && <Pill className="bg-warning-500/10 text-warning-500">Excluded</Pill>}
            </div>
          </div>
          <p className="mt-2 text-xs text-text-secondary">
            {ENTITY_TYPE_LABELS[e.entity_type]} · {e.ownership_pct}% owned{e.country ? ` · ${e.country}` : ''}
          </p>
          {e.is_primary && <p className="mt-1 text-xs text-text-secondary">Uses your existing general ledger, invoices and bills.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={!e.is_active} onClick={() => onJournal(e)}><BookOpen size={14} /> Journal entry</Button>
            {isOwner && <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(e)}><Pencil size={14} /> Edit</Button>}
          </div>
        </Card>
      ))}
    </div>
  );
}

function IntercompanyTab({ entities, txns, onNew, onSettle, onVoid }: {
  entities: AccountingEntity[]; txns: IcTransaction[]; onNew: () => void; onSettle: (t: IcTransaction) => void; onVoid: (t: IcTransaction) => void;
}) {
  const name = (id: string) => entities.find((e) => e.id === id)?.name ?? 'Unknown entity';
  const positions = useMemo(() => icPositions(txns), [txns]);
  if (txns.length === 0) {
    return <EmptyState icon={ArrowRightLeft} title="No intercompany transactions yet" description="Record sales, services, recharges or loans between your entities. Both sides are posted automatically and eliminated in consolidated reports." action={{ label: 'New transaction', onClick: onNew }} />;
  }
  return (
    <div className="space-y-6">
      {positions.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-text-primary">Open balances</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {positions.map((p) => (
              <Card key={`${p.from_entity_id}>${p.to_entity_id}`} className="!p-4">
                <p className="text-xs text-text-secondary">{name(p.to_entity_id)} owes {name(p.from_entity_id)}</p>
                <p className="mt-1 text-xl font-semibold text-text-primary">{money(p.open_cents)}</p>
                <p className="text-xs text-text-secondary">{p.count} open transaction{p.count === 1 ? '' : 's'}</p>
              </Card>
            ))}
          </div>
        </div>
      )}
      <ul className="divide-y divide-border rounded-2xl border border-border bg-bg-secondary">
        {txns.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                {t.txn_number}
                <Pill className={statusTone(t.status)}>{IC_STATUS_LABELS[t.status]}</Pill>
              </p>
              <p className="truncate text-xs text-text-secondary">{t.txn_date} · {IC_KIND_LABELS[t.kind]} · {name(t.from_entity_id)} → {name(t.to_entity_id)}</p>
              {t.description && <p className="truncate text-xs text-text-secondary">{t.description}</p>}
              {t.status === 'void' && t.void_reason && <p className="text-xs text-danger">Voided: {t.void_reason}</p>}
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-sm font-semibold tabular-nums text-text-primary">{money(t.amount_cents)}</p>
                {t.status !== 'void' && <p className="text-xs tabular-nums text-text-secondary">{money(outstandingCents(t))} open</p>}
              </div>
              <div className="flex gap-1.5">
                {(t.status === 'open' || t.status === 'partially_settled') && <Button type="button" variant="secondary" size="sm" onClick={() => onSettle(t)}>Settle</Button>}
                {t.status === 'open' && <Button type="button" variant="ghost" size="sm" onClick={() => onVoid(t)}>Void</Button>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MultiEntityAccountingPage() {
  const { user, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;

  const [tab, setTab] = useState<Tab>('reports');
  const [entities, setEntities] = useState<AccountingEntity[]>([]);
  const [txns, setTxns] = useState<IcTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [range, setRange] = useState(() => periodForPreset('this_month'));
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [balLoading, setBalLoading] = useState(false);
  const [balError, setBalError] = useState<string | null>(null);
  const [view, setView] = useState('consolidated');
  const [excluded, setExcluded] = useState<string[]>([]);
  const [entityDialog, setEntityDialog] = useState<EntityDraft | null>(null);
  const [icDialog, setIcDialog] = useState(false);
  const [settleTxn, setSettleTxn] = useState<IcTransaction | null>(null);
  const [voidTxn, setVoidTxn] = useState<IcTransaction | null>(null);
  const [journalEntity, setJournalEntity] = useState<AccountingEntity | null>(null);
  const seq = useRef(0);

  const isSetUp = entities.length > 0;
  const periodError = validatePeriod(range.from, range.to);

  const loadCore = useCallback(async () => {
    const [e, t] = await Promise.all([fetchEntities(), fetchIntercompany()]);
    setEntities(e);
    setTxns(t);
  }, []);

  const loadBalances = useCallback(async (from: string, to: string) => {
    const id = ++seq.current;
    setBalLoading(true); setBalError(null);
    try {
      const r = await fetchBalances(from, to);
      if (id === seq.current) setRows(r);
    } catch (e) {
      if (id === seq.current) { setRows([]); setBalError(errMsg(e)); }
    } finally {
      if (id === seq.current) setBalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user || !canAccess) { setLoading(false); return; }
    setLoading(true); setFailed(null);
    loadCore().catch((e) => setFailed(errMsg(e))).finally(() => setLoading(false));
  }, [user, canAccess, loadCore]);

  useEffect(() => {
    if (!canAccess || !isSetUp || periodError) return;
    void loadBalances(range.from, range.to);
  }, [canAccess, isSetUp, periodError, range.from, range.to, loadBalances]);

  useEffect(() => {
    if (view !== 'consolidated' && !entities.some((e) => e.id === view && e.is_active)) setView('consolidated');
  }, [entities, view]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadCore();
      if (!validatePeriod(range.from, range.to)) await loadBalances(range.from, range.to);
    } catch (e) { toast(errMsg(e), 'error'); }
    finally { setRefreshing(false); }
  }, [loadCore, loadBalances, range.from, range.to, toast]);

  const runSetup = async () => {
    if (settingUp) return;
    setSettingUp(true);
    try {
      await setupMultiEntity();
      toast('Multi-entity accounting is ready.', 'success');
      await loadCore();
    } catch (e) { toast(errMsg(e), 'error'); }
    finally { setSettingUp(false); }
  };

  const includeIds = useMemo(
    () => (view === 'consolidated' ? defaultIncludedIds(entities).filter((id) => !excluded.includes(id)) : [view]),
    [view, entities, excluded],
  );
  const report = useMemo(() => buildReport(rows, entities, includeIds), [rows, entities, includeIds]);
  const openCount = txns.filter((t) => t.status === 'open' || t.status === 'partially_settled').length;
  const labelFor = (t: IcTransaction) => {
    const n = (id: string) => entities.find((e) => e.id === id)?.name ?? 'Unknown entity';
    return `${n(t.from_entity_id)} → ${n(t.to_entity_id)}`;
  };

  const exportCsv = () => {
    const blob = new Blob([reportToCsv(report, range)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = reportFileName(range);
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Multi-Entity Accounting">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const TABS: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: 'reports', label: 'Consolidated reports' },
    { id: 'entities', label: 'Entities', badge: entities.length || undefined },
    { id: 'intercompany', label: 'Intercompany', badge: openCount || undefined },
  ];

  return (
    <DashboardLayout activeLabel="Multi-Entity Accounting">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Network size={22} /></span>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Multi-Entity Accounting</h1>
            <p className="text-sm text-text-secondary">Run several legal entities, record intercompany activity once, and report on the whole group.</p>
          </div>
        </div>
        {isSetUp && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading || refreshing}><RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh</Button>
            {tab === 'entities' && isOwner && <Button type="button" size="sm" onClick={() => setEntityDialog(emptyEntityDraft())}><Plus size={14} /> New entity</Button>}
            {tab === 'intercompany' && entities.filter((e) => e.is_active).length > 1 && <Button type="button" size="sm" onClick={() => setIcDialog(true)}><Plus size={14} /> New transaction</Button>}
          </div>
        )}
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : failed ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn't load multi-entity accounting" description={failed}
          onRetry={() => { setLoading(true); setFailed(null); loadCore().catch((e) => setFailed(errMsg(e))).finally(() => setLoading(false)); }} />
      ) : !isSetUp ? (
        <EmptyState
          icon={Building2} title="Set up multi-entity accounting"
          description={isOwner
            ? 'Your existing books become the primary entity. You can then add subsidiaries, record intercompany transactions and view consolidated reports.'
            : 'The account owner needs to set up multi-entity accounting before it can be used.'}
          action={isOwner ? { label: settingUp ? 'Setting up…' : 'Set up now', onClick: () => void runSetup() } : undefined}
        />
      ) : (
        <FadeIn>
          <div role="tablist" aria-label="Multi-entity sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" id={`me-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`me-panel-${t.id}`} onClick={() => setTab(t.id)}
                className={`focus-ring -mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.id ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
                {t.label}{t.badge ? <span className="ml-1.5 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[11px]">{t.badge}</span> : null}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`me-panel-${tab}`} aria-labelledby={`me-tab-${tab}`}>
            {tab === 'reports' && (
              <ReportsTab
                entities={entities} report={report} loading={balLoading} error={balError} periodError={periodError}
                onRetry={() => void loadBalances(range.from, range.to)} preset={preset} range={range}
                onPreset={(p) => { setPreset(p); if (p !== 'custom') setRange(periodForPreset(p)); }}
                onRange={(from, to) => { setPreset('custom'); setRange({ from, to }); }}
                view={view} onView={setView} excluded={excluded}
                onToggle={(id) => setExcluded((x) => (x.includes(id) ? x.filter((i) => i !== id) : [...x, id]))}
                onExport={exportCsv}
              />
            )}
            {tab === 'entities' && <EntitiesTab entities={entities} isOwner={isOwner} onEdit={(e) => setEntityDialog(draftFromEntity(e))} onJournal={setJournalEntity} />}
            {tab === 'intercompany' && <IntercompanyTab entities={entities} txns={txns} onNew={() => setIcDialog(true)} onSettle={setSettleTxn} onVoid={setVoidTxn} />}
          </div>
        </FadeIn>
      )}

      {entityDialog && <EntityDialog initial={entityDialog} existing={entities} onClose={() => setEntityDialog(null)} onSaved={refresh} />}
      {icDialog && <IntercompanyDialog entities={entities} onClose={() => setIcDialog(false)} onSaved={refresh} />}
      {settleTxn && <SettleDialog txn={settleTxn} label={labelFor(settleTxn)} onClose={() => setSettleTxn(null)} onSaved={refresh} />}
      {voidTxn && <VoidDialog txn={voidTxn} label={labelFor(voidTxn)} onClose={() => setVoidTxn(null)} onSaved={refresh} />}
      {journalEntity && <JournalDialog entity={journalEntity} onClose={() => setJournalEntity(null)} onSaved={refresh} />}
    </DashboardLayout>
  );
}
