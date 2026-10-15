import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  KIND_LABELS,
  LABEL_LIMIT,
  NOTE_LIMIT,
  TIME_OFF_KINDS,
  formatRange,
  isValidIsoDate,
  overlappingBlackouts,
  overlappingTimeOff,
  previewConflicts,
  technicianLabel,
  validateBlackout,
  validateTimeOff,
  type BlackoutDraft,
  type BlackoutEntry,
  type ScheduledJob,
  type TechnicianLite,
  type TimeOffDraft,
  type TimeOffEntry,
  type TimeOffKind,
} from '@/lib/timeOff';

const SELECT_CLASS =
  'focus-ring w-full rounded-xl border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

function Warning({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------

interface TimeOffFormProps {
  technicians: TechnicianLite[];
  jobs: ScheduledJob[];
  existing: TimeOffEntry[];
  initial: Partial<TimeOffDraft>;
  onSubmit: (draft: TimeOffDraft) => Promise<boolean>;
  onCancel: () => void;
}

export function TimeOffForm({ technicians, jobs, existing, initial, onSubmit, onCancel }: TimeOffFormProps) {
  const [draft, setDraft] = useState<TimeOffDraft>(() => ({
    technician_id: initial.technician_id ?? '',
    kind: initial.kind ?? 'pto',
    start_date: initial.start_date ?? '',
    end_date: initial.end_date ?? initial.start_date ?? '',
    note: '',
  }));
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);

  const errors = validateTimeOff(draft);
  const visible = showErrors ? errors : {};
  const rangeOk = isValidIsoDate(draft.start_date) && isValidIsoDate(draft.end_date) && draft.end_date >= draft.start_date;
  const conflicts = useMemo(
    () => (draft.technician_id && rangeOk ? previewConflicts(jobs, draft.start_date, draft.end_date, draft.technician_id) : []),
    [jobs, draft.technician_id, draft.start_date, draft.end_date, rangeOk],
  );
  const overlaps = useMemo(
    () => (draft.technician_id && rangeOk ? overlappingTimeOff(existing, draft.technician_id, draft.start_date, draft.end_date) : []),
    [existing, draft.technician_id, draft.start_date, draft.end_date, rangeOk],
  );

  const patch = (changes: Partial<TimeOffDraft>) => setDraft((d) => ({ ...d, ...changes }));

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    const ok = await onSubmit(draft);
    if (!ok) setBusy(false);
  };

  return (
    <section aria-label="Add time off" className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
      <h2 className="text-base font-semibold text-text-primary">Add time off</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="timeoff-tech" className="mb-1.5 block text-sm font-medium text-text-primary">
            Technician
          </label>
          <select
            id="timeoff-tech"
            className={`${SELECT_CLASS} ${visible.technician_id ? 'border-danger' : 'border-border'}`}
            value={draft.technician_id}
            aria-invalid={Boolean(visible.technician_id)}
            disabled={busy}
            onChange={(e) => patch({ technician_id: e.target.value })}
          >
            <option value="">Choose a technician</option>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {technicianLabel(t)}
              </option>
            ))}
          </select>
          {visible.technician_id && (
            <p className="mt-1 text-sm text-danger" role="alert">
              {visible.technician_id}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="timeoff-kind" className="mb-1.5 block text-sm font-medium text-text-primary">
            Type
          </label>
          <select
            id="timeoff-kind"
            className={`${SELECT_CLASS} border-border`}
            value={draft.kind}
            disabled={busy}
            onChange={(e) => patch({ kind: e.target.value as TimeOffKind })}
          >
            {TIME_OFF_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <Input
          label="First day off"
          type="date"
          required
          value={draft.start_date}
          disabled={busy}
          error={visible.start_date}
          onChange={(e) => patch({ start_date: e.target.value, end_date: !draft.end_date || draft.end_date < e.target.value ? e.target.value : draft.end_date })}
        />
        <Input
          label="Last day off"
          type="date"
          required
          value={draft.end_date}
          min={draft.start_date || undefined}
          disabled={busy}
          error={visible.end_date}
          onChange={(e) => patch({ end_date: e.target.value })}
        />
      </div>
      <Textarea
        label="Note (optional)"
        rows={2}
        maxLength={NOTE_LIMIT}
        value={draft.note}
        disabled={busy}
        error={visible.note}
        onChange={(e) => patch({ note: e.target.value })}
        placeholder="e.g. Family trip"
      />

      {conflicts.length > 0 && (
        <Warning>
          {plural(conflicts.length, 'scheduled job falls', 'scheduled jobs fall')} in this range. They stay assigned until you move them in Dispatch, and the
          calendar will flag them.
        </Warning>
      )}
      {overlaps.length > 0 && (
        <Warning>
          This technician already has time off on {formatRange(overlaps[0].start_date, overlaps[0].end_date)}. Saving adds another entry.
        </Warning>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Add time off'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

interface BlackoutFormProps {
  jobs: ScheduledJob[];
  existing: BlackoutEntry[];
  initial: Partial<BlackoutDraft>;
  onSubmit: (draft: BlackoutDraft) => Promise<boolean>;
  onCancel: () => void;
}

export function BlackoutForm({ jobs, existing, initial, onSubmit, onCancel }: BlackoutFormProps) {
  const [draft, setDraft] = useState<BlackoutDraft>(() => ({
    label: initial.label ?? '',
    start_date: initial.start_date ?? '',
    end_date: initial.end_date ?? initial.start_date ?? '',
  }));
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);

  const errors = validateBlackout(draft);
  const visible = showErrors ? errors : {};
  const rangeOk = isValidIsoDate(draft.start_date) && isValidIsoDate(draft.end_date) && draft.end_date >= draft.start_date;
  const conflicts = useMemo(
    () => (rangeOk ? previewConflicts(jobs, draft.start_date, draft.end_date, null) : []),
    [jobs, draft.start_date, draft.end_date, rangeOk],
  );
  const overlaps = useMemo(
    () => (rangeOk ? overlappingBlackouts(existing, draft.start_date, draft.end_date) : []),
    [existing, draft.start_date, draft.end_date, rangeOk],
  );
  const patch = (changes: Partial<BlackoutDraft>) => setDraft((d) => ({ ...d, ...changes }));

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    const ok = await onSubmit(draft);
    if (!ok) setBusy(false);
  };

  return (
    <section aria-label="Add company blackout" className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Add company blackout</h2>
        <p className="mt-1 text-sm text-text-secondary">No technician can be dispatched on these days, whether manually or by auto-assign.</p>
      </div>
      <Input
        label="Name"
        required
        maxLength={LABEL_LIMIT}
        value={draft.label}
        disabled={busy}
        error={visible.label}
        onChange={(e) => patch({ label: e.target.value })}
        placeholder="e.g. Thanksgiving"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="First day"
          type="date"
          required
          value={draft.start_date}
          disabled={busy}
          error={visible.start_date}
          onChange={(e) => patch({ start_date: e.target.value, end_date: !draft.end_date || draft.end_date < e.target.value ? e.target.value : draft.end_date })}
        />
        <Input
          label="Last day"
          type="date"
          required
          value={draft.end_date}
          min={draft.start_date || undefined}
          disabled={busy}
          error={visible.end_date}
          onChange={(e) => patch({ end_date: e.target.value })}
        />
      </div>

      {conflicts.length > 0 && (
        <Warning>
          {plural(conflicts.length, 'assigned job falls', 'assigned jobs fall')} in this range. They stay assigned until you move them in Dispatch.
        </Warning>
      )}
      {overlaps.length > 0 && <Warning>This overlaps "{overlaps[0].label}" ({formatRange(overlaps[0].start_date, overlaps[0].end_date)}).</Warning>}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Add blackout'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
