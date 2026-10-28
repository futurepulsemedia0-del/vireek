import { useMemo, useRef, useState } from 'react';
import { Landmark, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import { FIELD_LABELS, MAX_IMPORT_BYTES, detectMapping, mappingIssues, parseCsv, type ColumnMapping, type DateOrder, type FieldKey } from '@/lib/fuelCards';
import {
  CARD_STATUSES, EMPTY_CARD_FORM, FLAG_META, KIND_LABELS, MAX_IMPORT_ROWS, normalizeCardCsv, parseCardForm, parseFeedSettingsForm,
  type BankAccountLite, type CardFormValues, type CardImportRecord, type CardKind, type CardStatus, type CardTransaction, type CompanyCard,
} from '@/lib/cardFeed';
import {
  assignPurchases, deleteCard, deleteCardImport, importCardRows, importFromBank, saveCard, saveFeedSettings, syncFuelCards, waiveReceipts,
  type CardFeedOverview, type CardVehicle,
} from '@/lib/cardFeedApi';
import { Pill, Section, SelectField, formatDateTime } from '@/components/vehicles/shared';
import type { Technician } from '@/lib/vehicleManagement';

const techName = (t: Technician): string => t.member_name?.trim() || t.member_email;

// ---------------------------------------------------------------- Purchases ---

export function PurchasesPanel({ rows, vehicles, technicians, onChanged }: { rows: CardTransaction[]; vehicles: CardVehicle[]; technicians: Technician[]; onChanged: () => Promise<unknown> | void }) {
  const { toast } = useToast();
  const { currency } = useCurrency();
  const money = (c: number) => formatMoney(c / 100, currency);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tech, setTech] = useState('');
  const [veh, setVeh] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmWaive, setConfirmWaive] = useState(false);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...selected];

  const run = async (fn: () => Promise<number>, done: (n: number) => string) => {
    if (busy) return;
    setBusy(true);
    try {
      const n = await fn();
      toast(done(n), 'success');
      setSelected(new Set());
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return <EmptyState icon={Landmark} title="No card purchases yet" description="Import a CSV or sync your bank feed to see every card purchase matched to a technician." />;
  }

  return (
    <div className="space-y-3">
      {ids.length > 0 && (
        <div className="space-y-3 rounded-xl border border-border bg-bg-secondary p-3">
          <p className="text-sm font-medium text-text-primary">{ids.length} selected</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <SelectField label="Technician" value={tech} onChange={(e) => setTech(e.target.value)}>
              <option value="">— none —</option>
              {technicians.map((t) => <option key={t.id} value={t.id}>{techName(t)}</option>)}
            </SelectField>
            <SelectField label="Vehicle" value={veh} onChange={(e) => setVeh(e.target.value)}>
              <option value="">— none —</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </SelectField>
            <div className="flex items-end gap-2">
              <Button size="sm" disabled={busy} onClick={() => void run(() => assignPurchases(ids, tech || null, veh || null), (n) => (tech || veh ? `${n} assigned.` : `${n} set back to automatic matching.`))}>
                {tech || veh ? 'Assign' : 'Reset to automatic'}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1"><Input label="Waive receipt — reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></div>
            <Button size="sm" variant="secondary" disabled={busy || reason.trim().length < 3} onClick={() => setConfirmWaive(true)}>Waive receipt</Button>
          </div>
        </div>
      )}

      <ul className="divide-y divide-border rounded-xl border border-border bg-bg-secondary">
        {rows.map((t) => (
          <li key={t.id} className="flex items-start gap-3 px-3 py-3">
            <input type="checkbox" className="mt-1.5 h-5 w-5" checked={selected.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.merchant ?? 'purchase'}`} disabled={t.receipt_status === 'attached'} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-text-primary">{t.merchant ?? 'Card purchase'}</p>
                <p className="text-sm font-semibold text-text-primary">{money(t.amount_cents)}</p>
              </div>
              <p className="text-xs text-text-secondary">
                {formatDateTime(t.transaction_at)} · {KIND_LABELS[t.kind]}{t.card_last4 ? ` ••${t.card_last4}` : ''} · {t.technician_name ?? 'Unassigned'}{t.vehicle_label ? ` · ${t.vehicle_label}` : ''}
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {t.flags.map((f) => <span key={f} title={FLAG_META[f]?.help}><Pill tone={f === 'card_inactive' ? 'danger' : 'warning'}>{FLAG_META[f]?.label ?? f}</Pill></span>)}
                {t.assignment_locked && <Pill tone="info">Assigned by hand</Pill>}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={confirmWaive}
        title="Waive the receipt?"
        description="These purchases will no longer ask for a receipt. The reason is saved in the audit log."
        confirmLabel="Waive"
        onConfirm={async () => { setConfirmWaive(false); await run(() => waiveReceipts(ids, reason.trim()), (n) => `${n} receipt${n === 1 ? '' : 's'} waived.`); setReason(''); }}
        onCancel={() => setConfirmWaive(false)}
      />
    </div>
  );
}

// ------------------------------------------------------------------- Import ---

const CSV_FIELDS: FieldKey[] = ['timestamp', 'date', 'time', 'card', 'plate', 'merchant', 'amount', 'external_id', 'product', 'gallons'];

export function ImportPanel({ data, onChanged, onOpenSettings }: { data: CardFeedOverview; onChanged: () => Promise<unknown> | void; onOpenSettings: () => void }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ fileName: string; headers: string[]; body: string[][] } | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [order, setOrder] = useState<DateOrder | 'auto'>('auto');
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'csv' | 'bank' | null>(null);
  const [days, setDays] = useState('30');
  const [undo, setUndo] = useState<CardImportRecord | null>(null);

  const issues = mapping ? mappingIssues(mapping) : [];
  const normalized = useMemo(
    () => (parsed && mapping && issues.length === 0 ? normalizeCardCsv(parsed.body, mapping, order === 'auto' ? undefined : order) : null),
    [parsed, mapping, order, issues.length],
  );

  const reset = () => { setParsed(null); setMapping(null); setOrder('auto'); if (inputRef.current) inputRef.current.value = ''; };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setFileError(null);
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { reset(); setFileError('That file is larger than 5 MB. Split it into smaller files.'); return; }
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) { reset(); setFileError('We couldn’t find any data rows. Export your card transactions as CSV.'); return; }
      if (rows.length - 1 > MAX_IMPORT_ROWS) { reset(); setFileError(`This file has ${(rows.length - 1).toLocaleString()} rows. Import at most ${MAX_IMPORT_ROWS.toLocaleString()} at a time.`); return; }
      setParsed({ fileName: file.name, headers: rows[0].map((h, i) => h.trim() || `Column ${i + 1}`), body: rows.slice(1) });
      setMapping(detectMapping(rows[0]));
    } catch {
      reset(); setFileError('We couldn’t read that file. Make sure it is a CSV export.');
    }
  };

  const importCsv = async () => {
    if (!parsed || !normalized || normalized.rows.length === 0 || busy) return;
    setBusy('csv');
    try {
      const res = await importCardRows('csv', parsed.fileName, normalized.rows);
      toast(`${res.inserted.toLocaleString()} purchases imported · ${res.matched.toLocaleString()} matched · ${res.duplicates.toLocaleString()} duplicates skipped.`, 'success');
      reset();
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The import failed.', 'error');
    } finally { setBusy(null); }
  };

  const chosen = data.settings?.bank_account_ids ?? [];
  const syncBank = async () => {
    if (busy) return;
    setBusy('bank');
    try {
      const out = await importFromBank(data.bankAccounts, chosen, Number(days));
      if (!out.result) toast('No new card purchases found in the bank feed.', 'info');
      else toast(`${out.result.inserted.toLocaleString()} new purchases from your bank · ${out.result.matched.toLocaleString()} matched · ${out.result.duplicates.toLocaleString()} already imported.`, 'success');
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The bank sync failed.', 'error');
    } finally { setBusy(null); }
  };

  const doUndo = async () => {
    const target = undo; setUndo(null);
    if (!target) return;
    try { const n = await deleteCardImport(target.id); toast(`Import undone. ${n.toLocaleString()} purchases removed.`, 'success'); await onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not undo the import.', 'error'); }
  };

  return (
    <div className="space-y-4">
      <Section title="Bank feed (Plaid)">
        {chosen.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">{data.bankAccounts.length === 0 ? 'Connect a bank in Bank Intelligence first, then choose the card accounts to use here.' : 'Choose which connected card accounts to use as feeds in Settings.'}</p>
            {data.bankAccounts.length > 0 && <Button size="sm" variant="secondary" onClick={onOpenSettings}>Choose accounts</Button>}
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <SelectField label="Look back" value={days} onChange={(e) => setDays(e.target.value)}>
                {['14', '30', '60', '90'].map((d) => <option key={d} value={d}>{d} days</option>)}
              </SelectField>
            </div>
            <Button onClick={() => void syncBank()} disabled={busy !== null}>{busy === 'bank' ? 'Syncing…' : `Sync ${chosen.length} account${chosen.length === 1 ? '' : 's'}`}</Button>
            <p className="text-xs text-text-secondary">{data.settings?.last_bank_import_at ? `Last synced ${formatDateTime(data.settings.last_bank_import_at)}. ` : ''}Already-imported purchases are skipped.</p>
          </div>
        )}
      </Section>

      <Section title="Import a CSV">
        <p className="mb-3 text-sm text-text-secondary">Upload an export from your card provider (fuel or expense cards). Needs a date, an amount and the card’s last 4 digits or a licence plate.</p>
        <label htmlFor="card-file" className="flex min-h-[96px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-bg-primary px-4 py-6 text-center text-sm text-text-secondary hover:border-accent/50">
          <Upload size={22} aria-hidden="true" />
          <span className="font-medium text-text-primary">{parsed ? parsed.fileName : 'Choose a CSV file'}</span>
          <span className="text-xs">Up to {MAX_IMPORT_ROWS.toLocaleString()} rows · 5 MB</span>
          <input id="card-file" ref={inputRef} type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} className="sr-only" />
        </label>
        {fileError && <p role="alert" className="mt-2 text-sm text-danger">{fileError}</p>}

        {parsed && mapping && (
          <div className="mt-4 space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {CSV_FIELDS.map((k) => (
                <SelectField key={k} label={FIELD_LABELS[k]} value={mapping[k] == null ? '' : String(mapping[k])} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
                  <option value="">— not in file —</option>
                  {parsed.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </SelectField>
              ))}
              <SelectField label="Date order" value={order} onChange={(e) => setOrder(e.target.value as DateOrder | 'auto')}>
                <option value="auto">Detect automatically</option>
                <option value="mdy">Month / Day / Year</option>
                <option value="dmy">Day / Month / Year</option>
              </SelectField>
            </div>
            {issues.length > 0 && <ul role="alert" className="list-disc ps-5 text-sm text-danger">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
            {normalized && (
              <div className="rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary">
                <p><span className="font-semibold text-text-primary">{normalized.rows.length.toLocaleString()}</span> purchases ready · {normalized.rows.filter((r) => r.kind === 'fuel').length.toLocaleString()} fuel · {normalized.rejected.length.toLocaleString()} skipped (credits, blanks, invalid)</p>
                {normalized.rejected.slice(0, 3).map((r) => <p key={r.line} className="text-xs">Line {r.line}: {r.reason}</p>)}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={reset} disabled={busy !== null}>Cancel</Button>
              <Button onClick={() => void importCsv()} disabled={!normalized || normalized.rows.length === 0 || busy !== null}>{busy === 'csv' ? 'Importing…' : 'Import'}</Button>
            </div>
          </div>
        )}
      </Section>

      {data.imports.length > 0 && (
        <Section title="Recent imports">
          <ul className="divide-y divide-border">
            {data.imports.map((im) => (
              <li key={im.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{im.file_name}</p>
                  <p className="text-xs text-text-secondary">{formatDateTime(im.created_at)} · {im.source === 'plaid' ? 'Bank feed' : 'CSV'} · {im.inserted_count} new · {im.duplicate_count} duplicates · {im.unmatched_count} unassigned</p>
                </div>
                <Button size="sm" variant="ghost" aria-label={`Undo import ${im.file_name}`} onClick={() => setUndo(im)}><Trash2 size={16} /></Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <ConfirmDialog open={undo !== null} title="Undo this import?" description="Its purchases will be removed. This is refused if a receipt was already filed for one of them." confirmLabel="Undo import" onConfirm={doUndo} onCancel={() => setUndo(null)} />
    </div>
  );
}

// -------------------------------------------------------------------- Cards ---

export function CardsPanel({ cards, vehicles, technicians, unknownLast4, onChanged }: { cards: CompanyCard[]; vehicles: CardVehicle[]; technicians: Technician[]; unknownLast4: string[]; onChanged: () => Promise<unknown> | void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<{ id: string | null; form: CardFormValues } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<CompanyCard | null>(null);

  const open = (c?: CompanyCard, last4?: string) =>
    { setErrors({}); setEditing({ id: c?.id ?? null, form: c ? { label: c.label, kind: c.kind, provider: c.provider === 'other' ? '' : c.provider, last4: c.card_last4, vehicle_id: c.vehicle_id ?? '', technician_id: c.technician_id ?? '', status: c.status, notes: c.notes ?? '' } : { ...EMPTY_CARD_FORM, last4: last4 ?? '' } }); };
  const set = <K extends keyof CardFormValues>(k: K, v: CardFormValues[K]) => setEditing((e) => (e ? { ...e, form: { ...e.form, [k]: v } } : e));

  const submit = async () => {
    if (!editing || busy) return;
    const parsed = parseCardForm(editing.form);
    if (!parsed.ok) { setErrors(parsed.errors); return; }
    setBusy(true);
    try { await saveCard(parsed.value, editing.id); toast('Card saved. Recent purchases were re-matched.', 'success'); setEditing(null); await onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save the card.', 'error'); }
    finally { setBusy(false); }
  };
  const syncFuel = async () => {
    try { const n = await syncFuelCards(); toast(n > 0 ? `${n} fuel card${n === 1 ? '' : 's'} copied.` : 'Your fuel cards are already here.', 'success'); await onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not copy fuel cards.', 'error'); }
  };
  const remove = async () => {
    const t = removing; setRemoving(null);
    if (!t) return;
    try { await deleteCard(t.id); toast('Card deleted.', 'success'); await onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not delete the card.', 'error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">Tell Vireek which of your existing cards belongs to whom. Only the last 4 digits are stored. Vireek does not issue cards.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => void syncFuel()}>Copy fuel cards</Button>
          <Button size="sm" onClick={() => open()}>Add card</Button>
        </div>
      </div>

      {unknownLast4.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-text-primary">
          Purchases were found for cards that aren’t registered:{' '}
          {unknownLast4.map((l) => <button key={l} type="button" className="focus-ring me-2 rounded-md px-1 font-medium text-accent underline" onClick={() => open(undefined, l)}>••{l}</button>)}
        </div>
      )}

      {cards.length === 0 ? (
        <EmptyState icon={Landmark} title="No cards yet" description="Add a card (or copy your fuel cards) so purchases are matched to the right technician and vehicle." />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-bg-secondary">
          {cards.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{c.label} <span className="text-text-secondary">••{c.card_last4}</span></p>
                <p className="text-xs text-text-secondary">
                  {KIND_LABELS[c.kind]} · {c.provider} · {technicians.find((t) => t.id === c.technician_id) ? techName(technicians.find((t) => t.id === c.technician_id) as Technician) : 'No holder'}
                  {c.vehicle_id ? ` · ${vehicles.find((v) => v.id === c.vehicle_id)?.label ?? 'Vehicle'}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={c.status === 'active' ? 'success' : 'danger'}>{c.status}</Pill>
                <Button size="sm" variant="ghost" onClick={() => open(c)}>Edit</Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${c.label}`} onClick={() => setRemoving(c)}><Trash2 size={16} /></Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={editing.id ? 'Edit card' : 'Add card'}>
          <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-bg-primary p-5 sm:rounded-2xl">
            <h2 className="mb-4 text-lg font-semibold text-text-primary">{editing.id ? 'Edit card' : 'Add card'}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Name" value={editing.form.label} onChange={(e) => set('label', e.target.value)} error={errors.label} />
              <Input label="Last 4 digits" inputMode="numeric" maxLength={4} value={editing.form.last4} onChange={(e) => set('last4', e.target.value.replace(/\D/g, ''))} error={errors.last4} />
              <SelectField label="Type" value={editing.form.kind} onChange={(e) => set('kind', e.target.value as CardKind)}>
                <option value="expense">Expense card</option><option value="fuel">Fuel card</option>
              </SelectField>
              <Input label="Provider (optional)" value={editing.form.provider} onChange={(e) => set('provider', e.target.value)} error={errors.provider} />
              <SelectField label="Technician" value={editing.form.technician_id} onChange={(e) => set('technician_id', e.target.value)}>
                <option value="">— none —</option>{technicians.map((t) => <option key={t.id} value={t.id}>{techName(t)}</option>)}
              </SelectField>
              <SelectField label="Vehicle" value={editing.form.vehicle_id} onChange={(e) => set('vehicle_id', e.target.value)}>
                <option value="">— none —</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </SelectField>
              <SelectField label="Status" value={editing.form.status} onChange={(e) => set('status', e.target.value as CardStatus)}>
                {CARD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </SelectField>
            </div>
            <div className="mt-3"><Input label="Notes (optional)" value={editing.form.notes} onChange={(e) => set('notes', e.target.value)} error={errors.notes} /></div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
              <Button onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save card'}</Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog open={removing !== null} title="Delete this card?" description="Cards that already have purchases can’t be deleted — set them to Cancelled instead." confirmLabel="Delete" onConfirm={remove} onCancel={() => setRemoving(null)} />
    </div>
  );
}

// ----------------------------------------------------------------- Settings ---

export function SettingsPanel({ data, onChanged }: { data: CardFeedOverview; onChanged: () => Promise<unknown> | void }) {
  const { toast } = useToast();
  const s = data.settings;
  const [over, setOver] = useState(String((s?.receipt_required_over_cents ?? 0) / 100));
  const [days, setDays] = useState(String(s?.receipt_due_days ?? 7));
  const [accounts, setAccounts] = useState<Set<string>>(new Set(s?.bank_account_ids ?? []));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const cardAccounts: BankAccountLite[] = data.bankAccounts;

  const save = async () => {
    const parsed = parseFeedSettingsForm({ over, days });
    if (!parsed.ok) { setErrors(parsed.errors); return; }
    setErrors({}); setBusy(true);
    try {
      await saveFeedSettings({ ...parsed.value, bank_account_ids: [...accounts] }, s?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
      toast('Settings saved. They apply to new imports.', 'success');
      await onChanged();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save the settings.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Section title="Receipt rules">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Require a receipt above ($)" inputMode="decimal" value={over} onChange={(e) => setOver(e.target.value)} error={errors.over} helperText="0 = every purchase needs a receipt." />
        <Input label="Receipt due within (days)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} error={errors.days} helperText="Counted from the purchase date." />
      </div>
      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-text-primary">Bank accounts used as card feeds</legend>
        {cardAccounts.length === 0 ? (
          <p className="mt-1 text-sm text-text-secondary">No connected bank accounts. Connect a bank in Bank Intelligence to import card purchases automatically.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {cardAccounts.map((a) => (
              <li key={a.id}>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-text-primary">
                  <input type="checkbox" className="h-5 w-5" checked={accounts.has(a.id)} onChange={() => setAccounts((cur) => { const n = new Set(cur); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} />
                  {a.name}{a.mask ? ` ••${a.mask}` : ''} <span className="text-xs text-text-secondary">({a.account_type})</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div className="mt-5 flex justify-end"><Button onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button></div>
    </Section>
  );
}
