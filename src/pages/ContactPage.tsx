import { FormEvent, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, Mail, Phone, Linkedin, ArrowRight, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { SARAH_PHONE } from '@/lib/site';

const EMAIL = 'ali@vireek.com';
const LINKEDIN_URL = 'https://www.linkedin.com/in/ali-moradi-741346339';
const PHONE_DISPLAY = '+1 (650) 910-6703';

type Subject = 'General Question' | 'Sales' | 'Support' | 'Partnership';

interface ContactFormData {
  fullName: string;
  email: string;
  subject: Subject | '';
  message: string;
  source: string;
}

const INITIAL: ContactFormData = {
  fullName: '',
  email: '',
  subject: '',
  message: '',
  source: 'contact-page',
};

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

const FAQ_TEASERS = [
  {
    q: 'How quickly do you respond?',
    a: 'We typically respond within 24 hours. For urgent questions, calling Sarah directly is the fastest way to reach us.',
  },
  {
    q: 'Can I try Vireek before committing?',
    a: 'Yes. You can start a 14-day free trial with no credit card required. See how Sarah handles your calls before choosing a plan.',
  },
  {
    q: 'What types of businesses does Vireek support?',
    a: 'Vireek is built for home-service businesses — HVAC, plumbing, roofing, electrical, and restoration. Sarah is trained on trade-specific workflows, not generic intake scripts.',
  },
];

function SEO() {
  useSEO({
    title: 'Contact Vireek — We\'re Here to Help',
    description: 'Have questions about Vireek? Contact the Vireek team by email, phone, or contact form.',
    canonical: 'https://vireek.com/contact',
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

export function ContactPage() {
  const [formData, setFormData] = useState<ContactFormData>(INITIAL);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof ContactFormData, boolean>>>({});

  const update = (key: keyof ContactFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((prev) => ({ ...prev, [key]: false }));
  };

  const validate = () => {
    const errors: Partial<Record<keyof ContactFormData, boolean>> = {};
    if (!formData.fullName.trim()) errors.fullName = true;
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) errors.email = true;
    if (!formData.subject) errors.subject = true;
    if (!formData.message.trim()) errors.message = true;
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
              <p className={eyebrowClass()}>Get In Touch</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                We're Here to Help
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Questions about Vireek? Reach out — we typically respond within 24 hours.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Contact form + info */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr] lg:gap-12">
              {/* LEFT: Form */}
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
                      Message Sent
                    </h2>
                    <p className="mt-3 text-base leading-relaxed text-text-secondary">
                      Thanks for reaching out. We'll get back to you within 24 hours.
                    </p>
                  </div>
                ) : (
                  <>
                    <h2 className={`${sectionHeadingClass()} mt-0`}>Send Us a Message</h2>
                    <p className="mt-3 text-base leading-relaxed text-text-secondary">
                      Fill out the form below and we'll get back to you as soon as possible.
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

                      <Field label="Subject" required error={fieldErrors.subject} id="subject">
                        <select
                          id="subject"
                          className={inputClass}
                          value={formData.subject}
                          onChange={(e) => update('subject', e.target.value)}
                        >
                          <option value="">Select a subject</option>
                          <option value="General Question">General Question</option>
                          <option value="Sales">Sales</option>
                          <option value="Support">Support</option>
                          <option value="Partnership">Partnership</option>
                        </select>
                      </Field>

                      <Field label="Message" required error={fieldErrors.message} id="message">
                        <textarea
                          id="message"
                          rows={5}
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
                        {loading ? 'Sending\u2026' : 'Send Message'}
                      </Button>
                    </form>
                  </>
                )}
              </motion.div>

              {/* RIGHT: Direct contact info */}
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
                className="flex flex-col gap-6"
              >
                <div className="rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark">
                  <h3 className="text-lg font-semibold text-text-primary">Direct Contact</h3>
                  <div className="mt-6 flex flex-col gap-5">
                    <a
                      href={`mailto:${EMAIL}`}
                      className="focus-ring group flex items-start gap-4 rounded-xl -mx-2 px-2 py-2 transition-colors hover:bg-bg-tertiary"
                    >
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-accent transition-colors group-hover:border-accent/30">
                        <Mail size={20} />
                      </span>
                      <span>
                        <span className="block text-sm font-medium text-text-secondary">Email</span>
                        <span className="text-base font-semibold text-text-primary transition-colors group-hover:text-accent">{EMAIL}</span>
                      </span>
                    </a>

                    <a
                      href={SARAH_PHONE}
                      className="focus-ring group flex items-start gap-4 rounded-xl -mx-2 px-2 py-2 transition-colors hover:bg-bg-tertiary"
                    >
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-accent transition-colors group-hover:border-accent/30">
                        <Phone size={20} />
                      </span>
                      <span>
                        <span className="block text-sm font-medium text-text-secondary">Phone</span>
                        <span className="text-base font-semibold text-text-primary transition-colors group-hover:text-accent">{PHONE_DISPLAY}</span>
                        <span className="mt-1 block text-sm text-text-secondary">Talk to Sarah — see the product in action</span>
                      </span>
                    </a>

                    <a
                      href={LINKEDIN_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="focus-ring group flex items-start gap-4 rounded-xl -mx-2 px-2 py-2 transition-colors hover:bg-bg-tertiary"
                    >
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-accent transition-colors group-hover:border-accent/30">
                        <Linkedin size={20} />
                      </span>
                      <span>
                        <span className="block text-sm font-medium text-text-secondary">LinkedIn</span>
                        <span className="text-base font-semibold text-text-primary transition-colors group-hover:text-accent">Connect with us</span>
                      </span>
                    </a>
                  </div>

                  <div className="mt-8 rounded-xl border border-accent/20 bg-accent/[0.04] px-4 py-3">
                    <p className="text-sm leading-relaxed text-text-secondary">
                      <span className="font-semibold text-accent">Prefer email?</span> We usually reply same-day.
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark">
                  <h3 className="text-lg font-semibold text-text-primary">Not Sure Yet?</h3>
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary">
                    Start a 14-day free trial and hear how Sarah handles your calls — no credit card required.
                  </p>
                  <Link to="/login" className="mt-5 inline-block">
                    <Button variant="primary" size="md" className="gap-2">
                      Start Free Trial
                      <ArrowRight size={16} />
                    </Button>
                  </Link>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* FAQ teaser */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Quick Answers</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Common Questions
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Here are a few things people often ask. For more, visit our full FAQ page.
              </p>
            </motion.div>

            <div className="mt-10 space-y-4">
              {FAQ_TEASERS.map((faq) => (
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
                  <p className="px-5 pb-6 text-base leading-8 text-text-secondary sm:px-6">{faq.a}</p>
                </details>
              ))}
            </div>

            <div className="mt-10 text-center">
              <Link
                to="/faq"
                className="focus-ring inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
              >
                See all FAQs
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
