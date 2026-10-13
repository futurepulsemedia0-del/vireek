import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Send } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import {
  DMCA_AGENT,
  DMCA_ERROR_MESSAGES,
  DMCA_FIELD_ORDER,
  DMCA_LIMITS,
  DMCA_STATEMENTS,
  emptyDmcaValues,
  submitDmcaNotice,
  validateDmca,
  type DmcaCapacity,
  type DmcaErrors,
  type DmcaField,
  type DmcaFormValues,
  type DmcaNoticeType,
} from '@/lib/dmca';

type Status = 'idle' | 'submitting' | 'success' | 'error';

const FIELD_IDS: Record<DmcaField, string> = {
  fullName: 'dmca-full-name',
  email: 'dmca-email',
  phone: 'dmca-phone',
  address: 'dmca-address',
  workDescription: 'dmca-work-description',
  workUrl: 'dmca-work-url',
  urls: 'dmca-urls',
  originalReference: 'dmca-original-reference',
  additionalInfo: 'dmca-additional-info',
  statements: 'dmca-stmt-first',
  signature: 'dmca-signature',
};

const TYPE_OPTIONS: { value: DmcaNoticeType; label: string; hint: string }[] = [
  { value: 'takedown', label: 'Report infringement', hint: 'Content on Vireek copies your work' },
  { value: 'counter', label: 'Submit a counter-notification', hint: 'Your content was removed by mistake' },
];

const CAPACITY_OPTIONS: { value: DmcaCapacity; label: string }[] = [
  { value: 'owner', label: 'I am the copyright owner' },
  { value: 'agent', label: 'I am authorized to act on the owner’s behalf' },
];

export function DmcaForm({ initialType = 'takedown' }: { initialType?: DmcaNoticeType }) {
  const [values, setValues] = useState<DmcaFormValues>(() => emptyDmcaValues(initialType));
  const [errors, setErrors] = useState<DmcaErrors>({});
  const [status, setStatus] = useState<Status>('idle');
  const [serverError, setServerError] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const successRef = useRef<HTMLDivElement>(null);

  const isCounter = values.noticeType === 'counter';
  const errorCount = Object.keys(errors).length;

  useEffect(() => {
    if (status === 'success') successRef.current?.focus();
  }, [status]);

  const clearError = (field: DmcaField) =>
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });

  const setField = <K extends keyof DmcaFormValues>(key: K, value: DmcaFormValues[K], errorField?: DmcaField) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (errorField) clearError(errorField);
  };

  const switchType = (noticeType: DmcaNoticeType) => {
    if (noticeType === values.noticeType) return;
    // Statements are type-specific, so they reset; contact details are kept.
    setValues((prev) => ({ ...prev, noticeType, statements: [] }));
    setErrors({});
    setServerError(null);
    if (status === 'error') setStatus('idle');
  };

  const toggleStatement = (id: string) => {
    setValues((prev) => ({
      ...prev,
      statements: prev.statements.includes(id) ? prev.statements.filter((s) => s !== id) : [...prev.statements, id],
    }));
    clearError('statements');
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === 'submitting') return;

    const found = validateDmca(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setServerError(null);
      const first = DMCA_FIELD_ORDER.find((f) => found[f]);
      if (first) document.getElementById(FIELD_IDS[first])?.focus();
      return;
    }

    setStatus('submitting');
    setServerError(null);
    const result = await submitDmcaNotice(values);
    if (result.ok) {
      setReference(result.reference);
      setValues(emptyDmcaValues(values.noticeType));
      setStatus('success');
    } else {
      setServerError(DMCA_ERROR_MESSAGES[result.error]);
      setStatus('error');
    }
  };

  if (status === 'success') {
    return (
      <div
        ref={successRef}
        tabIndex={-1}
        role="status"
        className="rounded-2xl border border-success-500/30 bg-success-500/5 p-6 text-center focus:outline-none md:p-8"
      >
        <CheckCircle2 size={36} className="mx-auto text-success" aria-hidden="true" />
        <h3 className="mt-3 text-xl font-bold text-text-primary">Your notice has been received</h3>
        <p className="mt-2 text-sm text-text-secondary">Please keep this reference number for your records:</p>
        <p className="mt-3 inline-block rounded-xl border border-border bg-bg-secondary px-4 py-2 font-mono text-base font-semibold text-text-primary">
          {reference}
        </p>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-text-secondary">
          Our copyright agent will review it and contact you at the email address you provided if anything more is needed.
        </p>
        <Button type="button" variant="secondary" size="sm" className="mt-5" onClick={() => setStatus('idle')}>
          Submit another notice
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Copyright notice form" className="space-y-6">
      {/* Notice type */}
      <div role="group" aria-label="Notice type" className="grid gap-2 sm:grid-cols-2">
        {TYPE_OPTIONS.map((o) => {
          const active = values.noticeType === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => switchType(o.value)}
              className={`focus-ring min-h-[56px] rounded-xl border px-4 py-3 text-left transition-colors ${
                active ? 'border-accent bg-accent/10' : 'border-border bg-bg-secondary hover:border-accent/40'
              }`}
            >
              <span className={`block text-sm font-semibold ${active ? 'text-accent' : 'text-text-primary'}`}>{o.label}</span>
              <span className="mt-0.5 block text-xs text-text-secondary">{o.hint}</span>
            </button>
          );
        })}
      </div>

      {errorCount > 0 && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/5 p-3.5 text-sm text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Please fix {errorCount} {errorCount === 1 ? 'field' : 'fields'} highlighted below.
          </span>
        </div>
      )}

      {/* Your details */}
      <fieldset className="space-y-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-[0.14em] text-text-secondary">Your details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            id={FIELD_IDS.fullName}
            label="Full legal name"
            required
            autoComplete="name"
            maxLength={DMCA_LIMITS.name.max}
            value={values.fullName}
            error={errors.fullName}
            onChange={(e) => setField('fullName', e.target.value, 'fullName')}
          />
          <Input
            label="Company or organization"
            autoComplete="organization"
            maxLength={DMCA_LIMITS.organization}
            helperText="Optional"
            value={values.organization}
            onChange={(e) => setField('organization', e.target.value)}
          />
          <Input
            id={FIELD_IDS.email}
            label="Email address"
            type="email"
            required
            autoComplete="email"
            maxLength={DMCA_LIMITS.email}
            value={values.email}
            error={errors.email}
            onChange={(e) => setField('email', e.target.value, 'email')}
          />
          <Input
            id={FIELD_IDS.phone}
            label="Phone number"
            type="tel"
            required={isCounter}
            autoComplete="tel"
            maxLength={40}
            helperText={isCounter ? undefined : 'Optional'}
            value={values.phone}
            error={errors.phone}
            onChange={(e) => setField('phone', e.target.value, 'phone')}
          />
        </div>
        <Textarea
          id={FIELD_IDS.address}
          label="Mailing address"
          required
          rows={3}
          autoComplete="street-address"
          maxLength={DMCA_LIMITS.address.max}
          value={values.address}
          error={errors.address}
          onChange={(e) => setField('address', e.target.value, 'address')}
        />
        {!isCounter && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-text-primary">Your relationship to the work</legend>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
              {CAPACITY_OPTIONS.map((o) => (
                <label key={o.value} className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-sm text-text-secondary">
                  <input
                    type="radio"
                    name="dmca-capacity"
                    value={o.value}
                    checked={values.capacity === o.value}
                    onChange={() => setField('capacity', o.value)}
                    className="h-4 w-4 accent-accent"
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </fieldset>

      {/* The material */}
      <fieldset className="space-y-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-[0.14em] text-text-secondary">
          {isCounter ? 'The removed material' : 'The copyrighted work'}
        </legend>
        <Textarea
          id={FIELD_IDS.workDescription}
          label={isCounter ? 'Describe the removed material' : 'Describe the copyrighted work'}
          required={!isCounter}
          rows={4}
          maxLength={DMCA_LIMITS.workDescription.max}
          helperText={
            isCounter
              ? 'Optional — anything that helps us identify what was removed.'
              : 'Include the title, author, and where the original can be found or was first published.'
          }
          value={values.workDescription}
          error={errors.workDescription}
          onChange={(e) => setField('workDescription', e.target.value, 'workDescription')}
        />
        {!isCounter && (
          <Input
            id={FIELD_IDS.workUrl}
            label="Link to the original work"
            type="url"
            inputMode="url"
            maxLength={DMCA_LIMITS.url}
            placeholder="https://"
            helperText="Optional"
            value={values.workUrl}
            error={errors.workUrl}
            onChange={(e) => setField('workUrl', e.target.value, 'workUrl')}
          />
        )}
        <Textarea
          id={FIELD_IDS.urls}
          label={isCounter ? 'Where did the removed material appear?' : 'Where is the infringing material?'}
          required
          rows={4}
          spellCheck={false}
          placeholder={'https://vireek.com/...\nhttps://vireek.com/...'}
          helperText={`One full link per line, up to ${DMCA_LIMITS.urlCount}. Be specific enough for us to locate it.`}
          value={values.urlsText}
          error={errors.urls}
          onChange={(e) => setField('urlsText', e.target.value, 'urls')}
        />
        {isCounter && (
          <Input
            id={FIELD_IDS.originalReference}
            label="Reference number of the original notice"
            maxLength={DMCA_LIMITS.originalReference}
            helperText="Optional — e.g. DMCA-2026-000123, if we sent it to you."
            value={values.originalReference}
            error={errors.originalReference}
            onChange={(e) => setField('originalReference', e.target.value, 'originalReference')}
          />
        )}
        <Textarea
          id={FIELD_IDS.additionalInfo}
          label="Additional information"
          rows={3}
          maxLength={DMCA_LIMITS.additionalInfo}
          helperText="Optional"
          value={values.additionalInfo}
          error={errors.additionalInfo}
          onChange={(e) => setField('additionalInfo', e.target.value, 'additionalInfo')}
        />
      </fieldset>

      {/* Statements */}
      <fieldset>
        <legend className="mb-2 text-sm font-semibold uppercase tracking-[0.14em] text-text-secondary">
          Required statements<span className="ml-0.5 text-danger">*</span>
        </legend>
        <div className="space-y-3">
          {DMCA_STATEMENTS[values.noticeType].map((s, i) => (
            <label
              key={s.id}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg-secondary p-3.5 text-sm leading-relaxed text-text-secondary"
            >
              <input
                id={i === 0 ? FIELD_IDS.statements : `dmca-stmt-${s.id}`}
                type="checkbox"
                checked={values.statements.includes(s.id)}
                onChange={() => toggleStatement(s.id)}
                aria-invalid={!!errors.statements}
                className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
              />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
        {errors.statements && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {errors.statements}
          </p>
        )}
      </fieldset>

      {/* Signature */}
      <Input
        id={FIELD_IDS.signature}
        label="Electronic signature"
        required
        autoComplete="off"
        maxLength={DMCA_LIMITS.name.max}
        helperText="Type your full legal name. This has the same effect as a handwritten signature."
        value={values.signature}
        error={errors.signature}
        onChange={(e) => setField('signature', e.target.value, 'signature')}
      />

      {/* Honeypot: invisible to people and assistive tech, irresistible to bots. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={values.website}
            onChange={(e) => setField('website', e.target.value)}
          />
        </label>
      </div>

      {status === 'error' && serverError && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/5 p-3.5 text-sm text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {serverError}{' '}
            <a className="font-semibold underline" href={`mailto:${DMCA_AGENT.email}`}>
              {DMCA_AGENT.email}
            </a>
          </span>
        </div>
      )}

      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={status === 'submitting'}>
        {status === 'submitting' ? (
          <>
            <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Submitting…
          </>
        ) : (
          <>
            <Send size={16} aria-hidden="true" /> {isCounter ? 'Submit counter-notification' : 'Submit notice'}
          </>
        )}
      </Button>
      <p className="text-xs leading-relaxed text-text-secondary">
        Submitting a false notice can have legal consequences. Do not use this form for anything other than copyright
        complaints.
      </p>
    </form>
  );
}
