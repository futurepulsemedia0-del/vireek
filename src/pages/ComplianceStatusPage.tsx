import { useEffect, useRef, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ClipboardCheck, Loader2, MinusCircle, Send } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EASE } from '@/lib/motion';
import {
  COMPLIANCE_UPDATED,
  FRAMEWORKS,
  formatComplianceDate,
  statusSummary,
  type ComplianceFramework,
} from '@/lib/complianceStatus';
import {
  EMPTY_EVIDENCE_FORM,
  FRAMEWORK_OPTIONS,
  LIMITS,
  REQUEST_TYPES,
  isHoneypotTripped,
  localISODate,
  submitEvidenceRequest,
  validateEvidenceRequest,
  type EvidenceFormErrors,
  type EvidenceFormState,
  type FrameworkOptionId,
  type RequestTypeId,
} from '@/lib/evidenceRequest';

const DESCRIPTION =
  "Vireek's current SOC 2, HIPAA and PCI DSS status, stated plainly, plus how to request security documentation for your vendor review.";

function SEO() {
  useEffect(() => {
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', DESCRIPTION);
    document.title = 'Compliance Status | Vireek';
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

function StatusBadge({ framework }: { framework: ComplianceFramework }) {
  const held = framework.status === 'held';
  const Icon = held ? CheckCircle2 : MinusCircle;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold ${
        held ? 'border-success-500/40 bg-success-500/10 text-success-500' : 'border-border bg-bg-tertiary text-text-secondary'
      }`}
    >
      <Icon size={14} aria-hidden="true" />
      {framework.statusLabel}
    </span>
  );
}

function AttestationLine({ framework }: { framework: ComplianceFramework }) {
  const a = framework.attestation;
  if (framework.status !== 'held' || !a) return null;
  return (
    <p className="mt-2 text-xs text-text-secondary">
      {a.reportType} · {a.issuer} · {a.period}
    </p>
  );
}

function StatusTable() {
  return (
    <>
      <div className="hidden overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark md:block">
        <table className="w-full text-left">
          <caption className="sr-only">Vireek compliance status as of {formatComplianceDate()}</caption>
          <thead className="bg-bg-tertiary/60 text-xs uppercase tracking-wide text-text-secondary">
            <tr>
              <th scope="col" className="px-5 py-3 font-semibold">Framework</th>
              <th scope="col" className="px-5 py-3 font-semibold">Vireek status</th>
              <th scope="col" className="px-5 py-3 font-semibold">What this means for your review</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border align-top">
            {FRAMEWORKS.map((f) => (
              <tr key={f.id}>
                <th scope="row" className="w-48 px-5 py-5 text-sm font-semibold text-text-primary">
                  {f.name}
                  <span className="mt-1 block text-xs font-normal leading-relaxed text-text-secondary">{f.what}</span>
                </th>
                <td className="w-72 px-5 py-5">
                  <StatusBadge framework={f} />
                  <p className="mt-2 text-sm leading-relaxed text-text-primary">{f.statement}</p>
                  <AttestationLine framework={f} />
                </td>
                <td className="px-5 py-5 text-sm leading-relaxed text-text-secondary">{f.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label="Compliance status by framework" className="space-y-4 md:hidden">
        {FRAMEWORKS.map((f) => (
          <li key={f.id} className="rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card dark:shadow-card-dark">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-bold text-text-primary">{f.name}</h3>
              <StatusBadge framework={f} />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">{f.what}</p>
            <p className="mt-3 text-sm leading-relaxed text-text-primary">{f.statement}</p>
            <AttestationLine framework={f} />
            <p className="mt-3 border-t border-border pt-3 text-sm leading-relaxed text-text-secondary">{f.meaning}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

function CheckboxGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
  error,
  required,
}: {
  legend: string;
  options: readonly { id: T; label: string }[];
  value: T[];
  onChange: (next: T[]) => void;
  error?: string;
  required?: boolean;
}) {
  const toggle = (id: T) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <fieldset aria-describedby={error ? `${legend}-error` : undefined}>
      <legend className="mb-1.5 text-sm font-medium text-text-primary">
        {legend}
        {required && <span className="text-danger"> *</span>}
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.id}
            className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary hover:border-accent/40"
          >
            <input
              type="checkbox"
              checked={value.includes(o.id)}
              onChange={() => toggle(o.id)}
              className="focus-ring h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
            />
            {o.label}
          </label>
        ))}
      </div>
      {error && (
        <p id={`${legend}-error`} role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

function EvidenceRequestForm() {
  const [form, setForm] = useState<EvidenceFormState>(EMPTY_EVIDENCE_FORM);
  const [errors, setErrors] = useState<EvidenceFormErrors>({});
  const [honeypot, setHoneypot] = useState('');
  const [state, setState] = useState<SubmitState>('idle');
  const [sentTo, setSentTo] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const today = localISODate();

  const set = <K extends keyof EvidenceFormState>(key: K, value: EvidenceFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === 'submitting') return;
    const { errors: found, payload } = validateEvidenceRequest(form);
    setErrors(found);
    if (!payload) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], fieldset input')?.focus(), 0);
      return;
    }
    if (isHoneypotTripped(honeypot)) {
      // Looks like a bot: act as if it worked, send nothing.
      setSentTo(payload.email);
      setState('success');
      return;
    }
    setState('submitting');
    const result = await submitEvidenceRequest(payload);
    if (result.ok) {
      setSentTo(payload.email);
      setState('success');
    } else {
      setState('error');
    }
  };

  const reset = () => {
    setForm(EMPTY_EVIDENCE_FORM);
    setErrors({});
    setHoneypot('');
    setState('idle');
  };

  if (state === 'success') {
    return (
      <div role="status" className="rounded-2xl border border-success-500/40 bg-success-500/10 p-6 text-center sm:p-8">
        <CheckCircle2 className="mx-auto h-8 w-8 text-success-500" aria-hidden="true" />
        <h3 className="mt-3 text-lg font-bold text-text-primary">Request received</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-text-secondary">
          Thanks. We&apos;ll reply to <span className="font-semibold text-text-primary">{sentTo}</span> and tell you plainly what we can and
          can&apos;t provide.
        </p>
        <button type="button" onClick={reset} className="focus-ring mt-5 min-h-[44px] rounded-lg px-4 text-sm font-semibold text-accent hover:text-cta">
          Submit another request
        </button>
      </div>
    );
  }

  const busy = state === 'submitting';

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate aria-busy={busy} className="grid gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Input label="Full name" required autoComplete="name" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} error={errors.fullName} />
        <Input label="Work email" required type="email" autoComplete="email" value={form.email} onChange={(e) => set('email', e.target.value)} error={errors.email} />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Input label="Company" required autoComplete="organization" value={form.companyName} onChange={(e) => set('companyName', e.target.value)} error={errors.companyName} />
        <Input label="Job title" autoComplete="organization-title" value={form.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} error={errors.jobTitle} />
      </div>

      <CheckboxGroup<RequestTypeId>
        legend="What do you need?"
        required
        options={REQUEST_TYPES}
        value={form.requestTypes}
        onChange={(v) => set('requestTypes', v)}
        error={errors.requestTypes}
      />
      <CheckboxGroup<FrameworkOptionId>
        legend="Frameworks your review covers"
        options={FRAMEWORK_OPTIONS}
        value={form.frameworks}
        onChange={(v) => set('frameworks', v)}
      />

      <Input
        label="Needed by"
        type="date"
        min={today}
        value={form.neededBy}
        onChange={(e) => set('neededBy', e.target.value)}
        error={errors.neededBy}
        helperText="Optional. Helps us prioritise around your procurement timeline."
      />
      <Textarea
        label="Details"
        rows={4}
        maxLength={LIMITS.messageMax}
        value={form.message}
        onChange={(e) => set('message', e.target.value)}
        error={errors.message}
        helperText="Optional. Paste specific questions or the name of your questionnaire."
      />

      {/* Honeypot: hidden from people and assistive tech, tempting for bots. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
        </label>
      </div>

      {state === 'error' && (
        <p role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
          We couldn&apos;t send your request. Please try again, or email{' '}
          <a href="mailto:ali@vireek.com" className="font-semibold underline">
            ali@vireek.com
          </a>{' '}
          directly.
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-relaxed text-text-secondary">
          We use these details only to respond to your request. See our <Link to="/privacy" className="font-semibold text-accent hover:text-cta">Privacy Policy</Link>.
        </p>
        <Button type="submit" size="lg" disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              Sending…
            </>
          ) : (
            <>
              <Send size={16} aria-hidden="true" />
              Send request
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

export function ComplianceStatusPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <Link to="/trust" className="mb-6 inline-flex items-center gap-1.5 text-sm font-semibold text-text-secondary hover:text-accent">
                <ArrowLeft size={14} aria-hidden="true" />
                Trust Center
              </Link>
              <div className="mx-auto mb-6 flex w-fit items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <ClipboardCheck className="h-4 w-4 text-accent" aria-hidden="true" />
                Compliance status
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Where Vireek stands on SOC 2, HIPAA and PCI.
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-text-secondary">
                We state what we hold and what we don&apos;t. If a report or attestation is ever obtained, it will be listed here with its
                issuer and period.
              </p>
              <p className="mt-4 text-xs text-text-secondary">Status as of {formatComplianceDate(COMPLIANCE_UPDATED)}</p>
            </motion.div>
          </div>
        </section>

        <div className="mx-auto max-w-5xl space-y-12 px-6 py-12 sm:py-16">
          <section aria-labelledby="summary-title">
            <h2 id="summary-title" className="sr-only">Summary</h2>
            <p className="rounded-2xl border border-accent/30 bg-accent/5 p-5 text-base font-semibold leading-relaxed text-text-primary sm:p-6 sm:text-lg">
              {statusSummary()}
            </p>
          </section>

          <section aria-labelledby="status-title">
            <h2 id="status-title" className="mb-5 text-2xl font-bold tracking-tight text-text-primary">Status by framework</h2>
            <StatusTable />
          </section>

          <section aria-labelledby="available-title" className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark sm:p-8">
            <h2 id="available-title" className="text-xl font-bold tracking-tight text-text-primary sm:text-2xl">What you can review today</h2>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary sm:text-base">
              These documents describe how the platform is built and who touches your data. They are factual descriptions, not certifications.
            </p>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                { to: '/security/whitepaper', label: 'Security whitepaper', text: 'Architecture, encryption, access control and AI data handling.' },
                { to: '/trust', label: 'Trust Center', text: 'Data flow, data location and policy index.' },
                { to: '/subprocessors', label: 'Sub-processor list', text: 'Every third party that touches customer data.' },
                { to: '/dpa', label: 'Data Processing Agreement', text: 'Our standard DPA for enterprise procurement.' },
              ].map((d) => (
                <li key={d.to}>
                  <Link to={d.to} className="focus-ring flex h-full flex-col rounded-xl border border-border p-4 transition-colors hover:border-accent/40">
                    <span className="text-sm font-semibold text-text-primary">{d.label}</span>
                    <span className="mt-1 text-xs leading-relaxed text-text-secondary">{d.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section id="request-evidence" aria-labelledby="request-title" className="scroll-mt-28 rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark sm:p-8">
            <h2 id="request-title" className="text-xl font-bold tracking-tight text-text-primary sm:text-2xl">Request security documentation</h2>
            <p className="mt-3 mb-6 text-sm leading-relaxed text-text-secondary sm:text-base">
              Tell us what your review needs. We&apos;ll respond with what we can provide and say clearly when we can&apos;t, so you can decide
              before you sign up.
            </p>
            <EvidenceRequestForm />
          </section>
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
