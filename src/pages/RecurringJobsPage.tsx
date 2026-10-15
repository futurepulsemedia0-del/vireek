import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Repeat,
  Plus,
  Pencil,
  Pause,
  Play,
  Ban,
  Loader2,
  X,
  CalendarClock,
  SkipForward,
  ChevronDown,
  AlertTriangle,
  ShieldAlert,
  RefreshCw,
  Search,
  Receipt,
  DollarSign,
  CalendarCheck,
  FileText,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { supabase } from '@/lib/supabase';
import {
  FREQUENCY_PRESETS,
  autoInvoiceReadiness,
  cancelAgreement,
  describeFrequency,
  fetchCustomerOptions,
  fetchRecurringBundle,
  formatDateLabel,
  formatMoney,
  formatTimeLabel,
  friendlyRpcError,
  localTimeZone,
  monthlyValue,
  occurrenceDate,
  presetKeyFor,
  previewOccurrences,
  rescheduleOccurrence,
  saveAgreement,
  setAgreementStatus,
  skipOccurrence,
  todayISO,
  utcToZonedParts,
  validateAgreementInput,
  zonedToUtcISO,
  type AgreementInput,
  type CustomerOption,
  type IntervalUnit,
  type RecurringAgreement,
  type RecurringOccurrence,
} from '@/lib/recurringJobs';

type Technician = { id: string; member_name: string | null; member_email: string };
type Tab = 'active' | 'paused' | 'ended';

const techLabel = (t: Technician) => t.member_name?.trim() || t.member_email;

const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

function getTimeZones(current: string): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf?.('timeZone');
  const list = new Set<string>(supported && supported.length > 0 ? supported : FALLBACK_TIMEZONES);
  list.add('UTC');
  list.add(localTimeZone());
  if (current) list.add(current);
  return [...list].sort();
}

function formatInZone(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(iso).toLocaleString('en-US');
  }
}

// ============================================================
// SMALL PIECES
// ============================================================

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Repeat;
  label: string;
  value: string | number;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-text-secondary">{label}</p>
          <p className="truncate text-xl font-bold text-text-primary">{value}</p>
        </div>
      </div>
    </Card>
  );
}

function Chip({
  tone,
  children,
  title,
}: {
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
  children: ReactNode;
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-bg-tertiary text-text-secondary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
    accent: 'bg-accent/10 text-accent',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Modal({
  title,
  titleId,
  busy,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  titleId: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(!busy, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 24 }}
        className={`flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-primary shadow-xl sm:max-h-[90vh] sm:rounded-2xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="focus-ring rounded-lg p-2 text-text-secondary hover:text-text-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">{children}</div>
        <div className="border-t border-border px-5 py-4">{footer}</div>
      </motion.div>
    </div>
  );
}

// ============================================================
// AGREEMENT EDITOR
// ============================================================

interface FormState {
  id?: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  address: string;
  title: string;
  serviceType: string;
  notes: string;
  presetKey: string;
  intervalUnit: IntervalUnit;
  intervalCount: string;
  startDate: string;
  endDate: string;
  preferredTime: string;
  timezone: string;
  durationMinutes: string;
  technicianId: string;
  price: string;
  autoInvoice: boolean;
  leadTimeDays: string;
  scheduleLocked: boolean;
}

function blankForm(): FormState {
  const start = new Date();
  start.setDate(start.getDate() + 7);
  return {
    customerId: '',
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    address: '',
    title: '',
    serviceType: '',
    notes: '',
    presetKey: 'annual',
    intervalUnit: 'year',
    intervalCount: '1',
    startDate: todayISO(start),
    endDate: '',
    preferredTime: '09:00',
    timezone: localTimeZone(),
    durationMinutes: '60',
    technicianId: '',
    price: '',
    autoInvoice: false,
    leadTimeDays: '14',
    scheduleLocked: false,
  };
}

function formFromAgreement(a: RecurringAgreement): FormState {
  return {
    id: a.id,
    customerId: a.customer_id ?? '',
    customerName: a.customer_name,
    customerPhone: a.customer_phone ?? '',
    customerEmail: a.customer_email ?? '',
    address: a.address,
    title: a.title,
    serviceType: a.service_type ?? '',
    notes: a.notes ?? '',
    presetKey: presetKeyFor(a.interval_unit, a.interval_count),
    intervalUnit: a.interval_unit,
    intervalCount: String(a.interval_count),
    startDate: a.start_date,
    endDate: a.end_date ?? '',
    preferredTime: a.preferred_time.slice(0, 5),
    timezone: a.timezone,
    durationMinutes: String(a.duration_minutes),
    technicianId: a.preferred_technician_id ?? '',
    price: a.price_amount === null ? '' : String(a.price_amount),
    autoInvoice: a.auto_invoice,
    leadTimeDays: String(a.lead_time_days),
    scheduleLocked: a.next_occurrence_n > 0,
  };
}

function AgreementEditor({
  initial,
  technicians,
  customers,
  saving,
  onSave,
  onClose,
}: {
  initial: FormState;
  technicians: Technician[];
  customers: CustomerOption[];
  saving: boolean;
  onSave: (input: AgreementInput) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [submitted, setSubmitted] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const timeZones = useMemo(() => getTimeZones(initial.timezone), [initial.timezone]);

  const input: AgreementInput = useMemo(
    () => ({
      id: form.id,
      customerId: form.customerId || null,
      customerName: form.customerName,
      customerPhone: form.customerPhone,
      customerEmail: form.customerEmail,
      address: form.address,
      title: form.title,
      serviceType: form.serviceType,
      notes: form.notes,
      intervalUnit: form.intervalUnit,
      intervalCount: Number(form.intervalCount),
      startDate: form.startDate,
      endDate: form.endDate || null,
      preferredTime: form.preferredTime,
      timezone: form.timezone,
      durationMinutes: Number(form.durationMinutes),
      preferredTechnicianId: form.technicianId || null,
      priceAmount: form.price.trim() === '' ? null : Number(form.price),
      autoInvoice: form.autoInvoice,
      leadTimeDays: Number(form.leadTimeDays),
    }),
    [form],
  );

  const error = useMemo(() => validateAgreementInput(input), [input]);
  const readiness = useMemo(() => autoInvoiceReadiness(input), [input]);
  const preview = useMemo(() => {
    try {
      if (
        !Number.isInteger(input.intervalCount) ||
        input.intervalCount < 1 ||
        input.intervalCount > 52
      )
        return [];
      return previewOccurrences(
        {
          start_date: input.startDate,
          end_date: input.endDate,
          interval_unit: input.intervalUnit,
          interval_count: input.intervalCount,
        },
        0,
        4,
      );
    } catch {
      return [];
    }
  }, [input]);

  const pickCustomer = (id: string) => {
    const c = customers.find((x) => x.id === id);
    setForm((f) => ({
      ...f,
      customerId: id,
      customerName: c ? c.name : f.customerName,
      customerPhone: c?.phone ?? (c ? '' : f.customerPhone),
      customerEmail: c?.email ?? (c ? '' : f.customerEmail),
      address: c?.address ?? f.address,
    }));
  };

  const pickPreset = (key: string) => {
    if (key === 'custom') {
      setForm((f) => ({ ...f, presetKey: 'custom' }));
      return;
    }
    const preset = FREQUENCY_PRESETS.find((p) => p.key === key);
    if (preset)
      setForm((f) => ({
        ...f,
        presetKey: key,
        intervalUnit: preset.unit,
        intervalCount: String(preset.count),
      }));
  };

  const submit = () => {
    setSubmitted(true);
    if (error) return;
    onSave(input);
  };

  const selectClass =
    'focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:opacity-60';

  return (
    <Modal
      wide
      busy={saving}
      onClose={onClose}
      titleId="agreement-editor-title"
      title={form.id ? 'Edit agreement' : 'New maintenance agreement'}
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p
            role="alert"
            className={`text-xs ${submitted && error ? 'text-danger' : 'text-transparent'}`}
          >
            {submitted && error ? error : '.'}
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={saving}>
              {saving && <Loader2 size={14} className="animate-spin" />}
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create agreement'}
            </Button>
          </div>
        </div>
      }
    >
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Customer</h3>
        {customers.length > 0 && (
          <div>
            <label
              htmlFor="rj-customer"
              className="mb-1.5 block text-sm font-medium text-text-primary"
            >
              Existing customer
            </label>
            <select
              id="rj-customer"
              value={form.customerId}
              onChange={(e) => pickCustomer(e.target.value)}
              className={selectClass}
            >
              <option value="">Enter manually…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Name"
            required
            value={form.customerName}
            maxLength={120}
            onChange={(e) => set('customerName', e.target.value)}
          />
          <Input
            label="Phone"
            type="tel"
            value={form.customerPhone}
            onChange={(e) => set('customerPhone', e.target.value)}
          />
          <Input
            label="Email"
            type="email"
            value={form.customerEmail}
            onChange={(e) => set('customerEmail', e.target.value)}
          />
          <Input
            label="Service address"
            required
            value={form.address}
            maxLength={300}
            onChange={(e) => set('address', e.target.value)}
          />
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Agreement</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Title"
            required
            value={form.title}
            maxLength={120}
            placeholder="Annual HVAC tune-up"
            onChange={(e) => set('title', e.target.value)}
          />
          <Input
            label="Service type"
            value={form.serviceType}
            maxLength={80}
            placeholder="HVAC"
            onChange={(e) => set('serviceType', e.target.value)}
          />
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Schedule</h3>
        {form.scheduleLocked && (
          <p className="flex items-start gap-2 rounded-lg bg-bg-secondary px-3 py-2.5 text-xs text-text-secondary">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
            Visits already exist, so the start date and frequency are locked. To change them, cancel
            this agreement and create a new one.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="rj-frequency"
              className="mb-1.5 block text-sm font-medium text-text-primary"
            >
              Repeats
            </label>
            <select
              id="rj-frequency"
              value={form.presetKey}
              disabled={form.scheduleLocked}
              onChange={(e) => pickPreset(e.target.value)}
              className={selectClass}
            >
              {FREQUENCY_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </div>
          {form.presetKey === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Every"
                type="number"
                inputMode="numeric"
                min={1}
                max={52}
                disabled={form.scheduleLocked}
                value={form.intervalCount}
                onChange={(e) => set('intervalCount', e.target.value)}
              />
              <div>
                <label
                  htmlFor="rj-unit"
                  className="mb-1.5 block text-sm font-medium text-text-primary"
                >
                  Unit
                </label>
                <select
                  id="rj-unit"
                  value={form.intervalUnit}
                  disabled={form.scheduleLocked}
                  onChange={(e) => set('intervalUnit', e.target.value as IntervalUnit)}
                  className={selectClass}
                >
                  <option value="week">Week(s)</option>
                  <option value="month">Month(s)</option>
                  <option value="year">Year(s)</option>
                </select>
              </div>
            </div>
          )}
          <Input
            label="First visit"
            type="date"
            required
            disabled={form.scheduleLocked}
            min={form.id ? undefined : todayISO()}
            value={form.startDate}
            onChange={(e) => set('startDate', e.target.value)}
          />
          <Input
            label="Ends (optional)"
            type="date"
            value={form.endDate}
            onChange={(e) => set('endDate', e.target.value)}
            helperText="Leave empty to repeat until cancelled"
          />
          <Input
            label="Visit time"
            type="time"
            required
            value={form.preferredTime}
            onChange={(e) => set('preferredTime', e.target.value)}
          />
          <div>
            <label htmlFor="rj-tz" className="mb-1.5 block text-sm font-medium text-text-primary">
              Timezone
            </label>
            <select
              id="rj-tz"
              value={form.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              className={selectClass}
            >
              {timeZones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
        </div>
        {preview.length > 0 && (
          <p className="rounded-lg bg-bg-secondary px-3 py-2.5 text-xs text-text-secondary">
            <span className="font-medium text-text-primary">First visits: </span>
            {preview.map((p) => formatDateLabel(p.date)).join(' · ')}
          </p>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Dispatch</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="rj-tech" className="mb-1.5 block text-sm font-medium text-text-primary">
              Preferred technician
            </label>
            <select
              id="rj-tech"
              value={form.technicianId}
              onChange={(e) => set('technicianId', e.target.value)}
              className={selectClass}
            >
              <option value="">Unassigned</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {techLabel(t)}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Duration (min)"
            type="number"
            inputMode="numeric"
            min={15}
            max={1440}
            step={15}
            value={form.durationMinutes}
            onChange={(e) => set('durationMinutes', e.target.value)}
          />
          <Input
            label="Create job ahead (days)"
            type="number"
            inputMode="numeric"
            min={1}
            max={90}
            value={form.leadTimeDays}
            onChange={(e) => set('leadTimeDays', e.target.value)}
            helperText="How early each visit appears on the board"
          />
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">Billing</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Price per visit ($)"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={form.price}
            onChange={(e) => set('price', e.target.value)}
          />
          <div>
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Auto-invoice</span>
            <div className="flex h-[46px] items-center gap-3">
              <Switch
                checked={form.autoInvoice}
                onChange={(v) => set('autoInvoice', v)}
                label="Auto-invoice when each visit is completed"
                disabled={!readiness.ok && !form.autoInvoice}
              />
              <span className="text-sm text-text-secondary">
                {form.autoInvoice ? 'On completion' : 'Off'}
              </span>
            </div>
          </div>
        </div>
        {!readiness.ok && <p className="text-xs text-text-secondary">{readiness.problem}</p>}
        <Textarea
          label="Internal notes"
          rows={2}
          maxLength={1000}
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
        {form.id && (
          <p className="text-xs text-text-secondary">
            Changes apply to visits created from now on. Jobs already on the board keep their
            details.
          </p>
        )}
      </section>
    </Modal>
  );
}

// ============================================================
// SKIP / RESCHEDULE DIALOGS
// ============================================================

interface VisitTarget {
  agreement: RecurringAgreement;
  n: number;
  occurrence: RecurringOccurrence | null;
  label: string;
}

function SkipDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: {
  target: VisitTarget;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      busy={busy}
      onClose={onClose}
      titleId="skip-visit-title"
      title="Skip this visit?"
      footer={
        <div className="flex justify-end gap-3">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Keep visit
          </Button>
          <Button size="sm" onClick={() => onConfirm(reason)} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? 'Skipping…' : 'Skip visit'}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-text-secondary">
        {target.agreement.title} · {target.label}.{' '}
        {target.occurrence?.job_id ? 'The scheduled job will be cancelled. ' : ''}Later visits stay
        on schedule.
      </p>
      <Input
        label="Reason (optional)"
        value={reason}
        maxLength={300}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Customer is away"
      />
    </Modal>
  );
}

function RescheduleDialog({
  target,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  target: VisitTarget;
  busy: boolean;
  error: string | null;
  onConfirm: (iso: string) => void;
  onClose: () => void;
}) {
  const tz = target.agreement.timezone;
  const initial = target.occurrence
    ? utcToZonedParts(target.occurrence.scheduled_datetime, tz)
    : { date: todayISO(), time: target.agreement.preferred_time.slice(0, 5) };
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    if (!date || !time) {
      setLocalError('Choose a date and time.');
      return;
    }
    const iso = zonedToUtcISO(date, time, tz);
    if (new Date(iso).getTime() < Date.now() - 5 * 60_000) {
      setLocalError('Choose a time in the future.');
      return;
    }
    setLocalError(null);
    onConfirm(iso);
  };

  return (
    <Modal
      busy={busy}
      onClose={onClose}
      titleId="reschedule-visit-title"
      title={
        target.occurrence?.status === 'needs_attention' ? 'Choose a new time' : 'Reschedule visit'
      }
      footer={
        <div className="flex justify-end gap-3">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? 'Saving…' : 'Save new time'}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-text-secondary">
        {target.agreement.title} · {target.label}. Times are in {tz}.
      </p>
      {target.occurrence?.attention_reason && (
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
          {target.occurrence.attention_reason}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Date"
          type="date"
          value={date}
          min={todayISO()}
          onChange={(e) => setDate(e.target.value)}
        />
        <Input label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
      <p role="alert" className={`text-xs ${localError || error ? 'text-danger' : 'hidden'}`}>
        {localError ?? error}
      </p>
    </Modal>
  );
}

// ============================================================
// VISITS (per agreement)
// ============================================================

interface VisitRow {
  key: string;
  n: number;
  occurrence: RecurringOccurrence | null;
  date: string;
  when: string;
}

function buildVisits(a: RecurringAgreement, occurrences: RecurringOccurrence[]): VisitRow[] {
  const rows: VisitRow[] = occurrences
    .filter((o) => o.agreement_id === a.id)
    .map((o) => ({
      key: o.id,
      n: o.occurrence_n,
      occurrence: o,
      date: o.occurrence_date,
      when: formatInZone(o.scheduled_datetime, a.timezone),
    }));
  if (a.status === 'active') {
    const known = new Set(rows.map((r) => r.n));
    previewOccurrences(a, a.next_occurrence_n, 4)
      .filter((p) => !known.has(p.n))
      .forEach((p) =>
        rows.push({
          key: `preview-${p.n}`,
          n: p.n,
          occurrence: null,
          date: p.date,
          when: `${formatDateLabel(p.date)} · ${formatTimeLabel(a.preferred_time)}`,
        }),
      );
  }
  return rows.sort((x, y) => x.n - y.n);
}

function visitStatus(row: VisitRow): {
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
  label: string;
} {
  const o = row.occurrence;
  if (!o) return { tone: 'neutral', label: 'Upcoming' };
  if (o.status === 'skipped') return { tone: 'neutral', label: 'Skipped' };
  if (o.status === 'needs_attention') return { tone: 'danger', label: 'Needs a new time' };
  switch (o.job?.job_status) {
    case 'completed':
      return { tone: 'success', label: 'Completed' };
    case 'en_route':
    case 'in_progress':
      return { tone: 'accent', label: 'In progress' };
    case 'cancelled':
      return { tone: 'neutral', label: 'Job cancelled' };
    case 'no_show':
      return { tone: 'warning', label: 'No-show' };
    default:
      return { tone: 'accent', label: 'Scheduled' };
  }
}

function invoiceChip(o: RecurringOccurrence | null): ReactNode {
  if (!o || o.invoice_state === 'not_applicable') return null;
  const completed = o.job?.job_status === 'completed';
  switch (o.invoice_state) {
    case 'sent':
      return (
        <Chip tone="success">
          <Receipt size={12} /> Invoiced
        </Chip>
      );
    case 'sending':
      return (
        <Chip tone="accent">
          <Loader2 size={12} className="animate-spin" /> Sending invoice
        </Chip>
      );
    case 'blocked':
      return (
        <Chip tone="warning" title={o.invoice_error ?? undefined}>
          <AlertTriangle size={12} /> Invoice blocked
        </Chip>
      );
    case 'failed':
      return (
        <Chip tone="danger" title={o.invoice_error ?? undefined}>
          <AlertTriangle size={12} /> Invoice failed
        </Chip>
      );
    default:
      return (
        <Chip tone="neutral">
          <Receipt size={12} /> {completed ? 'Invoice queued' : 'Invoices on completion'}
        </Chip>
      );
  }
}

function canChangeVisit(row: VisitRow): { skip: boolean; reschedule: boolean } {
  const o = row.occurrence;
  if (!o) return { skip: true, reschedule: false };
  if (o.status === 'skipped') return { skip: false, reschedule: false };
  if (o.status === 'needs_attention') return { skip: true, reschedule: true };
  const scheduled = o.job?.job_status === 'scheduled';
  return { skip: scheduled, reschedule: scheduled };
}

function VisitList({
  agreement,
  visits,
  canManage,
  onSkip,
  onReschedule,
}: {
  agreement: RecurringAgreement;
  visits: VisitRow[];
  canManage: boolean;
  onSkip: (t: VisitTarget) => void;
  onReschedule: (t: VisitTarget) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const todayKey = todayISO();
  const upcomingStart = visits.findIndex((v) => v.date >= todayKey);
  const firstShown = showAll || upcomingStart < 0 ? 0 : Math.max(0, upcomingStart - 1);
  const shown = visits.slice(firstShown);

  if (visits.length === 0) {
    return (
      <p className="px-1 py-3 text-sm text-text-secondary">
        No visits scheduled.{' '}
        {agreement.status === 'active'
          ? 'The next visit will appear once the schedule reaches it.'
          : ''}
      </p>
    );
  }

  return (
    <div>
      {firstShown > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="focus-ring mb-2 text-xs font-medium text-accent hover:underline"
        >
          Show {firstShown} earlier visit{firstShown === 1 ? '' : 's'}
        </button>
      )}
      <ul className="divide-y divide-border">
        {shown.map((row) => {
          const status = visitStatus(row);
          const allowed = canChangeVisit(row);
          const target: VisitTarget = {
            agreement,
            n: row.n,
            occurrence: row.occurrence,
            label: row.when,
          };
          return (
            <li
              key={row.key}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">{row.when}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Chip tone={status.tone}>{status.label}</Chip>
                  {invoiceChip(row.occurrence)}
                  {row.occurrence?.skip_reason && (
                    <span className="text-xs text-text-secondary">
                      {row.occurrence.skip_reason}
                    </span>
                  )}
                </div>
              </div>
              {canManage && (allowed.reschedule || allowed.skip) && (
                <div className="flex shrink-0 gap-1">
                  {allowed.reschedule && (
                    <Button variant="ghost" size="sm" onClick={() => onReschedule(target)}>
                      <CalendarClock size={14} />{' '}
                      {row.occurrence?.status === 'needs_attention' ? 'Pick time' : 'Reschedule'}
                    </Button>
                  )}
                  {allowed.skip && (
                    <Button variant="ghost" size="sm" onClick={() => onSkip(target)}>
                      <SkipForward size={14} /> Skip
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ============================================================
// AGREEMENT CARD
// ============================================================

function AgreementCard({
  agreement,
  visits,
  technicianName,
  canManage,
  busy,
  onEdit,
  onToggle,
  onCancel,
  onSkip,
  onReschedule,
}: {
  agreement: RecurringAgreement;
  visits: VisitRow[];
  technicianName: string | null;
  canManage: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onCancel: () => void;
  onSkip: (t: VisitTarget) => void;
  onReschedule: (t: VisitTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const nextDate =
    agreement.status === 'active'
      ? previewOccurrences(agreement, agreement.next_occurrence_n, 1)[0]?.date
      : undefined;
  const nextVisit = visits.find((v) => v.occurrence?.status !== 'skipped' && v.date >= todayISO());
  const statusTone =
    agreement.status === 'active'
      ? 'success'
      : agreement.status === 'paused'
        ? 'warning'
        : 'neutral';
  const panelId = `visits-${agreement.id}`;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{agreement.title}</h3>
            <Chip tone={statusTone}>
              {agreement.status[0].toUpperCase() + agreement.status.slice(1)}
            </Chip>
          </div>
          <p className="mt-0.5 text-sm text-text-secondary">
            {agreement.customer_name} · {agreement.address}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-text-primary">
            {agreement.price_amount ? formatMoney(agreement.price_amount) : 'No price'}
          </p>
          <p className="text-xs text-text-secondary">per visit</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Chip tone="neutral">
          <Repeat size={12} />{' '}
          {describeFrequency(agreement.interval_unit, agreement.interval_count)}
        </Chip>
        <Chip tone="neutral">{formatTimeLabel(agreement.preferred_time)}</Chip>
        {technicianName && <Chip tone="neutral">{technicianName}</Chip>}
        {agreement.auto_invoice && (
          <Chip tone="accent">
            <Receipt size={12} /> Auto-invoice
          </Chip>
        )}
        {(nextVisit || nextDate) && agreement.status === 'active' && (
          <Chip tone="accent">
            <CalendarCheck size={12} /> Next:{' '}
            {nextVisit ? formatDateLabel(nextVisit.date) : formatDateLabel(nextDate as string)}
          </Chip>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="focus-ring flex items-center gap-1 rounded-lg px-1 py-1 text-sm font-medium text-text-secondary hover:text-text-primary"
        >
          <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />{' '}
          Visits
        </button>
        {canManage && agreement.status !== 'cancelled' && agreement.status !== 'completed' && (
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
              <Pencil size={14} /> Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={onToggle} disabled={busy}>
              {agreement.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
              {agreement.status === 'active' ? 'Pause' : 'Resume'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancel}
              disabled={busy}
              className="text-danger"
            >
              <Ban size={14} /> Cancel
            </Button>
          </div>
        )}
      </div>

      {open && (
        <div id={panelId} className="mt-2">
          <VisitList
            agreement={agreement}
            visits={visits}
            canManage={canManage && agreement.status !== 'cancelled'}
            onSkip={onSkip}
            onReschedule={onReschedule}
          />
        </div>
      )}
    </Card>
  );
}

// ============================================================
// PAGE
// ============================================================

export function RecurringJobsPage() {
  const navigate = useNavigate();
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  // Same derivation as NotificationsContext: tenant data is keyed by the OWNER's id.
  const accountOwnerId = isOwner ? (profile?.id ?? null) : (teamMember?.account_owner_id ?? null);
  // Agreements carry pricing and auto-invoicing, so they follow the billing permission.
  const canView = isOwner || permissions.can_view_billing || teamMember?.role === 'admin';
  const canManage = canView;

  const [agreements, setAgreements] = useState<RecurringAgreement[]>([]);
  const [occurrences, setOccurrences] = useState<RecurringOccurrence[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<Tab>('active');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingCancel, setPendingCancel] = useState<RecurringAgreement | null>(null);
  const [skipTarget, setSkipTarget] = useState<VisitTarget | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<VisitTarget | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadId = useRef(0);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    const id = ++loadId.current;
    setLoadError(false);
    try {
      const [bundle, techRes, customerList] = await Promise.all([
        fetchRecurringBundle(accountOwnerId),
        supabase
          .from('team_members')
          .select('id, member_name, member_email')
          .eq('account_owner_id', accountOwnerId)
          .eq('role', 'technician')
          .eq('invite_status', 'active')
          .order('member_name'),
        fetchCustomerOptions(accountOwnerId).catch(() => [] as CustomerOption[]),
      ]);
      if (techRes.error) throw techRes.error;
      if (id !== loadId.current) return;
      setAgreements(bundle.agreements);
      setOccurrences(bundle.occurrences);
      setTechnicians((techRes.data as Technician[]) ?? []);
      setCustomers(customerList);
    } catch {
      if (id === loadId.current) setLoadError(true);
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (canView) load();
    else setLoading(false);
  }, [canView, load]);

  const techNames = useMemo(
    () => new Map(technicians.map((t) => [t.id, techLabel(t)])),
    [technicians],
  );

  const visitsByAgreement = useMemo(() => {
    const map = new Map<string, VisitRow[]>();
    agreements.forEach((a) => map.set(a.id, buildVisits(a, occurrences)));
    return map;
  }, [agreements, occurrences]);

  const stats = useMemo(() => {
    const active = agreements.filter((a) => a.status === 'active');
    const today = todayISO();
    const horizon = todayISO(new Date(Date.now() + 30 * 86_400_000));
    let visits30 = 0;
    active.forEach((a) => {
      const list = visitsByAgreement.get(a.id) ?? [];
      visits30 += list.filter(
        (v) => v.occurrence?.status !== 'skipped' && v.date >= today && v.date <= horizon,
      ).length;
      // Visits beyond the lead window don't exist as rows yet — count them from the schedule.
      const known = new Set(list.map((v) => v.n));
      for (let n = a.next_occurrence_n; n < a.next_occurrence_n + 60; n += 1) {
        const date = occurrenceDate(a.start_date, a.interval_unit, a.interval_count, n);
        if (date > horizon || (a.end_date && date > a.end_date)) break;
        if (date >= today && !known.has(n) && !list.some((v) => v.n === n)) visits30 += 1;
      }
    });
    const attention = occurrences.filter(
      (o) => o.status === 'needs_attention' && active.some((a) => a.id === o.agreement_id),
    );
    const invoiceIssues = occurrences.filter(
      (o) => o.invoice_state === 'blocked' || o.invoice_state === 'failed',
    );
    return {
      active: active.length,
      visits30,
      attention,
      invoiceIssues,
      mrr: active.reduce((sum, a) => sum + monthlyValue(a), 0),
    };
  }, [agreements, occurrences, visitsByAgreement]);

  const counts = useMemo(
    () => ({
      active: agreements.filter((a) => a.status === 'active').length,
      paused: agreements.filter((a) => a.status === 'paused').length,
      ended: agreements.filter((a) => a.status === 'cancelled' || a.status === 'completed').length,
    }),
    [agreements],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agreements.filter((a) => {
      const inTab =
        tab === 'active'
          ? a.status === 'active'
          : tab === 'paused'
            ? a.status === 'paused'
            : a.status === 'cancelled' || a.status === 'completed';
      if (!inTab) return false;
      if (!q) return true;
      return [a.customer_name, a.title, a.address, a.service_type ?? ''].some((s) =>
        s.toLowerCase().includes(q),
      );
    });
  }, [agreements, tab, search]);

  const refresh = async () => {
    setLoading(true);
    await load();
  };

  const handleSave = async (input: AgreementInput) => {
    setSaving(true);
    try {
      await saveAgreement(accountOwnerId, input);
      toast(
        input.id
          ? 'Agreement updated.'
          : 'Agreement created. Visits appear as they come within the lead time.',
        'success',
      );
      setEditor(null);
      await load();
    } catch (e) {
      toast(
        e instanceof Error && /^[A-Z]/.test(e.message) && !/_/.test(e.message)
          ? e.message
          : friendlyRpcError(e),
        'error',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (a: RecurringAgreement) => {
    const next = a.status === 'active' ? 'paused' : 'active';
    setBusyId(a.id);
    const previous = agreements;
    setAgreements((list) => list.map((x) => (x.id === a.id ? { ...x, status: next } : x)));
    try {
      await setAgreementStatus(accountOwnerId, a.id, next);
      toast(
        next === 'paused'
          ? 'Agreement paused. Existing jobs stay on the board.'
          : 'Agreement resumed.',
        'success',
      );
    } catch (e) {
      setAgreements(previous);
      toast(friendlyRpcError(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleCancel = async () => {
    if (!pendingCancel) return;
    const target = pendingCancel;
    setBusyId(target.id);
    try {
      const result = await cancelAgreement(target.id);
      toast(
        `Agreement cancelled${result.jobs_cancelled ? ` and ${result.jobs_cancelled} upcoming job${result.jobs_cancelled === 1 ? '' : 's'} removed` : ''}.`,
        'success',
      );
      setPendingCancel(null);
      await load();
    } catch (e) {
      toast(friendlyRpcError(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleSkip = async (reason: string) => {
    if (!skipTarget) return;
    setActionBusy(true);
    try {
      await skipOccurrence(skipTarget.agreement.id, skipTarget.n, reason);
      toast('Visit skipped.', 'success');
      setSkipTarget(null);
      await load();
    } catch (e) {
      toast(friendlyRpcError(e), 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const handleReschedule = async (iso: string) => {
    if (!rescheduleTarget?.occurrence) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await rescheduleOccurrence(rescheduleTarget.occurrence.id, iso);
      toast('Visit rescheduled.', 'success');
      setRescheduleTarget(null);
      await load();
    } catch (e) {
      setActionError(friendlyRpcError(e));
    } finally {
      setActionBusy(false);
    }
  };

  const openReschedule = (t: VisitTarget) => {
    setActionError(null);
    setRescheduleTarget(t);
  };

  const attentionTargets = useMemo(
    () =>
      stats.attention
        .map((o) => {
          const agreement = agreements.find((a) => a.id === o.agreement_id);
          return agreement
            ? ({
                agreement,
                n: o.occurrence_n,
                occurrence: o,
                label: formatInZone(o.scheduled_datetime, agreement.timezone),
              } as VisitTarget)
            : null;
        })
        .filter((t): t is VisitTarget => t !== null),
    [stats.attention, agreements],
  );

  const header = (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Repeat size={16} />
            </span>
            <h1 className="text-2xl font-bold text-text-primary">Recurring Jobs</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Maintenance agreements that create jobs automatically, with skip, reschedule, and
            auto-invoicing.
          </p>
        </div>
      </div>
      {canView && canManage && !loadError && !loading && (
        <Button size="sm" onClick={() => setEditor(blankForm())}>
          <Plus size={16} /> New agreement
        </Button>
      )}
    </div>
  );

  let body: JSX.Element;
  if (!canView) {
    body = (
      <EmptyState
        icon={ShieldAlert}
        title="You don't have access to Recurring Jobs"
        description="Maintenance agreements include pricing and invoicing, so they need billing access. Ask the account owner to grant it."
        action={{ label: 'Back to dashboard', onClick: () => navigate('/dashboard') }}
      />
    );
  } else if (loading) {
    body = (
      <div className="space-y-6" aria-busy="true" aria-label="Loading recurring jobs">
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={3} rows={3} />
      </div>
    );
  } else if (loadError) {
    body = (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load recurring jobs"
        description="Check your connection and try again."
        action={{ label: 'Try again', onClick: refresh }}
      />
    );
  } else if (agreements.length === 0) {
    body = (
      <EmptyState
        icon={Repeat}
        title="Put your maintenance work on autopilot"
        description="Create an agreement once and Vireek schedules every visit, lets you skip or move any one of them, and invoices each when the job is done."
        action={
          canManage
            ? { label: 'Create your first agreement', onClick: () => setEditor(blankForm()) }
            : undefined
        }
      />
    );
  } else {
    body = (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={Repeat} label="Active agreements" value={stats.active} />
          <StatCard icon={CalendarCheck} label="Visits, next 30 days" value={stats.visits30} />
          <StatCard icon={AlertTriangle} label="Need a new time" value={stats.attention.length} />
          <StatCard
            icon={DollarSign}
            label="Recurring revenue / mo"
            value={formatMoney(stats.mrr)}
          />
        </div>

        {(attentionTargets.length > 0 || stats.invoiceIssues.length > 0) && (
          <Card className="border-warning/40 p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-text-primary">Needs your attention</h2>
                {attentionTargets.length > 0 && (
                  <ul className="mt-2 divide-y divide-border">
                    {attentionTargets.slice(0, 5).map((t) => (
                      <li
                        key={t.occurrence?.id}
                        className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <p className="text-sm text-text-primary">
                          {t.agreement.title} · {t.agreement.customer_name} ·{' '}
                          <span className="text-text-secondary">{t.label}</span>
                        </p>
                        {canManage && (
                          <Button variant="secondary" size="sm" onClick={() => openReschedule(t)}>
                            <CalendarClock size={14} /> Pick a new time
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {stats.invoiceIssues.length > 0 && (
                  <p className="mt-2 text-sm text-text-secondary">
                    {stats.invoiceIssues.length} invoice
                    {stats.invoiceIssues.length === 1 ? ' is' : 's are'} blocked or failed
                    {stats.invoiceIssues[0].invoice_error
                      ? `: ${stats.invoiceIssues[0].invoice_error}`
                      : '.'}{' '}
                    Open an agreement’s visits to see which.
                  </p>
                )}
              </div>
            </div>
          </Card>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div
            className="inline-flex rounded-xl border border-border bg-bg-secondary p-1"
            role="tablist"
            aria-label="Agreement status"
          >
            {(
              [
                ['active', 'Active'],
                ['paused', 'Paused'],
                ['ended', 'Ended'],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`focus-ring rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${tab === key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {label} <span className="opacity-70">{counts[key]}</span>
              </button>
            ))}
          </div>
          <div className="w-full sm:w-72">
            <Input
              icon={Search}
              aria-label="Search agreements"
              placeholder="Search customer, title, address"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={search.trim() ? 'Nothing matches your search' : `No ${tab} agreements`}
            description={
              search.trim()
                ? 'Try a different name, title, or address.'
                : tab === 'active'
                  ? 'Create an agreement to start scheduling visits automatically.'
                  : 'They will show up here when you change an agreement’s status.'
            }
            action={
              search.trim()
                ? { label: 'Clear search', onClick: () => setSearch('') }
                : canManage && tab === 'active'
                  ? { label: 'New agreement', onClick: () => setEditor(blankForm()) }
                  : undefined
            }
          />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {filtered.map((a) => (
              <AgreementCard
                key={a.id}
                agreement={a}
                visits={visitsByAgreement.get(a.id) ?? []}
                technicianName={
                  a.preferred_technician_id
                    ? (techNames.get(a.preferred_technician_id) ?? null)
                    : null
                }
                canManage={canManage}
                busy={busyId === a.id}
                onEdit={() => setEditor(formFromAgreement(a))}
                onToggle={() => handleToggle(a)}
                onCancel={() => setPendingCancel(a)}
                onSkip={(t) => setSkipTarget(t)}
                onReschedule={openReschedule}
              />
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <DashboardLayout activeLabel="Recurring Jobs">
      {header}
      {body}

      <AnimatePresence>
        {editor && (
          <AgreementEditor
            key={editor.id ?? 'new'}
            initial={editor}
            technicians={technicians}
            customers={customers}
            saving={saving}
            onSave={handleSave}
            onClose={() => setEditor(null)}
          />
        )}
        {skipTarget && (
          <SkipDialog
            key="skip"
            target={skipTarget}
            busy={actionBusy}
            onConfirm={handleSkip}
            onClose={() => setSkipTarget(null)}
          />
        )}
        {rescheduleTarget && (
          <RescheduleDialog
            key="reschedule"
            target={rescheduleTarget}
            busy={actionBusy}
            error={actionError}
            onConfirm={handleReschedule}
            onClose={() => setRescheduleTarget(null)}
          />
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={pendingCancel !== null}
        title="Cancel this agreement?"
        description={
          pendingCancel
            ? `“${pendingCancel.title}” for ${pendingCancel.customer_name} will stop creating visits, and any upcoming scheduled jobs will be cancelled. Completed visits and invoices are not affected.`
            : ''
        }
        confirmLabel="Yes, cancel agreement"
        onConfirm={handleCancel}
        onCancel={() => setPendingCancel(null)}
      />
    </DashboardLayout>
  );
}
