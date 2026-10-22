import { useMemo, useState, type FormEvent } from 'react';
import { BellRing, CalendarPlus, ClipboardCheck } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { FormShell, Pill, Segmented, SelectField, employeeName, type HrCtx, type Tone } from '@/components/hr/HrUi';
import { useToast } from '@/contexts/ToastContext';
import {
  COMPETENCIES,
  RATING_LABELS,
  REVIEW_KIND_LABELS,
  REVIEW_NOTES_LIMIT,
  REVIEW_TEXT_LIMIT,
  SCHEDULABLE_REVIEW_KINDS,
  addDays,
  averageRating,
  buildReviewReminders,
  formatDay,
  relativeDays,
  reviewDueState,
  suggestOverall,
  validateReview,
  validateScheduleReview,
  type Competency,
  type Review,
  type ReviewDraft,
  type ReviewDueState,
  type ReviewKind,
} from '@/lib/hrOnboarding';
import { completeReview, describeHrError, scheduleReview, skipReview } from '@/lib/hrOnboardingApi';

const STATE_TONE: Record<ReviewDueState, Tone> = { completed: 'success', skipped: 'neutral', overdue: 'danger', due_soon: 'warning', upcoming: 'neutral' };
const STATE_LABEL: Record<ReviewDueState, string> = { completed: 'Completed', skipped: 'Skipped', overdue: 'Overdue', due_soon: 'Due soon', upcoming: 'Scheduled' };

type Filter = 'scheduled' | 'completed' | 'all';

export function ReviewsPanel({ ctx }: { ctx: HrCtx }) {
  const { data, today, ownerId, patch } = ctx;
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>('scheduled');
  const [employee, setEmployee] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reminders = useMemo(() => buildReviewReminders(data.reviews, today), [data.reviews, today]);
  const rows = useMemo(
    () =>
      data.reviews
        .filter((r) => (employee ? r.employee_id === employee : true))
        .filter((r) => (filter === 'all' ? true : filter === 'scheduled' ? r.status === 'scheduled' : r.status === 'completed'))
        .sort((a, b) => (filter === 'completed' ? b.due_date.localeCompare(a.due_date) : a.due_date.localeCompare(b.due_date))),
    [data.reviews, employee, filter],
  );

  const replace = (saved: Review) => patch((d) => ({ ...d, reviews: d.reviews.map((r) => (r.id === saved.id ? saved : r)) }));

  const skip = async (r: Review) => {
    if (busyId) return;
    setBusyId(r.id);
    try {
      replace(await skipReview(r.id, ownerId));
      toast('Review skipped', 'success');
    } catch (e) {
      toast(describeHrError(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      {reminders.length > 0 && (
        <section aria-label="Review reminders" className="rounded-2xl border border-warning-500/30 bg-warning-500/5 p-4">
          <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <BellRing size={16} className="text-warning-500" aria-hidden="true" /> {reminders.length} review{reminders.length === 1 ? '' : 's'} need attention
          </h3>
          <ul className="mt-3 space-y-2">
            {reminders.slice(0, 6).map((r) => {
              const { state } = reviewDueState(r, today);
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 break-words text-text-primary">
                    <span className="font-semibold">{employeeName(data, r.employee_id)}</span> · {REVIEW_KIND_LABELS[r.kind]} · {relativeDays(r.due_date, today)}
                  </span>
                  <span className="flex items-center gap-2">
                    <Pill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Pill>
                    <Button size="sm" variant="secondary" onClick={() => setOpenId(r.id)}>
                      Start review
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Segmented
            label="Filter reviews"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'scheduled', label: 'Scheduled' },
              { value: 'completed', label: 'Completed' },
              { value: 'all', label: 'All' },
            ]}
          />
          <div className="w-52">
            <SelectField label="Employee" value={employee} onChange={(e) => setEmployee(e.target.value)}>
              <option value="">All employees</option>
              {data.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name}
                </option>
              ))}
            </SelectField>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setScheduling(true)} disabled={data.employees.length === 0}>
          <CalendarPlus size={16} aria-hidden="true" /> Schedule review
        </Button>
      </div>

      {scheduling && (
        <ScheduleForm
          ctx={ctx}
          defaultEmployee={employee}
          onCancel={() => setScheduling(false)}
          onCreated={(r) => {
            patch((d) => ({ ...d, reviews: [...d.reviews, r] }));
            setScheduling(false);
            toast('Review scheduled', 'success');
          }}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={filter === 'scheduled' ? 'No reviews scheduled' : 'No reviews yet'}
          description="30, 60 and 90-day reviews are scheduled automatically when you start an onboarding. You can also schedule annual reviews and check-ins."
        />
      ) : (
        <ul className="space-y-3" aria-label="Performance reviews">
          {rows.map((r) => {
            const { state } = reviewDueState(r, today);
            const open = openId === r.id;
            return (
              <li key={r.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-text-primary">{employeeName(data, r.employee_id)}</p>
                      <Pill tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Pill>
                    </div>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {REVIEW_KIND_LABELS[r.kind]} · due {formatDay(r.due_date)}
                      {r.status === 'scheduled' ? ` (${relativeDays(r.due_date, today)})` : ''}
                      {r.status === 'completed' && r.overall_rating ? ` · overall ${r.overall_rating}/5 — ${RATING_LABELS[r.overall_rating]}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    {r.status === 'scheduled' && (
                      <Button variant="ghost" size="sm" disabled={busyId === r.id} onClick={() => void skip(r)}>
                        Skip
                      </Button>
                    )}
                    {r.status !== 'skipped' && (
                      <Button variant={r.status === 'scheduled' ? 'primary' : 'secondary'} size="sm" onClick={() => setOpenId(open ? null : r.id)}>
                        {r.status === 'scheduled' ? (open ? 'Close' : 'Start review') : open ? 'Close' : 'View / edit'}
                      </Button>
                    )}
                  </div>
                </div>
                {open && (
                  <ReviewForm
                    key={r.id}
                    review={r}
                    today={today}
                    onCancel={() => setOpenId(null)}
                    onSave={async (draft) => {
                      try {
                        replace(await completeReview(r.id, ownerId, draft));
                        setOpenId(null);
                        toast('Review saved', 'success');
                        return true;
                      } catch (e) {
                        toast(describeHrError(e), 'error');
                        return false;
                      }
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RatingInput({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center justify-between gap-3">
      <span className="text-sm text-text-primary">{label}</span>
      <span className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} — ${RATING_LABELS[n]}`}
            title={RATING_LABELS[n]}
            onClick={() => onChange(value === n ? undefined : n)}
            className={`focus-ring h-10 w-10 rounded-xl border text-sm font-semibold transition-colors ${
              value === n ? 'border-accent bg-accent text-white' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/50'
            }`}
          >
            {n}
          </button>
        ))}
      </span>
    </div>
  );
}

function ReviewForm({ review, today, onSave, onCancel }: { review: Review; today: string; onSave: (d: ReviewDraft) => Promise<boolean>; onCancel: () => void }) {
  const [draft, setDraft] = useState<ReviewDraft>({
    overall_rating: review.overall_rating,
    reviewed_on: review.reviewed_on ?? today,
    ratings: review.ratings,
    strengths: review.strengths ?? '',
    improvements: review.improvements ?? '',
    goals: review.goals ?? '',
    notes: review.notes ?? '',
  });
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validateReview(draft, today);
  const avg = averageRating(draft.ratings);
  const suggested = suggestOverall(draft.ratings);

  const setRating = (key: Competency, v: number | undefined) =>
    setDraft((d) => {
      const ratings = { ...d.ratings };
      if (v === undefined) delete ratings[key];
      else ratings[key] = v;
      return { ...d, ratings };
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="mt-4 space-y-5 border-t border-border pt-4">
      <fieldset className="space-y-2.5">
        <legend className="mb-1 text-sm font-semibold text-text-primary">Ratings (1 = needs improvement, 5 = outstanding)</legend>
        {COMPETENCIES.map((c) => (
          <RatingInput key={c.key} label={c.label} value={draft.ratings[c.key]} onChange={(v) => setRating(c.key, v)} />
        ))}
        {errors.ratings && attempted && <p role="alert" className="text-xs text-danger">{errors.ratings}</p>}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <RatingInput label="Overall rating" value={draft.overall_rating ?? undefined} onChange={(v) => setDraft((d) => ({ ...d, overall_rating: v ?? null }))} />
          {attempted && errors.overall_rating && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.overall_rating}</p>}
          {avg !== null && (
            <p className="mt-1.5 text-xs text-text-secondary">
              Average of competencies: {avg}.{' '}
              {suggested !== null && draft.overall_rating !== suggested && (
                <button type="button" className="focus-ring rounded font-semibold text-accent underline" onClick={() => setDraft((d) => ({ ...d, overall_rating: suggested }))}>
                  Use {suggested}
                </button>
              )}
            </p>
          )}
        </div>
        <Input label="Review date" type="date" value={draft.reviewed_on} max={today} error={attempted ? errors.reviewed_on : undefined} onChange={(e) => setDraft((d) => ({ ...d, reviewed_on: e.target.value }))} />
      </div>

      <Textarea label="Strengths" rows={3} maxLength={REVIEW_TEXT_LIMIT} value={draft.strengths} error={attempted ? errors.strengths : undefined} onChange={(e) => setDraft((d) => ({ ...d, strengths: e.target.value }))} />
      <Textarea label="Areas to improve" rows={3} maxLength={REVIEW_TEXT_LIMIT} value={draft.improvements} error={attempted ? errors.improvements : undefined} onChange={(e) => setDraft((d) => ({ ...d, improvements: e.target.value }))} />
      <Textarea label="Goals for the next period" rows={3} maxLength={REVIEW_TEXT_LIMIT} value={draft.goals} error={attempted ? errors.goals : undefined} onChange={(e) => setDraft((d) => ({ ...d, goals: e.target.value }))} />
      <Textarea
        label="Private notes"
        rows={3}
        maxLength={REVIEW_NOTES_LIMIT}
        value={draft.notes}
        helperText="Only the account owner can see HR notes."
        error={attempted ? errors.notes : undefined}
        onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
      />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : review.status === 'completed' ? 'Save changes' : 'Complete review'}
        </Button>
      </div>
    </form>
  );
}

function ScheduleForm({ ctx, defaultEmployee, onCreated, onCancel }: { ctx: HrCtx; defaultEmployee: string; onCreated: (r: Review) => void; onCancel: () => void }) {
  const { data, today, ownerId } = ctx;
  const { toast } = useToast();
  const [draft, setDraft] = useState<{ employee_id: string; kind: ReviewKind; due_date: string }>({
    employee_id: defaultEmployee || data.employees[0]?.id || '',
    kind: 'annual',
    due_date: addDays(today, 7),
  });
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validateScheduleReview(draft);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      onCreated(await scheduleReview(ownerId, draft));
    } catch (err) {
      toast(describeHrError(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell title="Schedule a review">
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label="Employee" value={draft.employee_id} error={attempted ? errors.employee_id : undefined} onChange={(e) => setDraft((d) => ({ ...d, employee_id: e.target.value }))}>
            {data.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
              </option>
            ))}
          </SelectField>
          <SelectField label="Type" value={draft.kind} error={attempted ? errors.kind : undefined} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as ReviewKind }))}>
            {SCHEDULABLE_REVIEW_KINDS.map((k) => (
              <option key={k} value={k}>
                {REVIEW_KIND_LABELS[k]}
              </option>
            ))}
          </SelectField>
          <Input label="Due date" type="date" value={draft.due_date} error={attempted ? errors.due_date : undefined} onChange={(e) => setDraft((d) => ({ ...d, due_date: e.target.value }))} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Schedule'}
          </Button>
        </div>
      </form>
    </FormShell>
  );
}
