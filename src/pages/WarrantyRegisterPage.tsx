/**
 * Public warranty registration — /warranty/register
 *
 * No login. Optional ?code=VEQ-XXXX-XXXX-XXXX (the QR label on the unit)
 * pre-fills the passport code so a scan lands on a nearly-complete form.
 * Submission goes through the rate-limited `warranty-register` edge function,
 * which also sends the confirmation email.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Copy, Loader2, MailWarning, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatPassportCode, isValidPassportCode, normalizePassportCode } from '@/lib/equipmentPassport';
import {
  EQUIPMENT_TYPES,
  emptyWarrantyForm,
  firstInvalidField,
  submitWarrantyRegistration,
  todayIso,
  validateWarrantyForm,
  type WarrantyErrors,
  type WarrantyField,
  type WarrantyFormState,
  type WarrantyReceipt,
} from '@/lib/warrantyRegistration';

const selectClass =
  'focus-ring w-full rounded-xl border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';
const fieldId = (f: WarrantyField) => `wr-${f}`;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6">
      <legend className="px-1 text-sm font-semibold text-text-primary">{title}</legend>
      {hint && <p className="-mt-2 text-xs text-text-secondary">{hint}</p>}
      {children}
    </fieldset>
  );
}

export function WarrantyRegisterPage() {
  const [params] = useSearchParams();
  const prefill = useMemo(() => {
    const raw = params.get('code') ?? '';
    return isValidPassportCode(raw) ? formatPassportCode(normalizePassportCode(raw)) : '';
  }, [params]);

  const [form, setForm] = useState<WarrantyFormState>(() => emptyWarrantyForm(prefill));
  const [errors, setErrors] = useState<WarrantyErrors>({});
  const [focusField, setFocusField] = useState<WarrantyField | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<WarrantyReceipt | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const today = useMemo(() => todayIso(), []);

  useEffect(() => {
    document.title = 'Register your warranty | Vireek';
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!focusField) return;
    document.getElementById(fieldId(focusField))?.focus();
    setFocusField(null);
  }, [focusField]);

  const set = <K extends keyof WarrantyFormState>(key: K, value: WarrantyFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key as WarrantyField]: undefined }));
  };

  const handleSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (submitting) return;
    setBanner(null);

    const found = validateWarrantyForm(form, today);
    const first = firstInvalidField(found);
    if (first) {
      setErrors(found);
      setFocusField(first);
      return;
    }

    setErrors({});
    setSubmitting(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const res = await submitWarrantyRegistration(form, abortRef.current.signal);
    setSubmitting(false);

    if (res.ok) {
      setReceipt(res);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setBanner(res.message);
    if (res.fieldErrors) {
      setErrors(res.fieldErrors);
      setFocusField(firstInvalidField(res.fieldErrors));
    }
  };

  const copyCode = async () => {
    if (!receipt) return;
    try {
      await navigator.clipboard.writeText(receipt.confirmationCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the code is on screen */
    }
  };

  const reset = () => {
    setForm(emptyWarrantyForm(prefill));
    setErrors({});
    setBanner(null);
    setReceipt(null);
  };

  const selectError = (f: WarrantyField) => (errors[f] ? 'border-danger' : 'border-border');

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-10">
        <div className="mx-auto w-full max-w-xl">
          {receipt ? (
            <div className="rounded-2xl border border-border bg-bg-secondary p-6 text-center sm:p-8" role="status" aria-live="polite">
              <CheckCircle2 size={40} className="mx-auto mb-3 text-success" />
              <h1 className="text-2xl font-bold text-text-primary">{receipt.duplicate ? 'Already registered' : 'Warranty registered'}</h1>
              <p className="mt-2 text-sm text-text-secondary">
                {receipt.duplicate
                  ? 'This unit is already registered with this email address. Here is your confirmation code.'
                  : 'Keep this code with your proof of purchase.'}
              </p>

              <div className="mx-auto mt-5 flex max-w-xs items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-4 py-3">
                <span className="font-mono text-lg font-bold tracking-wider text-text-primary">{receipt.confirmationCode}</span>
                <button
                  type="button"
                  onClick={() => void copyCode()}
                  className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  aria-label="Copy confirmation code"
                >
                  <Copy size={16} />
                </button>
              </div>
              {copied && <p className="mt-1 text-xs text-success">Copied</p>}

              {!receipt.duplicate && (
                <p className={`mt-5 flex items-start justify-center gap-2 text-sm ${receipt.emailSent ? 'text-text-secondary' : 'text-warning-500'}`}>
                  {receipt.emailSent ? (
                    <>
                      <ShieldCheck size={16} className="mt-0.5 shrink-0 text-success" />
                      <span>We emailed a confirmation to {form.email.trim()}.</span>
                    </>
                  ) : (
                    <>
                      <MailWarning size={16} className="mt-0.5 shrink-0" />
                      <span>We couldn’t send the confirmation email. Your registration is saved — keep the code above.</span>
                    </>
                  )}
                </p>
              )}

              {receipt.linked && receipt.passportCode && (
                <Link
                  to={`/e/${receipt.passportCode}`}
                  className="focus-ring mt-6 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-border px-5 text-sm font-medium text-text-primary hover:bg-bg-tertiary"
                >
                  View your equipment passport
                </Link>
              )}
              <div className="mt-4">
                <Button type="button" variant="ghost" size="sm" onClick={reset}>Register another unit</Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-5">
              <div>
                <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">Register your warranty</h1>
                <p className="mt-2 text-sm text-text-secondary">
                  Takes about two minutes. We’ll email you a confirmation and link it to your equipment’s digital passport.
                </p>
              </div>

              {banner && (
                <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-text-primary">
                  <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
                  <p>{banner}</p>
                </div>
              )}

              <Section title="Your details">
                <Input id={fieldId('name')} label="Full name" required autoComplete="name" value={form.name} error={errors.name} onChange={(e) => set('name', e.target.value)} />
                <Input id={fieldId('email')} label="Email" type="email" required autoComplete="email" inputMode="email" value={form.email} error={errors.email} helperText="Your confirmation is sent here." onChange={(e) => set('email', e.target.value)} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input id={fieldId('phone')} label="Phone (optional)" type="tel" autoComplete="tel" inputMode="tel" value={form.phone} error={errors.phone} onChange={(e) => set('phone', e.target.value)} />
                  <Input id={fieldId('address')} label="Service address (optional)" autoComplete="street-address" value={form.address} error={errors.address} onChange={(e) => set('address', e.target.value)} />
                </div>
              </Section>

              <Section title="Your equipment" hint="The serial number is on the data plate or label on the unit.">
                <Input
                  id={fieldId('passportCode')}
                  label="Passport code (optional)"
                  autoComplete="off"
                  autoCapitalize="characters"
                  placeholder="VEQ-XXXX-XXXX-XXXX"
                  value={form.passportCode}
                  error={errors.passportCode}
                  helperText="Printed under the QR code on your unit. It links this registration to your unit’s history."
                  onChange={(e) => set('passportCode', e.target.value)}
                />
                <div>
                  <label htmlFor={fieldId('equipmentType')} className="mb-1.5 block text-sm font-medium text-text-primary">
                    Equipment type <span className="text-danger" aria-hidden="true">*</span>
                  </label>
                  <select
                    id={fieldId('equipmentType')}
                    value={form.equipmentType}
                    required
                    aria-invalid={Boolean(errors.equipmentType)}
                    aria-describedby={errors.equipmentType ? 'wr-equipmentType-err' : undefined}
                    onChange={(e) => set('equipmentType', e.target.value)}
                    className={`${selectClass} ${selectError('equipmentType')}`}
                  >
                    <option value="">Choose…</option>
                    {EQUIPMENT_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  {errors.equipmentType && <p id="wr-equipmentType-err" className="mt-1.5 text-xs text-danger">{errors.equipmentType}</p>}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input id={fieldId('make')} label="Brand" required value={form.make} error={errors.make} onChange={(e) => set('make', e.target.value)} />
                  <Input id={fieldId('model')} label="Model (optional)" value={form.model} error={errors.model} onChange={(e) => set('model', e.target.value)} />
                </div>
                <Input id={fieldId('serial')} label="Serial number" required autoComplete="off" autoCapitalize="characters" value={form.serial} error={errors.serial} onChange={(e) => set('serial', e.target.value)} />
              </Section>

              <Section title="Purchase & installation">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input id={fieldId('purchaseDate')} label="Purchase date" type="date" required max={today} value={form.purchaseDate} error={errors.purchaseDate} onChange={(e) => set('purchaseDate', e.target.value)} />
                  <Input id={fieldId('installDate')} label="Install date (optional)" type="date" max={today} min={form.purchaseDate || undefined} value={form.installDate} error={errors.installDate} onChange={(e) => set('installDate', e.target.value)} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input id={fieldId('purchasedFrom')} label="Bought from (optional)" value={form.purchasedFrom} error={errors.purchasedFrom} onChange={(e) => set('purchasedFrom', e.target.value)} />
                  <Input id={fieldId('installer')} label="Installed by (optional)" value={form.installer} error={errors.installer} onChange={(e) => set('installer', e.target.value)} />
                </div>
              </Section>

              {/* Honeypot: invisible to people, tempting to bots. */}
              <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
                <label>
                  Website
                  <input type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => set('website', e.target.value)} />
                </label>
              </div>

              <div>
                <label className="flex min-h-[44px] cursor-pointer items-start gap-3 text-sm text-text-secondary">
                  <input
                    id={fieldId('terms')}
                    type="checkbox"
                    checked={form.terms}
                    aria-invalid={Boolean(errors.terms)}
                    onChange={(e) => set('terms', e.target.checked)}
                    className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-border accent-accent"
                  />
                  <span>
                    I agree to the{' '}
                    <Link to="/terms" target="_blank" className="text-accent underline">Terms</Link> and{' '}
                    <Link to="/privacy" target="_blank" className="text-accent underline">Privacy Policy</Link>.
                  </span>
                </label>
                {errors.terms && <p className="mt-1 text-xs text-danger">{errors.terms}</p>}
              </div>

              <Button type="submit" size="lg" className="w-full" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Registering…
                  </>
                ) : (
                  'Register warranty'
                )}
              </Button>
            </form>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
