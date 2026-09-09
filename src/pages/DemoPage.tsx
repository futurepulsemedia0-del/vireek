import { FormEvent, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertCircle, Users, Sparkles } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { EASE } from '@/lib/motion';

type FormData = {
  fullName: string;
  workEmail: string;
  companyName: string;
  phone: string;
  teamSize: string;
  message: string;
};

const INITIAL: FormData = {
  fullName: '',
  workEmail: '',
  companyName: '',
  phone: '',
  teamSize: '',
  message: '',
};

const TEAM_SIZES = ['1-5', '6-20', '21-50', '50+'];

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

function SEO() {
  useEffect(() => {
    const title = 'Book a Demo | Vireek AI Voice Receptionist';
    const description =
      'Talk to the Vireek team about answering calls, booking jobs, and capturing leads for your home service business. Book a live walkthrough.';
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
    document.title = title;
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

export function DemoPage() {
  const [formData, setFormData] = useState<FormData>(INITIAL);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormData, boolean>>>({});

  const update = (key: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((prev) => ({ ...prev, [key]: false }));
  };

  const validate = () => {
    const errors: Partial<Record<keyof FormData, boolean>> = {};
    if (!formData.fullName.trim()) errors.fullName = true;
    if (!formData.workEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.workEmail)) errors.workEmail = true;
    if (!formData.companyName.trim()) errors.companyName = true;
    if (!formData.teamSize) errors.teamSize = true;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(false);
    if (!validate()) return;
    setLoading(true);
    try {
      // Reuses the same lead-capture endpoint as the homepage signup form,
      // tagged so submissions can be told apart in the inbox/sheet.
      // NOTE: for cleaner separation, point this at its own
      // https://submit-form.com endpoint once you create one for Demo Requests.
      const response = await fetch('https://submit-form.com/USdWD1urW', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, requestType: 'demo_request' }),
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
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto mb-8 max-w-6xl">
            <BackButton />
          </div>
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-start">
            {/* Left: pitch */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
            >
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Users className="h-4 w-4 text-accent" />
                For teams & multi-location businesses
              </div>
              <h1 className="mt-6 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                See Vireek answer real calls, live.
              </h1>
              <p className="mt-6 max-w-lg text-lg leading-8 text-text-secondary">
                If you run a larger team or want to see exactly how Vireek would handle your
                calls before signing up, book a walkthrough with us instead of self-serve
                onboarding.
              </p>
              <ul className="mt-8 space-y-4">
                {[
                  'A live demo tailored to your trade and call volume',
                  'Answers on CRM sync, escalation rules, and setup time',
                  'No pressure — you can still self-serve sign up anytime',
                ].map((item) => (
                  <li key={item} className="flex gap-3 text-sm text-text-secondary">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-8 text-sm text-text-secondary">
                In a hurry?{' '}
                <Link to="/signup" className="focus-ring font-semibold text-accent hover:text-cta">
                  Start your free trial instead
                </Link>
              </p>
            </motion.div>

            {/* Right: form */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE, delay: 0.1 }}
              className="rounded-3xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              {submitted ? (
                <div className="flex flex-col items-center py-10 text-center">
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success-500/10 text-success-500">
                    <Sparkles size={26} />
                  </span>
                  <h2 className="mt-5 text-xl font-bold text-text-primary">Request received</h2>
                  <p className="mt-2 max-w-xs text-sm text-text-secondary">
                    We&apos;ll reach out to schedule a time that works for you, usually within one
                    business day.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate>
                  <h2 className="text-xl font-bold text-text-primary">Tell us about your business</h2>
                  <div className="mt-6 grid gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-1">
                      <label htmlFor="fullName" className="mb-1.5 block text-sm font-medium text-text-primary">
                        Full name
                      </label>
                      <input
                        id="fullName"
                        value={formData.fullName}
                        onChange={(e) => update('fullName', e.target.value)}
                        className={`${inputClass} ${fieldErrors.fullName ? 'border-danger/60' : ''}`}
                        placeholder="Jane Smith"
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <label htmlFor="workEmail" className="mb-1.5 block text-sm font-medium text-text-primary">
                        Work email
                      </label>
                      <input
                        id="workEmail"
                        type="email"
                        value={formData.workEmail}
                        onChange={(e) => update('workEmail', e.target.value)}
                        className={`${inputClass} ${fieldErrors.workEmail ? 'border-danger/60' : ''}`}
                        placeholder="jane@company.com"
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <label htmlFor="companyName" className="mb-1.5 block text-sm font-medium text-text-primary">
                        Company name
                      </label>
                      <input
                        id="companyName"
                        value={formData.companyName}
                        onChange={(e) => update('companyName', e.target.value)}
                        className={`${inputClass} ${fieldErrors.companyName ? 'border-danger/60' : ''}`}
                        placeholder="Smith Plumbing Co."
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-text-primary">
                        Phone <span className="font-normal text-text-secondary">(optional)</span>
                      </label>
                      <input
                        id="phone"
                        type="tel"
                        value={formData.phone}
                        onChange={(e) => update('phone', e.target.value)}
                        className={inputClass}
                        placeholder="(555) 555-5555"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="teamSize" className="mb-1.5 block text-sm font-medium text-text-primary">
                        Team size
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {TEAM_SIZES.map((size) => (
                          <button
                            key={size}
                            type="button"
                            onClick={() => update('teamSize', size)}
                            className={`focus-ring rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
                              formData.teamSize === size
                                ? 'border-accent bg-accent/10 text-accent'
                                : 'border-border text-text-secondary hover:border-accent/40'
                            } ${fieldErrors.teamSize ? 'border-danger/60' : ''}`}
                          >
                            {size}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="message" className="mb-1.5 block text-sm font-medium text-text-primary">
                        Anything specific you want us to cover?{' '}
                        <span className="font-normal text-text-secondary">(optional)</span>
                      </label>
                      <textarea
                        id="message"
                        rows={3}
                        value={formData.message}
                        onChange={(e) => update('message', e.target.value)}
                        className={inputClass}
                        placeholder="E.g. CRM integration, multi-location routing..."
                      />
                    </div>
                  </div>

                  {error && (
                    <div className="mt-4 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                      <AlertCircle size={16} className="shrink-0" />
                      Something went wrong. Please try again.
                    </div>
                  )}

                  <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" disabled={loading}>
                    {loading ? 'Sending…' : 'Request a Demo'}
                  </Button>
                </form>
              )}
            </motion.div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
