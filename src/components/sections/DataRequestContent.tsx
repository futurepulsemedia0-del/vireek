import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Clock, Copy, Download, Loader2, Mail, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { OtpEntry } from '@/components/auth/OtpEntry';
import { EASE } from '@/lib/motion';
import {
  DSAR_LIMITS,
  DSAR_RESPONSE_DAYS,
  EMPTY_DSAR_FORM,
  KIND_OPTIONS,
  REGION_OPTIONS,
  RELATIONSHIP_OPTIONS,
  formatDueDate,
  outcomeCopy,
  validateDsarForm,
  type DsarFieldErrors,
  type DsarFormValues,
} from '@/lib/dsar';
import { DsarApiError, resendDsarCode, submitDsar, verifyDsar, type VerifyResult } from '@/lib/dsarApi';

const CONTACT_EMAIL = 'ali@vireek.com';
const KIND_ICON = { access: Download, delete: Trash2, correct: Pencil } as const;

type Step = 'form' | 'verify' | 'done';

// ------------------------------------------------------------------
// Accessible radio group (native radios → arrow-key navigation for free)
// ------------------------------------------------------------------
interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  description?: string;
  icon?: typeof Download;
}

function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  error,
  required,
  columns = false,
}: {
  legend: string;
  name: string;
  value: T | '';
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (v: T) => void;
  error?: string;
  required?: boolean;
  columns?: boolean;
}) {
  const errId = `${name}-error`;
  return (
    <fieldset aria-describedby={error ? errId : undefined}>
      <legend className="mb-2 text-sm font-medium text-text-primary">
        {legend}
        {required && <span aria-hidden="true" className="ml-0.5 text-danger">*</span>}
      </legend>
      <div className={columns ? 'grid gap-3 sm:grid-cols-3' : 'grid gap-2'}>
        {options.map((o) => {
          const Icon = o.icon;
          return (
            <label key={o.value} className="relative block cursor-pointer">
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
                aria-invalid={Boolean(error)}
                className="peer sr-only"
              />
              <span
                className={`flex h-full gap-3 rounded-xl border bg-bg-primary p-4 transition-colors hover:border-accent/40 peer-checked:border-accent peer-checked:bg-accent/[0.06] peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
                  error ? 'border-danger/60' : 'border-border'
                } ${columns ? 'flex-col' : 'items-center'}`}
              >
                {Icon && <Icon size={20} className="text-accent" aria-hidden="true" />}
                <span>
                  <span className="block text-sm font-semibold text-text-primary">{o.title}</span>
                  {o.description && <span className="mt-1 block text-xs leading-snug text-text-secondary">{o.description}</span>}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errId} role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function AsideItem({ icon: Icon, title, children }: { icon: typeof Clock; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-text-secondary">{children}</p>
      </div>
    </div>
  );
}

export function DataRequestContent() {
  const reduceMotion = useReducedMotion();
  const [step, setStep] = useState<Step>('form');
  const [values, setValues] = useState<DsarFormValues>(EMPTY_DSAR_FORM);
  const [errors, setErrors] = useState<DsarFieldErrors>({});
  const [honeypot, setHoneypot] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [requestId, setRequestId] = useState('');
  const [receipt, setReceipt] = useState<VerifyResult | null>(null);
  const [copied, setCopied] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  // Move focus to the step heading when the form or receipt appears (screen readers + keyboard users).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    // The OTP boxes grab focus themselves on the verify step; don't steal it.
    if (step !== 'verify') headingRef.current?.focus();
  }, [step]);

  const set = useCallback(<K extends keyof DsarFormValues>(key: K, v: DsarFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setFormError('');

    const found = validateDsarForm(values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }

    setSubmitting(true);
    try {
      const res = await submitDsar(values, honeypot);
      setRequestId(res.requestId);
      setStep('verify');
    } catch (err) {
      if (err instanceof DsarApiError && err.fieldErrors) {
        setErrors(err.fieldErrors as DsarFieldErrors);
        requestAnimationFrame(() => summaryRef.current?.focus());
      } else {
        setFormError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = useCallback(
    async (code: string) => {
      try {
        setReceipt(await verifyDsar(requestId, values.email, code));
        return { success: true };
      } catch (err) {
        if (err instanceof DsarApiError) {
          const left = typeof err.attemptsLeft === 'number' && err.attemptsLeft > 0 ? ` ${err.attemptsLeft} attempts left.` : '';
          return { success: false, error: `${err.message}${left}` };
        }
        return { success: false, error: 'Something went wrong. Please try again.' };
      }
    },
    [requestId, values.email],
  );

  const handleResend = useCallback(async () => {
    try {
      await resendDsarCode(requestId, values.email);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Could not resend the code.' };
    }
  }, [requestId, values.email]);

  const reset = () => {
    setValues(EMPTY_DSAR_FORM);
    setErrors({});
    setReceipt(null);
    setRequestId('');
    setHoneypot('');
    setFormError('');
    setStep('form');
  };

  const copyReference = async () => {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(receipt.reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard can be blocked; the reference is visible and selectable anyway */
    }
  };

  const errorCount = Object.values(errors).filter(Boolean).length;
  const fade = reduceMotion ? {} : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.4, ease: EASE } };

  return (
    <section className="pb-24">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div {...fade} className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent">Privacy request</p>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="mt-3 text-4xl font-bold tracking-tight text-text-primary outline-none md:text-5xl"
          >
            {step === 'form' && 'Make a data request'}
            {step === 'verify' && 'Check your email'}
            {step === 'done' && 'Request received'}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-text-secondary">
            Access, delete or correct the personal data Vireek holds about you. No account needed — we just need to
            confirm the request really comes from you.
          </p>
        </motion.div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="relative p-6 hover:translate-y-0 md:p-8">
            {step === 'form' && (
              <form onSubmit={handleSubmit} noValidate className="space-y-7" aria-label="Data request form">
                {(errorCount > 0 || formError) && (
                  <div
                    ref={summaryRef}
                    tabIndex={-1}
                    role="alert"
                    className="rounded-xl border border-danger/40 bg-danger/[0.06] p-4 text-sm text-danger outline-none"
                  >
                    {formError || `Please fix ${errorCount} ${errorCount === 1 ? 'field' : 'fields'} below.`}
                  </div>
                )}

                <ChoiceGroup
                  legend="What would you like us to do?"
                  name="kind"
                  required
                  columns
                  value={values.kind}
                  error={errors.kind}
                  onChange={(v) => set('kind', v)}
                  options={KIND_OPTIONS.map((o) => ({ ...o, icon: KIND_ICON[o.value] }))}
                />

                <div className="grid gap-5 sm:grid-cols-2">
                  <Input
                    label="Full name"
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={DSAR_LIMITS.nameMax}
                    value={values.fullName}
                    error={errors.fullName}
                    onChange={(e) => set('fullName', e.target.value)}
                  />
                  <Input
                    label="Email address"
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    required
                    maxLength={DSAR_LIMITS.emailMax}
                    value={values.email}
                    error={errors.email}
                    helperText="We'll send a verification code here."
                    onChange={(e) => set('email', e.target.value)}
                  />
                </div>

                <ChoiceGroup
                  legend="How do you relate to Vireek?"
                  name="relationship"
                  required
                  value={values.relationship}
                  error={errors.relationship}
                  onChange={(v) => set('relationship', v)}
                  options={RELATIONSHIP_OPTIONS.map((o) => ({ value: o.value, title: o.label }))}
                />

                <ChoiceGroup
                  legend="Where do you live?"
                  name="region"
                  value={values.region}
                  onChange={(v) => set('region', v)}
                  options={REGION_OPTIONS.map((o) => ({ value: o.value, title: o.label }))}
                />

                <Textarea
                  label={values.kind === 'correct' ? 'What is wrong, and what should it say?' : 'Anything else we should know? (optional)'}
                  name="details"
                  rows={4}
                  required={values.kind === 'correct'}
                  maxLength={DSAR_LIMITS.detailsMax}
                  value={values.details}
                  error={errors.details}
                  helperText={`${values.details.length}/${DSAR_LIMITS.detailsMax} — don't include passwords or payment card numbers.`}
                  onChange={(e) => set('details', e.target.value)}
                />

                {/* Honeypot: invisible to people and assistive tech, irresistible to bots. */}
                <div aria-hidden="true" className="absolute left-[-9999px] top-0 h-0 w-0 overflow-hidden">
                  <label>
                    Website
                    <input
                      type="text"
                      name="website"
                      tabIndex={-1}
                      autoComplete="off"
                      value={honeypot}
                      onChange={(e) => setHoneypot(e.target.value)}
                    />
                  </label>
                </div>

                <div>
                  <label className="flex cursor-pointer items-start gap-3 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={values.confirmed}
                      aria-invalid={Boolean(errors.confirmed)}
                      onChange={(e) => set('confirmed', e.target.checked)}
                      className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-border accent-[rgb(var(--accent-primary))]"
                    />
                    <span>
                      I confirm this request is about my own personal data, and that the information I've given is
                      accurate.
                    </span>
                  </label>
                  {errors.confirmed && (
                    <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
                      {errors.confirmed}
                    </p>
                  )}
                </div>

                <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={submitting}>
                  {submitting && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}
                  {submitting ? 'Sending code…' : 'Continue — verify my email'}
                </Button>
              </form>
            )}

            {step === 'verify' && (
              <div className="space-y-6">
                <p className="text-base leading-relaxed text-text-secondary">
                  We sent a 6-digit code to <strong className="break-all text-text-primary">{values.email.trim()}</strong>.
                  It expires in 15 minutes.
                </p>
                <OtpEntry
                  onVerify={handleVerify}
                  onResend={handleResend}
                  onSuccessSettled={() => setStep('done')}
                  idleHint="Enter the 6-digit code"
                />
                <Button variant="ghost" size="sm" type="button" onClick={() => setStep('form')}>
                  Use a different email or edit my request
                </Button>
              </div>
            )}

            {step === 'done' && receipt && (
              <div className="space-y-6" aria-live="polite">
                <div className="flex items-center gap-3">
                  <CheckCircle2 size={28} className="text-success" aria-hidden="true" />
                  <p className="text-lg font-semibold text-text-primary">{outcomeCopy(receipt.outcome, receipt.kind).title}</p>
                </div>
                <p className="text-base leading-relaxed text-text-secondary">{outcomeCopy(receipt.outcome, receipt.kind).body}</p>

                <dl className="grid gap-4 rounded-xl border border-border bg-bg-primary p-5 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Reference</dt>
                    <dd className="mt-1 flex items-center gap-2">
                      <code className="select-all font-mono text-base font-semibold text-text-primary">{receipt.reference}</code>
                      <button
                        type="button"
                        onClick={copyReference}
                        aria-label="Copy reference number"
                        className="focus-ring rounded-md p-1.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                      >
                        {copied ? <CheckCircle2 size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-text-secondary">We'll respond by</dt>
                    <dd className="mt-1 text-base font-semibold text-text-primary">{formatDueDate(receipt.dueAt)}</dd>
                  </div>
                </dl>

                <p className="text-sm text-text-secondary">
                  A confirmation is on its way to your inbox. Questions? Write to{' '}
                  <a className="font-semibold text-accent hover:underline" href={`mailto:${CONTACT_EMAIL}`}>
                    {CONTACT_EMAIL}
                  </a>{' '}
                  and quote your reference.
                </p>
                <Button variant="secondary" type="button" onClick={reset}>
                  Make another request
                </Button>
              </div>
            )}
          </Card>

          <aside className="space-y-6 lg:sticky lg:top-28 lg:self-start" aria-label="How data requests work">
            <Card className="space-y-5 p-6 hover:translate-y-0">
              <AsideItem icon={ShieldCheck} title="We verify it's you">
                A one-time code to your email protects your data from anyone pretending to be you.
              </AsideItem>
              <AsideItem icon={Clock} title={`Answer within ${DSAR_RESPONSE_DAYS} days`}>
                The clock starts once your email is verified. Complex requests may take longer; we'll tell you why.
              </AsideItem>
              <AsideItem icon={Mail} title="Prefer email?">
                Write to{' '}
                <a className="font-semibold text-accent hover:underline" href={`mailto:${CONTACT_EMAIL}`}>
                  {CONTACT_EMAIL}
                </a>
                .
              </AsideItem>
            </Card>
            <Card className="p-6 hover:translate-y-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">Related</p>
              <ul className="mt-3 space-y-2 text-sm font-semibold text-accent">
                <li><Link className="hover:underline" to="/privacy">Privacy Policy &rarr;</Link></li>
                <li><Link className="hover:underline" to="/ccpa">California privacy rights &rarr;</Link></li>
                <li><Link className="hover:underline" to="/gdpr-dpa">GDPR Addendum &rarr;</Link></li>
              </ul>
            </Card>
          </aside>
        </div>
      </div>
    </section>
  );
}
