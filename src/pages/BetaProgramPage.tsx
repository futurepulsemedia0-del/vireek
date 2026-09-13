import { FormEvent, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Rocket,
  Sparkles,
  MessageSquare,
  Star,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Send,
  Users,
  Zap,
  Mic,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// Beta / Early Access application form. This posts to its own dedicated
// endpoint (kept separate from the /contact form's endpoint) so beta
// applications land in their own inbox/table instead of mixing with
// general support messages. Create a new form at https://submit-form.com
// (or swap this for a Supabase insert / your own API route) and paste the
// resulting endpoint in here before shipping.
const BETA_FORM_ENDPOINT = 'https://submit-form.com/REPLACE_WITH_YOUR_BETA_FORM_ID';

type InterestArea =
  | 'AI Voice & Call Handling'
  | 'Analytics & Reporting'
  | 'Integrations & API'
  | 'Mobile App'
  | 'Something Else'
  | '';

interface BetaFormData {
  fullName: string;
  email: string;
  businessName: string;
  phone: string;
  interestArea: InterestArea;
  message: string;
  source: string;
}

const INITIAL: BetaFormData = {
  fullName: '',
  email: '',
  businessName: '',
  phone: '',
  interestArea: '',
  message: '',
  source: 'beta-program-page',
};

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

const BENEFITS = [
  {
    icon: Rocket,
    title: 'Early access to new features',
    body: 'Try upcoming features — new AI capabilities, dashboards, and integrations — weeks before they\u2019re released to everyone else.',
  },
  {
    icon: MessageSquare,
    title: 'A direct line to our product team',
    body: 'Your feedback goes straight to the people building Vireek, not a support queue. Beta testers help decide what we build next.',
  },
  {
    icon: Zap,
    title: 'Priority support during beta',
    body: 'Beta participants get a faster response time and a dedicated contact for anything that comes up while testing.',
  },
  {
    icon: Star,
    title: 'Founding Beta Tester recognition',
    body: 'Early participants get credited as Founding Beta Testers and get first access to future programs, discounts, and features.',
  },
];

const HOW_IT_WORKS = [
  { icon: Send, step: '01', title: 'Apply in minutes', body: 'Tell us a bit about your business and which area you\u2019re most curious about testing.' },
  { icon: Users, step: '02', title: 'Get invited to a cohort', body: 'We onboard a small group of businesses at a time so every tester gets real attention and their feedback actually gets used.' },
  { icon: Mic, step: '03', title: 'Test and share feedback', body: 'Use the new features in your day-to-day operations and tell us what works, what\u2019s confusing, and what\u2019s missing.' },
  { icon: Sparkles, step: '04', title: 'Help shape the release', body: 'Your feedback directly informs what ships and how — and you keep access to everything you helped test.' },
];

const FAQ_ITEMS = [
  {
    q: 'What does joining the Beta Program actually involve?',
    a: 'You get early access to features we\u2019re still refining, use them as part of your normal workflow, and share feedback with our team — through a short form, a call, or however is easiest for you.',
  },
  {
    q: 'Is there a cost to join?',
    a: 'No. Beta access is free for the features included in the program. You\u2019ll always know upfront if something being tested is part of a paid plan once it fully launches.',
  },
  {
    q: 'Will beta features be stable?',
    a: 'Beta features are further along than internal prototypes but can still change based on feedback, and may have rough edges. We\u2019ll always be clear about what\u2019s in beta versus fully released.',
  },
  {
    q: 'How much time does it take?',
    a: 'As much or as little as you want to give. Even occasional feedback is valuable — there\u2019s no minimum commitment to stay in the program.',
  },
  {
    q: 'Can I leave the program at any time?',
    a: 'Yes. You can opt out of testing new features at any point and continue using the standard, fully released version of Vireek.',
  },
];

function SEO() {
  useSEO({
    title: 'Beta & Early Access Program — Vireek',
    description:
      'Join the Vireek Beta Program for early access to new features, a direct line to our product team, and a say in what we build next.',
    canonical: 'https://vireek.com/beta',
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

export function BetaProgramPage() {
  const [formData, setFormData] = useState<BetaFormData>(INITIAL);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof BetaFormData, boolean>>>({});

  const update = (key: keyof BetaFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((prev) => ({ ...prev, [key]: false }));
  };

  const validate = () => {
    const errors: Partial<Record<keyof BetaFormData, boolean>> = {};
    if (!formData.fullName.trim()) errors.fullName = true;
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) errors.email = true;
    if (!formData.businessName.trim()) errors.businessName = true;
    if (!formData.interestArea) errors.interestArea = true;
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(false);
    if (!validate()) return;
    setLoading(true);
    try {
      const response = await fetch(BETA_FORM_ENDPOINT, {
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
              <p className={eyebrowClass()}>Beta / Early Access Program</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Try What's Next, Before Everyone Else
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Get early access to new Vireek features, a direct line to our product team, and a
                real say in what we build next — no cost to join, no minimum commitment.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href="#apply">
                  <Button variant="primary" size="lg">
                    Apply for early access <ArrowRight size={18} />
                  </Button>
                </a>
                <a
                  href="#how-it-works"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  See how it works
                </a>
              </div>
              <p className="mt-6 flex items-center justify-center gap-1.5 text-xs font-medium text-text-secondary/70">
                <ShieldCheck size={13} className="shrink-0" />
                Free to join. We onboard a small group of businesses at a time.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Benefits */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Why Join</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>What beta testers get</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {BENEFITS.map(({ icon: Icon, title, body }) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="h-full">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={20} />
                    </span>
                    <h3 className="mt-5 text-base font-semibold text-text-primary">{title}</h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">{body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>How It Works</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Four steps to early access</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {HOW_IT_WORKS.map(({ icon: Icon, step, title, body }) => (
                <motion.div key={step} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="relative h-full">
                    <span className="absolute right-6 top-6 text-3xl font-extrabold text-text-primary/[0.06]">
                      {step}
                    </span>
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={24} />
                    </span>
                    <h3 className="mt-5 text-lg font-semibold text-text-primary">{title}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Application form */}
        <section id="apply" className="scroll-mt-24 px-6 py-20 sm:py-24">
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
                    Application Received
                  </h2>
                  <p className="mt-3 text-base leading-relaxed text-text-secondary">
                    Thanks for applying to the Beta Program. We'll reach out by email when the next
                    cohort opens up.
                  </p>
                </div>
              ) : (
                <>
                  <p className={eyebrowClass()}>Apply Now</p>
                  <h2 className={`${sectionHeadingClass()} mt-3`}>Request early access</h2>
                  <p className="mt-3 text-base leading-relaxed text-text-secondary">
                    Tell us a bit about your business and we'll reach out when a spot opens up.
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
                      <Field label="Email" required error={fieldErrors.email} id="email">
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
                      <Field label="Business Name" required error={fieldErrors.businessName} id="businessName">
                        <input
                          id="businessName"
                          type="text"
                          autoComplete="organization"
                          className={inputClass}
                          value={formData.businessName}
                          onChange={(e) => update('businessName', e.target.value)}
                        />
                      </Field>
                      <Field label="Phone (optional)" id="phone">
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

                    <Field label="What would you like early access to?" required error={fieldErrors.interestArea} id="interestArea">
                      <select
                        id="interestArea"
                        className={inputClass}
                        value={formData.interestArea}
                        onChange={(e) => update('interestArea', e.target.value)}
                      >
                        <option value="">Select an area</option>
                        <option value="AI Voice & Call Handling">AI Voice & Call Handling</option>
                        <option value="Analytics & Reporting">Analytics & Reporting</option>
                        <option value="Integrations & API">Integrations & API</option>
                        <option value="Mobile App">Mobile App</option>
                        <option value="Something Else">Something Else</option>
                      </select>
                    </Field>

                    <Field label="Anything specific you want to test? (optional)" id="message">
                      <textarea
                        id="message"
                        rows={4}
                        className={`${inputClass} resize-y`}
                        value={formData.message}
                        onChange={(e) => update('message', e.target.value)}
                      />
                    </Field>

                    {error && (
                      <p className="flex items-center gap-2 text-sm text-danger">
                        <AlertCircle size={16} />
                        Something went wrong. Please try again or email us directly.
                      </p>
                    )}

                    <Button type="submit" variant="primary" size="lg" disabled={loading} className="w-full">
                      {loading ? 'Submitting\u2026' : 'Submit Application'}
                    </Button>
                  </form>
                </>
              )}
            </motion.div>
          </div>
        </section>

        {/* FAQ */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Questions</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Beta Program FAQ</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 space-y-4"
            >
              {FAQ_ITEMS.map(({ q, a }) => (
                <motion.div key={q} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card>
                    <h3 className="text-base font-semibold text-text-primary">{q}</h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">{a}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-24"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)',
              }}
            />
            <div className="relative">
              <Rocket className="mx-auto h-10 w-10 text-white/90" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Be first to try what's next
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Takes two minutes to apply. We'll reach out as soon as a spot opens up.
              </p>
              <div className="mt-9 flex justify-center">
                <a href="#apply">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Apply for early access <ArrowRight size={18} />
                  </Button>
                </a>
              </div>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
