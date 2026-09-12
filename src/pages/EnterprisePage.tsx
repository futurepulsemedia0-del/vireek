import { FormEvent, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  FileCheck2,
  Fingerprint,
  Globe2,
  KeyRound,
  Layers,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EnterpriseDemoBookingCalendar } from '@/components/EnterpriseDemoBookingCalendar';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { PRICING_PLANS, SALES_EMAIL } from '@/lib/pricing';

/**
 * Standalone /enterprise page. Separate from /pricing because enterprise
 * buyers evaluate on licensing terms, security posture, and procurement
 * fit — not a plan-comparison grid. This page exists to answer those
 * questions and capture a qualified request, then hands off to the same
 * live-scheduling calendar already used on /contact and /demo.
 *
 * The request form intentionally posts to the same submit-form.com
 * endpoint as ContactPage/SignupForm (not a direct Supabase insert) —
 * that is the one working, already-wired submission path in this app.
 * The `sales_inquiries` table's public INSERT policy exists but nothing
 * in the app currently writes to it directly; matching the established
 * pattern here avoids relying on an untested write path for a
 * high-value lead form.
 */

const ENTERPRISE_PLAN = PRICING_PLANS.find((plan) => plan.id === 'enterprise')!;

type BestTime = 'Morning 8-12' | 'Afternoon 12-5' | 'Evening 5-8' | '';

interface EnterpriseFormData {
  fullName: string;
  email: string;
  companyName: string;
  phone: string;
  teamSize: string;
  locationsCount: string;
  bestTimeToCall: BestTime;
  message: string;
  smsConsent: boolean;
  source: string;
}

const INITIAL: EnterpriseFormData = {
  fullName: '',
  email: '',
  companyName: '',
  phone: '',
  teamSize: '',
  locationsCount: '',
  bestTimeToCall: '',
  message: '',
  smsConsent: false,
  source: 'enterprise-page',
};

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

const LICENSING_TERMS = [
  {
    icon: Layers,
    title: 'Per-location licensing',
    body: 'Every location gets its own phone number, voice configuration, and dispatch routing — billed as one consolidated contract instead of separate subscriptions.',
  },
  {
    icon: Users,
    title: 'Unlimited seats',
    body: 'Add every dispatcher, technician, and manager across your organization at no per-seat cost. Role-based access controls decide who sees what.',
  },
  {
    icon: ShieldCheck,
    title: 'Written SLA',
    body: 'A signed uptime and response-time SLA with defined remediation — not a best-effort promise. Terms are attached to your master service agreement.',
  },
  {
    icon: KeyRound,
    title: 'Dedicated infrastructure options',
    body: 'Isolated call-handling capacity and priority routing for organizations with strict availability requirements, available as a contract add-on.',
  },
  {
    icon: Fingerprint,
    title: 'Custom-trained voice & persona',
    body: 'A voice model and conversation script trained on your brand, service lines, and escalation policies — consistent across every location.',
  },
  {
    icon: Globe2,
    title: 'Procurement-friendly terms',
    body: 'Annual invoicing, purchase orders, and net-30/net-60 terms are available — we work with your finance and legal teams directly.',
  },
];

const COMPLIANCE_LINKS = [
  { label: 'Security overview', href: '/security' },
  { label: 'Trust Center', href: '/trust' },
  { label: 'Data Processing Agreement', href: '/dpa' },
  { label: 'Service Level Agreement', href: '/sla' },
  { label: 'GDPR & DPA details', href: '/gdpr-dpa' },
  { label: 'Subprocessors', href: '/subprocessors' },
];

const ENTERPRISE_FAQS = [
  {
    q: 'How is Enterprise pricing determined?',
    a: 'Pricing is based on total call volume, number of locations, and which optional add-ons (dedicated infrastructure, custom integrations) you need. Submit a request below and we\u2019ll send a proposal within one business day.',
  },
  {
    q: 'Can legal review the contract before we commit?',
    a: 'Yes. We provide a standard master service agreement, DPA, and SLA up front, and we\u2019re used to redlines from procurement and legal teams.',
  },
  {
    q: 'Do you support single sign-on and role-based access?',
    a: 'Enterprise includes role-based access controls today. SSO/SAML is available on request as part of your onboarding — mention it in the form below.',
  },
  {
    q: 'What does onboarding look like for multiple locations?',
    a: 'A dedicated account manager configures voice, scripts, and routing per location and runs a rollout plan so locations go live in stages rather than all at once.',
  },
  {
    q: 'Is there a minimum contract term?',
    a: 'Enterprise agreements are typically annual, invoiced up front or quarterly. Tell us your preferred term in the form and we\u2019ll confirm what\u2019s possible.',
  },
];

function SEO() {
  useSEO({
    title: 'Vireek Enterprise — Licensing, Security & Multi-Location Rollouts',
    description:
      'Vireek Enterprise: per-location licensing, unlimited seats, a written SLA, and dedicated onboarding for multi-location operators. Request access or book a live walkthrough.',
    canonical: 'https://vireek.com/enterprise',
  });
  return null;
}

function Field({
  label,
  required,
  error,
  id,
  children,
}: {
  label: string;
  required?: boolean;
  error?: boolean;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-text-primary">
        {label}
        {required && <span className="text-cta"> *</span>}
      </label>
      {children}
      {error && (
        <p className="mt-1.5 text-xs text-danger">Please enter a valid {label.toLowerCase()}.</p>
      )}
    </div>
  );
}

export function EnterprisePage() {
  const [formData, setFormData] = useState<EnterpriseFormData>(INITIAL);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof EnterpriseFormData, boolean>>>({});

  const update = (key: keyof EnterpriseFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((prev) => ({ ...prev, [key]: false }));
  };

  const validate = () => {
    const errors: Partial<Record<keyof EnterpriseFormData, boolean>> = {};
    if (!formData.fullName.trim()) errors.fullName = true;
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) errors.email = true;
    if (!formData.companyName.trim()) errors.companyName = true;
    if (!formData.phone.trim()) errors.phone = true;
    if (!formData.smsConsent) errors.smsConsent = true;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(false);
    if (!validate()) return;
    setLoading(true);
    try {
      const response = await fetch('https://submit-form.com/USdWD1urW', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (response.ok) {
        setSubmitted(true);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <span className="inline-flex items-center gap-2 rounded-full border border-cta/40 bg-cta/10 px-4 py-1.5 text-sm font-semibold text-cta">
                <Building2 size={16} />
                Vireek Enterprise
              </span>
              <h1 className="mt-6 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                One contract. Every location. A written SLA.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Built for multi-location operators who need one system across every branch —
                unlimited seats, a custom-trained voice, and licensing terms your procurement
                team can actually sign off on.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href="#request-access">
                  <Button variant="primary" size="lg" className="shadow-glow-cta gap-2">
                    Request Enterprise Access
                    <ArrowRight size={18} />
                  </Button>
                </a>
                <a href="#live-demo">
                  <Button variant="secondary" size="lg">
                    Book a live walkthrough
                  </Button>
                </a>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-text-secondary/70">
                <ShieldCheck size={13} className="shrink-0" />
                Starting from ${ENTERPRISE_PLAN.startingAt}/mo &middot; response within 1 business day
              </p>
            </motion.div>
          </div>
        </section>

        {/* Licensing terms grid */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-3xl text-center"
            >
              <p className={eyebrowClass()}>Licensing</p>
              <h2 className={sectionHeadingClass()}>Terms built for how you actually buy software</h2>
              <p className={bodyClass()}>
                Enterprise replaces the per-plan checkout with a single agreement covering every
                location, with the details your legal and finance teams will ask for up front.
              </p>
            </motion.div>

            <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {LICENSING_TERMS.map((term, index) => (
                <motion.div
                  key={term.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.5, delay: index * 0.06, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary p-7 shadow-card dark:shadow-card-dark"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
                    <term.icon size={20} />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold text-text-primary">{term.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{term.body}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* What's included, reusing the single source of truth from lib/pricing.ts */}
        <section className="px-6 pb-20 sm:pb-24">
          <div className="mx-auto max-w-5xl rounded-3xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark md:p-12">
            <div className="grid gap-10 md:grid-cols-2 md:items-center">
              <div>
                <p className={eyebrowClass()}>Everything included</p>
                <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
                  {ENTERPRISE_PLAN.tagline}
                </h2>
                <p className="mt-4 text-sm leading-relaxed text-text-secondary">
                  {ENTERPRISE_PLAN.minutes} minutes, {ENTERPRISE_PLAN.seats.toLowerCase()}, and{' '}
                  {ENTERPRISE_PLAN.locations.toLowerCase()} — {ENTERPRISE_PLAN.overage?.toLowerCase()}.
                </p>
                <Link
                  to="/pricing"
                  className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
                >
                  Compare against every plan
                  <ArrowRight size={14} />
                </Link>
              </div>
              <ul className="grid gap-3">
                {ENTERPRISE_PLAN.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm text-text-primary">
                    <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-accent" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Security & compliance cross-links */}
        <section className="px-6 pb-20 sm:pb-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>For legal & security review</p>
              <h2 className={sectionHeadingClass()}>Everything your reviewers need, up front</h2>
              <p className={bodyClass()}>
                No need to wait on a call to start your security review — these documents are
                public today.
              </p>
            </motion.div>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              {COMPLIANCE_LINKS.map((link) => (
                <Link
                  key={link.href}
                  to={link.href}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  <FileCheck2 size={15} className="text-text-secondary" />
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Live demo booking */}
        <section id="live-demo" className="scroll-mt-24 px-6 pb-20 sm:pb-24">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>See it live</p>
              <h2 className={sectionHeadingClass()}>Prefer to talk it through first?</h2>
              <p className={bodyClass()}>
                Book 30 minutes with our team — pick a time on our real calendar and it&apos;s
                confirmed instantly, no back-and-forth.
              </p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-10"
            >
              <EnterpriseDemoBookingCalendar
                heading="Book an enterprise walkthrough"
                description="30 minutes with our team — pick whatever works for you and it's confirmed instantly."
              />
            </motion.div>
          </div>
        </section>

        {/* Request access form */}
        <section id="request-access" className="scroll-mt-24 px-6 pb-20 sm:pb-24">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark md:p-12"
            >
              {submitted ? (
                <div className="flex flex-col items-center py-12 text-center">
                  <span className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10 text-success">
                    <CheckCircle2 size={40} />
                  </span>
                  <h2 className="mt-6 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
                    Request Received
                  </h2>
                  <p className="mt-3 text-base leading-relaxed text-text-secondary">
                    A member of our enterprise team will reach out within one business day with a
                    proposal tailored to your locations and volume.
                  </p>
                </div>
              ) : (
                <>
                  <p className={`${eyebrowClass()} text-center`}>Request Access</p>
                  <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                    Tell us about your organization
                  </h2>
                  <p className={`${bodyClass()} mx-auto text-center`}>
                    We&apos;ll follow up with pricing and a proposed rollout plan.
                  </p>

                  <form onSubmit={handleSubmit} noValidate className="mt-8 grid gap-5">
                    <input type="hidden" name="source" value={formData.source} />

                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="Full Name" required error={fieldErrors.fullName} id="fullName">
                        <input
                          id="fullName"
                          type="text"
                          autoComplete="name"
                          className={inputClass}
                          value={formData.fullName}
                          onChange={(e) => update('fullName', e.target.value)}
                        />
                      </Field>
                      <Field label="Work Email" required error={fieldErrors.email} id="email">
                        <input
                          id="email"
                          type="email"
                          autoComplete="email"
                          className={inputClass}
                          value={formData.email}
                          onChange={(e) => update('email', e.target.value)}
                        />
                      </Field>
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="Company / Brand Name" required error={fieldErrors.companyName} id="companyName">
                        <input
                          id="companyName"
                          type="text"
                          autoComplete="organization"
                          className={inputClass}
                          value={formData.companyName}
                          onChange={(e) => update('companyName', e.target.value)}
                        />
                      </Field>
                      <Field label="Phone" required error={fieldErrors.phone} id="phone">
                        <input
                          id="phone"
                          type="tel"
                          autoComplete="tel"
                          className={inputClass}
                          value={formData.phone}
                          onChange={(e) => update('phone', e.target.value)}
                        />
                      </Field>
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="Number of Locations" id="locationsCount">
                        <select
                          id="locationsCount"
                          className={inputClass}
                          value={formData.locationsCount}
                          onChange={(e) => update('locationsCount', e.target.value)}
                        >
                          <option value="">Select a range</option>
                          <option value="4-10 locations">4–10 locations</option>
                          <option value="11-25 locations">11–25 locations</option>
                          <option value="26-50 locations">26–50 locations</option>
                          <option value="50+ locations">50+ locations</option>
                        </select>
                      </Field>
                      <Field label="Team Size" id="teamSize">
                        <select
                          id="teamSize"
                          className={inputClass}
                          value={formData.teamSize}
                          onChange={(e) => update('teamSize', e.target.value)}
                        >
                          <option value="">Select a range</option>
                          <option value="16-50 seats">16–50 seats</option>
                          <option value="51-150 seats">51–150 seats</option>
                          <option value="151-500 seats">151–500 seats</option>
                          <option value="500+ seats">500+ seats</option>
                        </select>
                      </Field>
                    </div>

                    <Field label="Best Time to Call" id="bestTimeToCall">
                      <select
                        id="bestTimeToCall"
                        className={inputClass}
                        value={formData.bestTimeToCall}
                        onChange={(e) => update('bestTimeToCall', e.target.value as BestTime)}
                      >
                        <option value="">Select a time</option>
                        <option value="Morning 8-12">Morning 8-12</option>
                        <option value="Afternoon 12-5">Afternoon 12-5</option>
                        <option value="Evening 5-8">Evening 5-8</option>
                      </select>
                    </Field>

                    <Field label="What should we know before we call?" id="message">
                      <textarea
                        id="message"
                        rows={4}
                        placeholder="Current phone/CRM setup, timeline, specific requirements..."
                        className={`${inputClass} resize-y`}
                        value={formData.message}
                        onChange={(e) => update('message', e.target.value)}
                      />
                    </Field>

                    {/* SMS / TCPA consent checkbox */}
                    <div>
                      <label
                        htmlFor="smsConsent"
                        className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-text-secondary"
                      >
                        <input
                          id="smsConsent"
                          type="checkbox"
                          checked={formData.smsConsent}
                          onChange={(e) => {
                            setFormData((prev) => ({ ...prev, smsConsent: e.target.checked }));
                            if (fieldErrors.smsConsent)
                              setFieldErrors((prev) => ({ ...prev, smsConsent: false }));
                          }}
                          className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded-md border border-border bg-bg-primary text-accent transition-colors focus-visible:border-accent"
                        />
                        <span>
                          I agree to receive calls and SMS messages from Vireek regarding this
                          enterprise inquiry. Message and data rates may apply. Reply STOP to opt
                          out. See our{' '}
                          <Link
                            to="/privacy"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-accent hover:underline"
                          >
                            Privacy Policy
                          </Link>{' '}
                          and{' '}
                          <Link
                            to="/terms"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-accent hover:underline"
                          >
                            Terms of Service
                          </Link>
                          .
                        </span>
                      </label>
                      {fieldErrors.smsConsent && (
                        <p className="mt-1.5 text-xs text-danger">
                          You must agree to the consent terms to continue.
                        </p>
                      )}
                    </div>

                    {error && (
                      <p className="flex items-center gap-2 text-sm text-danger">
                        <AlertCircle size={16} />
                        Something went wrong. Please try again or email{' '}
                        <a href={`mailto:${SALES_EMAIL}`} className="font-semibold underline">
                          {SALES_EMAIL}
                        </a>
                        .
                      </p>
                    )}

                    <Button type="submit" variant="primary" size="lg" disabled={loading} className="w-full">
                      {loading ? 'Sending\u2026' : 'Request Enterprise Access'}
                    </Button>
                  </form>
                </>
              )}
            </motion.div>
          </div>
        </section>

        {/* FAQ */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Common Questions</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Enterprise FAQ</h2>
            </motion.div>

            <div className="mt-10 space-y-4">
              {ENTERPRISE_FAQS.map((faq) => (
                <details
                  key={faq.q}
                  className="group rounded-2xl border border-border bg-bg-secondary/90 shadow-card transition-colors dark:shadow-card-dark"
                >
                  <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-5 rounded-2xl px-5 py-5 text-left sm:px-6">
                    <span className="text-base font-semibold leading-7 text-text-primary sm:text-lg">{faq.q}</span>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-secondary transition-transform duration-200 group-open:rotate-180">
                      <ChevronDown className="h-5 w-5" />
                    </span>
                  </summary>
                  <p className="px-5 pb-5 text-sm leading-relaxed text-text-secondary sm:px-6">{faq.a}</p>
                </details>
              ))}
            </div>

            <p className="mt-8 text-center text-sm text-text-secondary">
              Not ready for Enterprise yet?{' '}
              <Link to="/pricing" className="font-semibold text-accent hover:underline">
                See all plans
              </Link>{' '}
              or{' '}
              <Link to="/contact" className="font-semibold text-accent hover:underline">
                contact us
              </Link>
              .
            </p>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
