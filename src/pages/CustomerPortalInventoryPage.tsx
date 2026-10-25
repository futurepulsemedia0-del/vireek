import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, BellRing, CalendarPlus, Camera, CheckCircle2, ExternalLink, FileText, Home, Loader2, Package,
  Pencil, Plus, ScanLine, Search, ShieldCheck, Trash2, Wrench, WifiOff, X,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import {
  CATEGORY_KEYS, CATEGORY_LABELS, EMPTY_FORM, FILE_KIND_KEYS, FILE_KIND_LABELS, InventoryError, addInventoryReminder,
  applySuggestion, buildFields, deleteInventoryFile, deleteInventoryItem, downloadIcs, equipmentLabel, fetchPortalInventory,
  filterItems, formFromItem, formatBytes, formatDay, formatMoney, getInventoryFileUrl, isValidPortalToken, reminderAction,
  reminderStatus, saveInventoryItem, uploadInventoryFile, validateForm, warrantyStatus,
  type FormField, type InventoryCategory, type InventoryFile, type InventoryFileKind, type InventoryItem,
  type InventoryReminder, type ItemForm, type PortalInventory, type ReminderAction, type StoredRead,
} from '@/lib/homeInventory';

type LoadState = { kind: 'loading' } | { kind: 'ready'; data: PortalInventory } | { kind: 'unavailable' } | { kind: 'error' };
type Tone = 'success' | 'warn' | 'danger' | 'accent' | 'neutral';

const TONES: Record<Tone, string> = {
  success: 'bg-success-500/10 text-success',
  warn: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
  accent: 'bg-accent/10 text-accent',
  neutral: 'bg-bg-tertiary text-text-secondary',
};
const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark sm:p-6';
const INPUT = 'focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
const LABEL = 'mb-1 block text-xs font-medium text-text-secondary';
const WARNINGS: Record<string, string> = {
  ocr_unavailable: 'Reading documents is not available right now. Your file is saved — please type the details.',
  ocr_failed: 'We could not read that file. It is saved — please type the details.',
  ocr_rate_limited: 'You have read a lot of documents in a short time. Your file is saved — please type the details.',
};

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

function StatTile({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone === 'warn' ? 'text-warning-500' : 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof InventoryError ? e.message : 'Something went wrong. Please try again.';
}

// ============================================================
// REMINDERS
// ============================================================

function RemindersSection({ reminders, businessName, busyId, onAction }: {
  reminders: InventoryReminder[]; businessName: string | null; busyId: string | null; onAction: (r: InventoryReminder, a: ReminderAction) => void;
}) {
  if (reminders.length === 0) return null;
  return (
    <section aria-labelledby="inv-reminders" className={`${CARD} mb-6`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="inv-reminders" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <BellRing size={16} aria-hidden="true" /> Reminders
        </h2>
        <button type="button" onClick={() => downloadIcs(reminders, businessName)} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-accent">
          <CalendarPlus size={14} aria-hidden="true" /> Add to calendar
        </button>
      </div>
      <ul className="space-y-2">
        {reminders.map((r) => {
          const st = reminderStatus(r.due_date);
          const tone: Tone = st.state === 'overdue' ? 'danger' : st.state === 'due_soon' ? 'warn' : 'neutral';
          const when = st.state === 'overdue' ? `Overdue by ${Math.abs(st.days ?? 0)} day${Math.abs(st.days ?? 0) === 1 ? '' : 's'}` : st.days === 0 ? 'Due today' : formatDay(r.due_date);
          const busy = busyId === r.id;
          return (
            <li key={r.id} className="rounded-xl border border-border/60 p-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-text-primary">{r.title}</p>
                  <p className="mt-0.5 text-xs text-text-secondary">{r.item_name}</p>
                </div>
                <Pill tone={tone}>{when}</Pill>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => onAction(r, 'done')} className="focus-ring inline-flex min-h-[40px] items-center gap-1 rounded-lg bg-accent px-3 text-xs font-semibold text-white disabled:opacity-50">
                  <CheckCircle2 size={13} aria-hidden="true" /> Mark done
                </button>
                <button type="button" disabled={busy} onClick={() => onAction(r, 'snooze')} className="focus-ring min-h-[40px] rounded-lg border border-border px-3 text-xs font-medium text-text-secondary disabled:opacity-50">
                  Snooze 30 days
                </button>
                <button type="button" disabled={busy} onClick={() => onAction(r, 'dismiss')} className="focus-ring min-h-[40px] rounded-lg px-3 text-xs font-medium text-text-secondary disabled:opacity-50">
                  Dismiss
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ============================================================
// ITEM CARD
// ============================================================

function ItemCard({ item, reminders, busy, onEdit, onDelete, onUpload, onOpenFile, onDeleteFile }: {
  item: InventoryItem; reminders: InventoryReminder[]; busy: boolean;
  onEdit: () => void; onDelete: () => void; onUpload: (kind: InventoryFileKind, f: File) => void;
  onOpenFile: (f: InventoryFile) => void; onDeleteFile: (f: InventoryFile) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [kind, setKind] = useState<InventoryFileKind>('receipt');
  const fileRef = useRef<HTMLInputElement>(null);
  const w = warrantyStatus(item.warranty_expires_at);
  const wTone: Tone = w.state === 'active' ? 'success' : w.state === 'expiring' ? 'warn' : w.state === 'expired' ? 'danger' : 'neutral';
  const wLabel = w.state === 'none' ? 'No warranty on file' : w.state === 'expired' ? `Warranty ended ${formatDay(item.warranty_expires_at)}` : `Warranty until ${formatDay(item.warranty_expires_at)}`;
  const nextReminder = reminders.filter((r) => r.item_id === item.id).sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  const eq = item.equipment;
  const meta = [item.brand, item.model, item.location].filter(Boolean).join(' · ');

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) onUpload(kind, f);
  };

  return (
    <li className="rounded-xl border border-border/60 p-3.5" aria-busy={busy}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-text-primary">{item.name}</p>
          {meta && <p className="mt-0.5 break-words text-xs text-text-secondary">{meta}</p>}
        </div>
        <Pill tone={wTone}><ShieldCheck size={11} aria-hidden="true" /> {wLabel}</Pill>
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text-secondary">
        <div><dt className="inline">Category: </dt><dd className="inline text-text-primary">{CATEGORY_LABELS[item.category]}</dd></div>
        {item.purchase_date && <div><dt className="inline">Bought: </dt><dd className="inline text-text-primary">{formatDay(item.purchase_date)}</dd></div>}
        {item.purchase_price_cents !== null && <div><dt className="inline">Price: </dt><dd className="inline text-text-primary">{formatMoney(item.purchase_price_cents, item.currency)}</dd></div>}
        {item.retailer && <div><dt className="inline">From: </dt><dd className="inline text-text-primary">{item.retailer}</dd></div>}
        {item.serial_number && <div className="col-span-2"><dt className="inline">Serial: </dt><dd className="inline break-all text-text-primary">{item.serial_number}</dd></div>}
      </dl>

      {eq && (
        <div className="mt-2.5 rounded-lg bg-bg-tertiary p-2.5 text-xs text-text-secondary">
          <p className="flex items-center gap-1.5 font-medium text-text-primary"><Wrench size={12} aria-hidden="true" /> Linked to your service records: {equipmentLabel(eq)}</p>
          <p className="mt-1">
            {eq.last_service_date ? `Last serviced ${formatDay(eq.last_service_date)}` : 'No service visit recorded yet'}
            {eq.next_service_due ? ` · next service due ${formatDay(eq.next_service_due)}` : ''}
          </p>
          {eq.passport_code && (
            <a href={`/e/${eq.passport_code}`} target="_blank" rel="noopener noreferrer" className="focus-ring mt-1 inline-flex min-h-[32px] items-center gap-1 font-medium text-accent">
              View equipment passport <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
      {nextReminder && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-text-secondary"><BellRing size={12} aria-hidden="true" /> {nextReminder.title} · {formatDay(nextReminder.due_date)}</p>
      )}

      {item.files.length > 0 && (
        <ul className="mt-2.5 space-y-1" aria-label={`Files for ${item.name}`}>
          {item.files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 px-2.5 py-1.5">
              <button type="button" onClick={() => onOpenFile(f)} className="focus-ring flex min-h-[36px] min-w-0 items-center gap-2 text-left text-xs text-text-primary">
                <FileText size={13} className="shrink-0 text-text-secondary" aria-hidden="true" />
                <span className="min-w-0 truncate">{FILE_KIND_LABELS[f.kind]}{f.original_name ? ` — ${f.original_name}` : ''}</span>
                <span className="shrink-0 text-text-secondary">{formatBytes(f.byte_size)}</span>
              </button>
              <button type="button" onClick={() => onDeleteFile(f)} aria-label={`Delete ${FILE_KIND_LABELS[f.kind]}`} className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:text-danger">
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as InventoryFileKind)} aria-label={`Type of file to add to ${item.name}`} className="focus-ring min-h-[40px] rounded-lg border border-border bg-bg-primary px-2 text-xs text-text-primary">
          {FILE_KIND_KEYS.map((k) => <option key={k} value={k}>{FILE_KIND_LABELS[k]}</option>)}
        </select>
        <input ref={fileRef} type="file" accept="image/*,application/pdf,.heic,.heif" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onPick} />
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-text-primary disabled:opacity-50">
          <Camera size={13} aria-hidden="true" /> Add file
        </button>
        <button type="button" onClick={onEdit} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-text-secondary hover:text-text-primary">
          <Pencil size={13} aria-hidden="true" /> Edit
        </button>
        {confirming ? (
          <span className="ml-auto flex items-center gap-1" role="group" aria-label="Confirm delete">
            <button type="button" onClick={onDelete} className="focus-ring min-h-[40px] rounded-lg bg-danger px-3 text-xs font-semibold text-white">Delete item and its files</button>
            <button type="button" onClick={() => setConfirming(false)} className="focus-ring min-h-[40px] rounded-lg px-3 text-xs text-text-secondary">Cancel</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className="focus-ring ml-auto inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-text-secondary hover:text-danger">
            <Trash2 size={13} aria-hidden="true" /> Delete
          </button>
        )}
      </div>
    </li>
  );
}

// ============================================================
// ITEM FORM (create / edit) with scan-to-fill
// ============================================================

interface Pending { id: string; kind: InventoryFileKind; name: string }

function Field({ label, htmlFor, error, children, className = '' }: { label: string; htmlFor: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className={LABEL}>{label}</label>
      {children}
      {error && <p id={`${htmlFor}-err`} role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

function ItemForm({ token, data, editing, onCancel, onSaved, onFileAdded }: {
  token: string; data: PortalInventory; editing: InventoryItem | null; onCancel: () => void; onSaved: (msg: string) => void; onFileAdded: () => void;
}) {
  const [form, setForm] = useState<ItemForm>(() => (editing ? formFromItem(editing, data.reminders) : EMPTY_FORM));
  const [filled, setFilled] = useState<FormField[]>([]);
  const [pending, setPending] = useState<Pending[]>(() => (editing ? [] : data.unattached_files.map((f) => ({ id: f.id, kind: f.kind, name: f.original_name ?? FILE_KIND_LABELS[f.kind] }))));
  const [scanKind, setScanKind] = useState<InventoryFileKind>('receipt');
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [lowConfidence, setLowConfidence] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const issues = useMemo(() => validateForm(form), [form]);
  const err = (f: FormField) => (touched ? issues.find((i) => i.field === f)?.message : undefined);
  const set = (f: FormField, v: string) => {
    setForm((p) => ({ ...p, [f]: v }));
    setFilled((p) => p.filter((x) => x !== f));
  };
  const mark = (f: FormField) => (filled.includes(f) ? <span className="ml-1 font-normal text-accent">· read from your document, please check</span> : null);

  const onScan = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await uploadInventoryFile(token, file, { kind: scanKind, itemId: editing?.id ?? null });
      if (!editing) setPending((p) => (p.some((x) => x.id === res.file.id) ? p : [...p, { id: res.file.id, kind: res.file.kind, name: res.file.original_name ?? FILE_KIND_LABELS[res.file.kind] }]));
      else onFileAdded();
      const read: StoredRead | null = res.read;
      if (read && !read.suggestion.name && !read.suggestion.brand && !read.suggestion.model) {
        setNotice('We could not find product details in that photo. Try a closer, sharper photo — or type them in.');
      } else if (read) {
        const merged = applySuggestion(form, read.suggestion);
        setForm(merged.form);
        setFilled((p) => [...new Set([...p, ...merged.filled])]);
        setLowConfidence(read.low_confidence);
        setNotice(res.duplicate ? 'You already added this file — we reused it.' : merged.filled.length ? 'We filled in what we could read. Please check every field before saving.' : 'Nothing new to fill in from that file.');
      } else {
        setNotice((res.warning && WARNINGS[res.warning]) || 'File saved.');
      }
    } catch (x) {
      setError(errMsg(x));
    } finally {
      setScanning(false);
    }
  };

  const submit = async () => {
    setTouched(true);
    if (issues.length > 0) {
      setError('Please fix the highlighted fields.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const source = filled.length > 0 ? 'ocr' : 'customer';
      await saveInventoryItem(token, editing?.id ?? null, buildFields(form, editing ? (editing.source) : source), pending.map((p) => p.id));
      onSaved(editing ? 'Changes saved.' : 'Item added to your home inventory.');
    } catch (x) {
      setError(errMsg(x));
      setSaving(false);
    }
  };

  const cur = form.currency;
  return (
    <section aria-labelledby="inv-form-title" className={`${CARD} mb-6`}>
      <div className="mb-4 flex items-center justify-between">
        <h2 id="inv-form-title" className="text-base font-semibold text-text-primary">{editing ? 'Edit item' : 'Add an item'}</h2>
        <button type="button" onClick={onCancel} aria-label="Close form" className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:text-text-primary"><X size={16} aria-hidden="true" /></button>
      </div>

      <div className="mb-5 rounded-xl border border-dashed border-accent/40 bg-accent/5 p-3.5">
        <p className="flex items-center gap-2 text-sm font-medium text-text-primary"><ScanLine size={15} aria-hidden="true" /> Fill it in from a photo</p>
        <p className="mt-0.5 text-xs text-text-secondary">Photograph the label on the appliance, a receipt or the warranty card. We read it for you — you review everything before it is saved.</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <select value={scanKind} onChange={(e) => setScanKind(e.target.value as InventoryFileKind)} aria-label="What are you photographing?" className="focus-ring min-h-[44px] rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary">
            {FILE_KIND_KEYS.map((k) => <option key={k} value={k}>{FILE_KIND_LABELS[k]}</option>)}
          </select>
          <input ref={scanRef} type="file" accept="image/*,application/pdf,.heic,.heif" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void onScan(e)} />
          <Button type="button" size="sm" variant="secondary" disabled={scanning || saving} onClick={() => scanRef.current?.click()}>
            {scanning ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Camera size={15} aria-hidden="true" />}
            {scanning ? 'Reading…' : 'Take or choose a photo / PDF'}
          </Button>
        </div>
        <p className="sr-only" role="status" aria-live="polite">{scanning ? 'Reading your file' : ''}</p>
        {pending.length > 0 && (
          <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Files that will be attached">
            {pending.map((p) => (
              <li key={p.id} className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary">
                <FileText size={10} aria-hidden="true" /> {p.name}
              </li>
            ))}
          </ul>
        )}
        {notice && <p role="status" className="mt-2 text-xs text-text-primary">{notice}</p>}
        {lowConfidence && <p role="status" className="mt-1 text-xs text-warning-500">The photo was hard to read, so some details may be wrong.</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name *" htmlFor="inv-name" error={err('name')} className="sm:col-span-2">
          <input id="inv-name" className={INPUT} value={form.name} maxLength={120} onChange={(e) => set('name', e.target.value)} aria-invalid={!!err('name')} aria-describedby={err('name') ? 'inv-name-err' : undefined} placeholder="e.g. Upstairs air conditioner" />
          {mark('name')}
        </Field>
        <Field label="Category" htmlFor="inv-category">
          <select id="inv-category" className={INPUT} value={form.category} onChange={(e) => set('category', e.target.value as InventoryCategory)}>
            {CATEGORY_KEYS.map((k) => <option key={k} value={k}>{CATEGORY_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Room / location" htmlFor="inv-location">
          <input id="inv-location" className={INPUT} value={form.location} maxLength={80} onChange={(e) => set('location', e.target.value)} placeholder="Garage, kitchen…" />
        </Field>
        <Field label="Brand" htmlFor="inv-brand"><input id="inv-brand" className={INPUT} value={form.brand} maxLength={80} onChange={(e) => set('brand', e.target.value)} />{mark('brand')}</Field>
        <Field label="Model" htmlFor="inv-model"><input id="inv-model" className={INPUT} value={form.model} maxLength={80} onChange={(e) => set('model', e.target.value)} />{mark('model')}</Field>
        <Field label="Serial number" htmlFor="inv-serial" className="sm:col-span-2"><input id="inv-serial" className={INPUT} value={form.serial_number} maxLength={60} onChange={(e) => set('serial_number', e.target.value)} />{mark('serial_number')}</Field>
        <Field label="Purchase date" htmlFor="inv-pdate" error={err('purchase_date')}>
          <input id="inv-pdate" type="date" className={INPUT} value={form.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} aria-invalid={!!err('purchase_date')} />{mark('purchase_date')}
        </Field>
        <Field label="Store" htmlFor="inv-retailer"><input id="inv-retailer" className={INPUT} value={form.retailer} maxLength={120} onChange={(e) => set('retailer', e.target.value)} />{mark('retailer')}</Field>
        <Field label={`Price (${cur})`} htmlFor="inv-price" error={err('price')}>
          <input id="inv-price" inputMode="decimal" className={INPUT} value={form.price} onChange={(e) => set('price', e.target.value)} aria-invalid={!!err('price')} />{mark('price')}
        </Field>
        <Field label="Warranty length (months)" htmlFor="inv-wmonths" error={err('warranty_months')}>
          <input id="inv-wmonths" inputMode="numeric" className={INPUT} value={form.warranty_months} onChange={(e) => set('warranty_months', e.target.value)} aria-invalid={!!err('warranty_months')} />{mark('warranty_months')}
        </Field>
        <Field label="Warranty ends" htmlFor="inv-wend" error={err('warranty_expires_at')} className="sm:col-span-2">
          <input id="inv-wend" type="date" className={INPUT} value={form.warranty_expires_at} onChange={(e) => set('warranty_expires_at', e.target.value)} />
          <p className="mt-1 text-xs text-text-secondary">Leave empty to work it out from the purchase date and warranty length.</p>{mark('warranty_expires_at')}
        </Field>

        {data.equipment_options.length > 0 && (
          <Field label="Link to equipment your provider has serviced" htmlFor="inv-equipment" className="sm:col-span-2">
            <select id="inv-equipment" className={INPUT} value={form.equipment_id} onChange={(e) => set('equipment_id', e.target.value)}>
              <option value="">Not linked</option>
              {data.equipment_options.map((o) => <option key={o.id} value={o.id}>{equipmentLabel(o)}</option>)}
            </select>
            <p className="mt-1 text-xs text-text-secondary">Linking shows its service history and equipment passport here. A matching serial number is linked automatically.</p>
          </Field>
        )}

        <Field label="Maintenance every (months)" htmlFor="inv-mmonths" error={err('maintenance_months')}>
          <input id="inv-mmonths" inputMode="numeric" className={INPUT} value={form.maintenance_months} onChange={(e) => set('maintenance_months', e.target.value)} placeholder="e.g. 12" aria-invalid={!!err('maintenance_months')} />
        </Field>
        <Field label="Next maintenance due" htmlFor="inv-mdue" error={err('next_maintenance_due')}>
          <input id="inv-mdue" type="date" className={INPUT} value={form.next_maintenance_due} onChange={(e) => set('next_maintenance_due', e.target.value)} />
        </Field>
        <Field label="Notes" htmlFor="inv-notes" className="sm:col-span-2">
          <textarea id="inv-notes" rows={3} maxLength={1000} className={INPUT} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>

      {error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-danger/10 p-3 text-sm text-danger"><AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" /> {error}</p>}
      <p className="mt-4 text-xs text-text-secondary">Your inventory and files are private to you and visible to your service provider.</p>
      <div className="mt-3 flex gap-2">
        <Button type="button" onClick={() => void submit()} disabled={saving || scanning}>{saving && <Loader2 size={15} className="animate-spin" aria-hidden="true" />} {editing ? 'Save changes' : 'Add to inventory'}</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </section>
  );
}

// ============================================================
// PAGE
// ============================================================

export function CustomerPortalInventoryPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<InventoryCategory | 'all'>('all');
  const [mode, setMode] = useState<{ kind: 'none' } | { kind: 'new' } | { kind: 'edit'; id: string }>({ kind: 'none' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const valid = isValidPortalToken(token) ? token : null;

  const load = useCallback(async (silent = false) => {
    if (!valid) { setState({ kind: 'unavailable' }); return; }
    if (!silent) setState({ kind: 'loading' });
    const r = await fetchPortalInventory(valid);
    if (r.status === 'ok') setState({ kind: 'ready', data: r.data });
    else if (r.status === 'unavailable') setState({ kind: 'unavailable' });
    else if (!silent) setState({ kind: 'error' }); // a failed background refresh keeps what is on screen
  }, [valid]);

  useEffect(() => { void load(); }, [load]);

  const run = async (id: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusyId(id);
    setProblem(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
      await load(true);
      return true;
    } catch (x) {
      setProblem(errMsg(x));
      if (x instanceof InventoryError && x.code === 'unavailable') setState({ kind: 'unavailable' });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const openFile = async (f: InventoryFile) => {
    if (!valid) return;
    const win = window.open('', '_blank');
    try {
      const url = await getInventoryFileUrl(valid, f.id);
      if (win) win.location.href = url; else window.location.href = url;
    } catch (x) {
      win?.close();
      setProblem(errMsg(x));
    }
  };

  const backHref = valid ? `/portal/${valid}` : '/';
  const data = state.kind === 'ready' ? state.data : null;
  const items = useMemo(() => (data ? filterItems(data.items, query, category) : []), [data, query, category]);
  const editing = data && mode.kind === 'edit' ? data.items.find((i) => i.id === mode.id) ?? null : null;

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-8 sm:py-12">
        <div className="mx-auto w-full max-w-3xl">
          {state.kind === 'loading' && (
            <div role="status" aria-live="polite" className="space-y-6">
              <span className="sr-only">Loading your home inventory…</span>
              <SkeletonStatGrid count={4} />
              <SkeletonCardList count={3} rows={2} />
            </div>
          )}
          {state.kind === 'unavailable' && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" aria-hidden="true" />
              <h1 className="text-lg font-semibold text-text-primary">Home inventory not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">This link isn&apos;t valid, or the self-service portal isn&apos;t turned on for this business yet. Please call the business directly for help.</p>
            </div>
          )}
          {state.kind === 'error' && <EmptyStateError icon={WifiOff} title="Couldn't load your home inventory" description="Check your connection and try again. Your records are safe." onRetry={() => void load()} />}

          {data && valid && (
            <>
              <Link to={backHref} className="focus-ring mb-4 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
                <ArrowLeft size={15} aria-hidden="true" /> Back to your account
              </Link>
              <div className="mb-6 flex items-start justify-between gap-3">
                <div>
                  <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-text-primary"><Home size={22} aria-hidden="true" /> My home inventory</h1>
                  <p className="mt-1 text-sm text-text-secondary">Appliances, receipts, manuals and warranties in one place{data.business_name ? ` — shared with ${data.business_name}` : ''}.</p>
                </div>
                {mode.kind === 'none' && <Button type="button" size="sm" onClick={() => { setMode({ kind: 'new' }); setMessage(null); }}><Plus size={15} aria-hidden="true" /> Add item</Button>}
              </div>

              <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile label="Items" value={data.summary.item_count} />
                <StatTile label="Documents" value={data.summary.file_count} />
                <StatTile label="Active warranties" value={data.summary.active_warranties} />
                <StatTile label="Reminders due soon" value={data.summary.reminders_due} tone={data.summary.reminders_due > 0 ? 'warn' : 'neutral'} />
              </div>

              <div aria-live="polite">
                {message && <p role="status" className="mb-4 flex items-center gap-2 rounded-xl bg-success-500/10 p-3 text-sm text-success"><CheckCircle2 size={15} aria-hidden="true" /> {message}</p>}
                {problem && <p role="alert" className="mb-4 flex items-start gap-2 rounded-xl bg-danger/10 p-3 text-sm text-danger"><AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" /> {problem}</p>}
              </div>

              {(mode.kind === 'new' || (mode.kind === 'edit' && editing)) && (
                <ItemForm
                  key={mode.kind === 'edit' ? mode.id : 'new'}
                  token={valid}
                  data={data}
                  editing={editing}
                  onCancel={() => setMode({ kind: 'none' })}
                  onSaved={(m) => { setMode({ kind: 'none' }); setMessage(m); void load(true); }}
                  onFileAdded={() => void load(true)}
                />
              )}

              <RemindersSection
                reminders={data.reminders}
                businessName={data.business_name}
                busyId={busyId}
                onAction={(r, a) => void run(r.id, () => reminderAction(valid, r.id, a, a === 'snooze' ? 30 : undefined), a === 'done' ? 'Marked as done.' : a === 'snooze' ? 'Snoozed for 30 days.' : 'Reminder dismissed.')}
              />

              {data.items.length === 0 ? (
                <EmptyState
                  icon={Package}
                  title="Nothing here yet"
                  description="Add your appliances with a photo of the label or receipt. We'll keep the warranty dates and remind you before they run out."
                  action={{ label: 'Add your first item', onClick: () => setMode({ kind: 'new' }) }}
                />
              ) : (
                <section className={CARD} aria-labelledby="inv-items">
                  <h2 id="inv-items" className="sr-only">Items</h2>
                  <div className="mb-4 flex flex-col gap-2 sm:flex-row">
                    <div className="relative flex-1">
                      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
                      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, brand, model, room…" aria-label="Search your inventory" className={`${INPUT} pl-9`} />
                    </div>
                    <select value={category} onChange={(e) => setCategory(e.target.value as InventoryCategory | 'all')} aria-label="Filter by category" className={`${INPUT} sm:w-48`}>
                      <option value="all">All categories</option>
                      {CATEGORY_KEYS.map((k) => <option key={k} value={k}>{CATEGORY_LABELS[k]}</option>)}
                    </select>
                  </div>
                  {items.length === 0 ? (
                    <p className="py-6 text-center text-sm text-text-secondary">No items match your search.</p>
                  ) : (
                    <ul className="space-y-3">
                      {items.map((item) => (
                        <ItemCard
                          key={item.id}
                          item={item}
                          reminders={data.reminders}
                          busy={busyId === item.id}
                          onEdit={() => { setMode({ kind: 'edit', id: item.id }); setMessage(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                          onDelete={() => void run(item.id, () => deleteInventoryItem(valid, item.id), 'Item and its files deleted.')}
                          onUpload={(kind, file) => void run(item.id, async () => {
                            const r = await uploadInventoryFile(valid, file, { kind, itemId: item.id });
                            if (r.warning && WARNINGS[r.warning]) throw new InventoryError(WARNINGS[r.warning]);
                          }, 'File added.')}
                          onOpenFile={(f) => void openFile(f)}
                          onDeleteFile={(f) => void run(item.id, () => deleteInventoryFile(valid, f.id), 'File deleted.')}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              )}
              <ReminderAdder items={data.items} onAdd={(itemId, title, due, interval) => run('add', () => addInventoryReminder(valid, itemId, title, due, interval), 'Reminder added.')} busy={busyId === 'add'} />
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}

function ReminderAdder({ items, onAdd, busy }: { items: InventoryItem[]; onAdd: (itemId: string, title: string, due: string, interval: number | null) => Promise<boolean>; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState('');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [every, setEvery] = useState('');
  if (items.length === 0) return null;
  const everyOk = !every.trim() || (/^\d+$/.test(every.trim()) && +every >= 1 && +every <= 120);
  const ready = !!itemId && !!title.trim() && !!due && everyOk;
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="focus-ring mt-4 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-accent"><BellRing size={14} aria-hidden="true" /> Add your own reminder (e.g. change a filter)</button>;
  }
  return (
    <section aria-labelledby="inv-add-rem" className={`${CARD} mt-4`}>
      <h2 id="inv-add-rem" className="mb-3 text-sm font-semibold text-text-primary">New reminder</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Item" htmlFor="rem-item"><select id="rem-item" className={INPUT} value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">Choose…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
        <Field label="What to do" htmlFor="rem-title"><input id="rem-title" className={INPUT} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Change the filter" /></Field>
        <Field label="Due date" htmlFor="rem-due"><input id="rem-due" type="date" className={INPUT} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label="Repeat every (months, optional)" htmlFor="rem-every" error={everyOk ? undefined : 'Enter 1–120.'}><input id="rem-every" inputMode="numeric" className={INPUT} value={every} onChange={(e) => setEvery(e.target.value)} /></Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" disabled={!ready || busy} onClick={() => void onAdd(itemId, title, due, every.trim() ? Number(every) : null).then((ok) => { if (ok) { setOpen(false); setTitle(''); setDue(''); setEvery(''); } })}>Add reminder</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </section>
  );
}
