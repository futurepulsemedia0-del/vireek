import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SurveyModal } from '@/components/surveys/SurveyModal';
import {
  CHANNEL_LABELS,
  MERGE_TAGS,
  SURVEY_TYPE_DESCRIPTIONS,
  SURVEY_TYPE_LABELS,
  THRESHOLD_RANGE,
  defaultTemplateInput,
  defaultTimezone,
  renderMergeTags,
  validateTemplate,
  type SurveyChannel,
  type SurveyTemplate,
  type SurveyTemplateInput,
  type SurveyType,
  type TemplateErrors,
} from '@/lib/surveys';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

const DELAY_OPTIONS = [
  { value: 0, label: 'As soon as the job is completed' },
  { value: 30, label: '30 minutes after' },
  { value: 60, label: '1 hour after' },
  { value: 120, label: '2 hours after (recommended)' },
  { value: 240, label: '4 hours after' },
  { value: 1440, label: 'The next day' },
  { value: 2880, label: '2 days after' },
];
const COOLDOWN_OPTIONS = [
  { value: 0, label: 'No limit' },
  { value: 7, label: '7 days' },
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days (recommended)' },
  { value: 60, label: '60 days' },
  { value: 90, label: '90 days' },
];
const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Dubai',
  'Australia/Sydney',
];

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-bg-primary px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`focus-ring relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`}
        />
      </button>
    </div>
  );
}

function Field({ label, error, children, hint }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>
      {children}
      {(error || hint) && (
        <span className={`mt-1.5 block text-xs ${error ? 'text-danger' : 'text-text-secondary'}`} role={error ? 'alert' : undefined}>
          {error || hint}
        </span>
      )}
    </label>
  );
}

function toInput(t: SurveyTemplate): SurveyTemplateInput {
  return {
    name: t.name,
    survey_type: t.survey_type,
    question: t.question,
    follow_up_question: t.follow_up_question,
    thank_you_message: t.thank_you_message,
    channel: t.channel,
    sms_body: t.sms_body,
    email_subject: t.email_subject,
    auto_send: t.auto_send,
    send_delay_minutes: t.send_delay_minutes,
    cooldown_days: t.cooldown_days,
    timezone: t.timezone,
    low_score_threshold: t.low_score_threshold,
    is_active: t.is_active,
  };
}

export function SurveyTemplateEditor({
  open,
  template,
  initialType,
  saving,
  onSave,
  onClose,
}: {
  open: boolean;
  /** null = creating a new survey */
  template: SurveyTemplate | null;
  initialType: SurveyType;
  saving: boolean;
  onSave: (input: SurveyTemplateInput) => void | Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<SurveyTemplateInput>(() => defaultTemplateInput(initialType));
  const [errors, setErrors] = useState<TemplateErrors>({});
  const smsRef = useRef<HTMLTextAreaElement>(null);

  // Reset whenever the dialog opens for a different template / type.
  useEffect(() => {
    if (!open) return;
    setForm(template ? toInput(template) : defaultTemplateInput(initialType));
    setErrors({});
  }, [open, template, initialType]);

  const set = <K extends keyof SurveyTemplateInput>(key: K, value: SurveyTemplateInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const switchType = (type: SurveyType) => {
    if (template || type === form.survey_type) return;
    // Creating: swap in the other type's defaults but keep the channel/auto-send choices already made.
    const d = defaultTemplateInput(type);
    setForm((f) => ({ ...d, channel: f.channel, auto_send: f.auto_send, timezone: f.timezone }));
    setErrors({});
  };

  const insertTag = (tag: string) => {
    const el = smsRef.current;
    if (!el) return set('sms_body', form.sms_body + tag);
    const start = el.selectionStart ?? form.sms_body.length;
    const end = el.selectionEnd ?? start;
    const next = form.sms_body.slice(0, start) + tag + form.sms_body.slice(end);
    set('sms_body', next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + tag.length, start + tag.length);
    });
  };

  const smsPreview = useMemo(
    () =>
      renderMergeTags(form.sms_body, {
        customer_first_name: 'Sam',
        business_name: 'Your Business',
        link: 'https://…/s/abc123',
      }),
    [form.sms_body],
  );

  const range = THRESHOLD_RANGE[form.survey_type];
  const thresholdOptions = Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i);
  const timezones = useMemo(() => {
    const set = new Set([form.timezone, defaultTimezone(), ...COMMON_TIMEZONES]);
    return [...set];
  }, [form.timezone]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateTemplate(form);
    setErrors(found);
    if (Object.keys(found).length === 0) void onSave(form);
  };

  const usesSms = form.channel !== 'email';
  const usesEmail = form.channel !== 'sms';

  return (
    <SurveyModal
      open={open}
      onClose={onClose}
      wide
      title={template ? 'Edit survey' : 'New survey'}
      description="Customers get a one-tap survey link by SMS and/or email after a job is completed."
    >
      <form onSubmit={submit} className="space-y-5" noValidate>
        {!template && (
          <div role="radiogroup" aria-label="Survey type" className="grid gap-2 sm:grid-cols-2">
            {(['nps', 'csat'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={form.survey_type === t}
                onClick={() => switchType(t)}
                className={`focus-ring rounded-xl border px-4 py-3 text-left transition-colors ${
                  form.survey_type === t ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/40'
                }`}
              >
                <span className="block text-sm font-semibold text-text-primary">{SURVEY_TYPE_LABELS[t]}</span>
                <span className="mt-0.5 block text-xs text-text-secondary">{SURVEY_TYPE_DESCRIPTIONS[t]}</span>
              </button>
            ))}
          </div>
        )}

        <Input label="Survey name" value={form.name} maxLength={120} onChange={(e) => set('name', e.target.value)} error={errors.name} required />
        <Textarea
          label="Question"
          rows={2}
          maxLength={300}
          value={form.question}
          onChange={(e) => set('question', e.target.value)}
          error={errors.question}
          required
        />
        <Input
          label="Follow-up prompt (optional)"
          maxLength={300}
          value={form.follow_up_question ?? ''}
          onChange={(e) => set('follow_up_question', e.target.value)}
          error={errors.follow_up_question}
          helperText="Shown above the comment box after the customer picks a score."
        />
        <Input
          label="Thank-you message"
          maxLength={500}
          value={form.thank_you_message}
          onChange={(e) => set('thank_you_message', e.target.value)}
          error={errors.thank_you_message}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Send via">
            <select className={selectClass} value={form.channel} onChange={(e) => set('channel', e.target.value as SurveyChannel)}>
              {(Object.keys(CHANNEL_LABELS) as SurveyChannel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Create a recovery case when score is ≤"
            error={errors.low_score_threshold}
            hint={
              form.survey_type === 'nps'
                ? 'NPS detractors are 0–6. Scores 0–3 are flagged critical.'
                : 'CSAT 1–2 means dissatisfied. A score of 1 is flagged critical.'
            }
          >
            <select
              className={selectClass}
              value={form.low_score_threshold}
              onChange={(e) => set('low_score_threshold', Number(e.target.value))}
            >
              {thresholdOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {usesSms && (
          <div>
            <Textarea
              ref={smsRef}
              label="SMS message"
              rows={3}
              maxLength={320}
              value={form.sms_body}
              onChange={(e) => set('sms_body', e.target.value)}
              error={errors.sms_body}
              helperText={`${form.sms_body.length}/320 · Must include {{link}}`}
            />
            <div className="mt-2 flex flex-wrap gap-2" aria-label="Insert merge tag">
              {MERGE_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => insertTag(tag)}
                  className="focus-ring rounded-lg border border-border bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary"
                >
                  {tag}
                </button>
              ))}
            </div>
            <p className="mt-3 rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide">Preview</span>
              {smsPreview}
            </p>
          </div>
        )}

        {usesEmail && (
          <Input
            label="Email subject"
            maxLength={150}
            value={form.email_subject}
            onChange={(e) => set('email_subject', e.target.value)}
            error={errors.email_subject}
            helperText="Supports {{customer_first_name}} and {{business_name}}."
          />
        )}

        <div className="space-y-3 rounded-2xl border border-border p-4">
          <Toggle
            checked={form.auto_send}
            onChange={(v) => set('auto_send', v)}
            label="Send automatically after each completed job"
            description="Only jobs completed after you turn this on are surveyed — never your history. One active automatic survey per type."
          />
          {form.auto_send && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Send" error={errors.send_delay_minutes}>
                <select className={selectClass} value={form.send_delay_minutes} onChange={(e) => set('send_delay_minutes', Number(e.target.value))}>
                  {(DELAY_OPTIONS.some((o) => o.value === form.send_delay_minutes)
                    ? DELAY_OPTIONS
                    : [...DELAY_OPTIONS, { value: form.send_delay_minutes, label: `${form.send_delay_minutes} minutes after` }]
                  ).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Don't re-survey the same customer for" error={errors.cooldown_days}>
                <select className={selectClass} value={form.cooldown_days} onChange={(e) => set('cooldown_days', Number(e.target.value))}>
                  {(COOLDOWN_OPTIONS.some((o) => o.value === form.cooldown_days)
                    ? COOLDOWN_OPTIONS
                    : [...COOLDOWN_OPTIONS, { value: form.cooldown_days, label: `${form.cooldown_days} days` }]
                  ).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Business time zone" hint="SMS is only sent 8am–8pm local time.">
                <select className={selectClass} value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
                  {timezones.map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          <Toggle
            checked={form.is_active}
            onChange={(v) => set('is_active', v)}
            label="Survey is active"
            description="Inactive surveys stop sending but keep all collected responses."
          />
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {template ? 'Save changes' : 'Create survey'}
          </Button>
        </div>
      </form>
    </SurveyModal>
  );
}
