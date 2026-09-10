import { useState, useRef, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Linkedin, Phone, Facebook, Instagram, ArrowRight, CheckCircle2, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SARAH_PHONE } from '@/lib/site';

function RedditIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0Zm5.01 4.744c.688 0 1.25.561 1.25 1.252a1.25 1.25 0 0 1-2.498.015l-2.826-.6a.5.5 0 0 0-.598.348l-1.02 3.06c1.872.07 3.567.646 4.842 1.562.5-.4 1.146-.642 1.85-.642 1.657 0 3 1.343 3 3 0 1.194-.7 2.224-1.71 2.715-.04 3.06-3.42 5.523-7.5 5.523s-7.46-2.464-7.5-5.523C6.7 15.224 6 14.194 6 13c0-1.657 1.343-3 3-3 .704 0 1.35.242 1.85.642 1.275-.916 2.97-1.492 4.842-1.562l-1.02-3.06a.5.5 0 0 0-.598-.348l-2.826.6a1.25 1.25 0 1 1-.04-.348l3.116-.66a1 1 0 0 1 1.196-.696l3.05.646c.18-.46.63-.78 1.158-.78ZM9 13.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm6 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm-3.012 4.146c-.73 0-1.456.062-2.146.18a.375.375 0 1 0 .116.74c1.27-.2 2.79-.2 4.06 0a.375.375 0 1 0 .116-.74c-.69-.118-1.416-.18-2.146-.18Z" />
    </svg>
  );
}

function TikTokIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.6 5.82c-1.05-.9-1.69-2.15-1.75-3.53h-3.05v13.53c0 1.5-1.22 2.72-2.72 2.72a2.72 2.72 0 0 1-2.72-2.72 2.72 2.72 0 0 1 2.72-2.72c.26 0 .51.03.75.1V9.98a5.8 5.8 0 0 0-.75-.05A5.77 5.77 0 0 0 3.28 15.7 5.77 5.77 0 0 0 9.05 21.47a5.77 5.77 0 0 0 5.77-5.77V9.28a8.61 8.61 0 0 0 4.9 1.53V7.76c-1.09 0-2.1-.34-2.92-.94-.05-.03-.1-.06-.15-.1Z" />
    </svg>
  );
}

const SOCIAL_LINKS = [
  { label: 'Vireek on Facebook', href: 'https://www.facebook.com/profile.php?id=61591755299005', Icon: Facebook },
  { label: 'Vireek on Instagram', href: 'https://www.instagram.com/vireek.ai/', Icon: Instagram },
  { label: 'Vireek on Reddit', href: 'https://www.reddit.com/user/Livid_Upstairs5570/', Icon: RedditIcon },
  { label: 'Vireek on LinkedIn', href: 'https://www.linkedin.com/in/ali-moradi-741346339', Icon: Linkedin },
  { label: 'Vireek on TikTok', href: 'https://www.tiktok.com/@ai_vireek?lang=en', Icon: TikTokIcon },
];

const FOOTER_COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '/features' },
      { label: 'AI Lead Qualification', href: '/features/lead-qualification' },
      { label: 'SMS Text-Back', href: '/features/sms-text-back' },
      { label: 'Platform', href: '/platform' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Compare', href: '/compare' },
      { label: 'vs ServiceTitan', href: '/compare/servicetitan' },
      { label: 'vs Housecall Pro', href: '/compare/housecall-pro' },
      { label: 'vs Jobber', href: '/compare/jobber' },
      { label: 'vs Answering Service', href: '/compare/answering-service' },
      { label: 'vs Avoca AI', href: '/compare/avoca-ai' },
      { label: 'Revenue Calculator', href: '/calculator' },
      { label: 'Book a Demo', href: '/demo' },
      { label: 'Security', href: '/security' },
    ],
  },
  {
    title: 'Integrations',
    links: [
      { label: 'All Integrations', href: '/integrations' },
      { label: 'QuickBooks', href: '/integrations/quickbooks' },
      { label: 'Google Calendar', href: '/integrations/google-calendar' },
      { label: 'Stripe', href: '/integrations/stripe' },
      { label: 'Zapier', href: '/integrations/zapier' },
      { label: 'Trust Center', href: '/trust' },
    ],
  },
  {
    title: 'Industries',
    links: [
      { label: 'HVAC', href: '/industries/hvac' },
      { label: 'Plumbing', href: '/industries/plumbing' },
      { label: 'Roofing', href: '/industries/roofing' },
      { label: 'Electrical', href: '/industries/electrical' },
      { label: 'Restoration', href: '/industries/restoration' },
      { label: 'Locksmith', href: '/industries/locksmith' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Blog', href: '/blog' },
      { label: 'Onboarding Guide', href: '/onboarding-guide' },
      { label: 'Glossary', href: '/glossary' },
      { label: 'Case Studies', href: '/case-studies' },
      { label: 'Testimonials', href: '/testimonials' },
      { label: 'Help Center', href: '/help' },
      { label: 'FAQ', href: '/faq' },
      { label: 'AI vs Human Receptionist', href: '/ai-receptionist-vs-human-receptionist' },
      { label: 'About', href: '/about' },
      { label: 'Contact', href: '/contact' },
      { label: 'Status', href: '/status' },
      { label: 'Changelog', href: '/changelog' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
      { label: 'Cookie Policy', href: '/cookies' },
    ],
  },
];

const EMAIL = 'ali@vireek.com';

const EASE = [0.16, 1, 0.0, 1] as const;

type NewsletterState = 'idle' | 'loading' | 'success' | 'error';

function NewsletterSection() {
  const [emailValue, setEmailValue] = useState('');
  const [state, setState] = useState<NewsletterState>('idle');
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const validateEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === 'loading' || state === 'success') return;

    if (!emailValue.trim()) {
      setState('error');
      setMessage('Please enter your email address.');
      inputRef.current?.focus();
      return;
    }

    if (!validateEmail(emailValue)) {
      setState('error');
      setMessage('Please enter a valid email address.');
      inputRef.current?.focus();
      return;
    }

    setState('loading');
    setMessage('');

    try {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      setState('success');
      setMessage("You're subscribed! Check your inbox for a confirmation.");
      setEmailValue('');
    } catch {
      setState('error');
      setMessage('Something went wrong. Please try again.');
    }
  };

  const handleReset = () => {
    if (state === 'success' || state === 'error') {
      setState('idle');
      setMessage('');
    }
  };

  const inputBorderClass =
    state === 'error'
      ? 'border-danger/60 focus-within:border-danger focus-within:shadow-[0_0_0_3px_rgb(var(--danger)/0.12)]'
      : state === 'success'
        ? 'border-success/50 focus-within:border-success'
        : 'border-border focus-within:border-accent/60 focus-within:shadow-[0_0_0_3px_rgb(var(--accent-primary)/0.12)]';

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, ease: EASE }}
      className="relative overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card"
    >
      {/* Ambient gradient backdrop */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          background:
            'radial-gradient(circle at 20% 0%, rgb(var(--accent-primary) / 0.10), transparent 55%), radial-gradient(circle at 80% 100%, rgb(var(--accent-secondary) / 0.08), transparent 50%)',
        }}
      />
      {/* Subtle top highlight line */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />

      <div className="relative p-5 sm:p-7 md:p-10">
        {/* Header */}
        <div className="flex items-start gap-4">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            whileInView={{ scale: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.05 }}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 ring-1 ring-accent/20"
          >
            <Mail className="h-5 w-5 text-accent" />
          </motion.div>
          <div>
            <h3 className="text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
              Get our weekly newsletter
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-text-secondary sm:text-[0.925rem]">
              Stay updated with AI insights, product updates, and industry trends.
            </p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-7" noValidate>
          <div className="flex flex-col gap-3 sm:flex-row">
            {/* Input wrapper */}
            <div className={`group relative flex flex-1 items-center rounded-xl border bg-bg-primary/60 transition-all duration-200 ${inputBorderClass}`}>
              <Mail
                className={`pointer-events-none ml-3.5 h-4 w-4 shrink-0 transition-colors duration-200 ${
                  state === 'error'
                    ? 'text-danger'
                    : state === 'success'
                      ? 'text-success'
                      : 'text-text-secondary/60 group-focus-within:text-accent'
                }`}
              />
              <input
                ref={inputRef}
                type="email"
                value={emailValue}
                onChange={(e) => {
                  setEmailValue(e.target.value);
                  if (state === 'error' || state === 'success') handleReset();
                }}
                placeholder="Enter your email"
                disabled={state === 'loading' || state === 'success'}
                aria-label="Email address"
                aria-invalid={state === 'error'}
                className="w-full bg-transparent py-3.5 pl-3 pr-3 text-[0.95rem] text-text-primary placeholder:text-text-secondary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            {/* Subscribe button */}
            <button
              type="submit"
              disabled={state === 'loading' || state === 'success'}
              className="group relative inline-flex h-[52px] items-center justify-center gap-2 overflow-hidden rounded-xl bg-accent px-6 font-semibold text-white shadow-glow-accent transition-all duration-200 ease-out hover:brightness-110 hover:shadow-[0_10px_30px_-8px_rgb(var(--accent-primary)/0.5)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-80 sm:px-7"
            >
              {/* Shimmer sweep on hover */}
              <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full" />

              <AnimatePresence mode="wait" initial={false}>
                {state === 'loading' ? (
                  <motion.span
                    key="loading"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center gap-2"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Subscribing…</span>
                  </motion.span>
                ) : state === 'success' ? (
                  <motion.span
                    key="success"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.25, ease: EASE }}
                    className="flex items-center gap-2"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Subscribed</span>
                  </motion.span>
                ) : (
                  <motion.span
                    key="idle"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="flex items-center gap-2"
                  >
                    <span>Subscribe</span>
                    <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          </div>

          {/* Feedback messages */}
          <AnimatePresence mode="wait">
            {state === 'error' && message && (
              <motion.p
                key="error-msg"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className="mt-3 flex items-center gap-1.5 text-sm font-medium text-danger"
                role="alert"
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-danger" />
                {message}
              </motion.p>
            )}
            {state === 'success' && message && (
              <motion.p
                key="success-msg"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className="mt-3 flex items-center gap-1.5 text-sm font-medium text-success"
                role="status"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                {message}
              </motion.p>
            )}
          </AnimatePresence>
        </form>

        {/* Trust indicators */}
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-text-secondary/70">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-text-secondary/50" />
            No spam, unsubscribe anytime
          </span>
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-text-secondary/50" />
            Join 2,000+ contractors
          </span>
        </div>
      </div>
    </motion.div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border bg-bg-tertiary">
      <div className="mx-auto max-w-7xl px-6 py-16">
        {/* Newsletter */}
        <NewsletterSection />

        {/* Main footer grid */}
        <div className="mt-12 grid gap-10 sm:mt-16 sm:gap-12 md:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr_1fr]">
          {/* Brand */}
          <div className="max-w-sm">
            <span className="text-xl font-bold tracking-tight text-accent">Vireek</span>
            <p className="mt-4 text-sm leading-relaxed text-text-secondary">
              An AI voice receptionist for home-service businesses. Sarah answers every call, 24/7,
              so you never lose a job to voicemail.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a
                href={`mailto:${EMAIL}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Email ${EMAIL}`}
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
              >
                <Mail size={18} />
              </a>
              <a
                href={SARAH_PHONE}
                aria-label="Call Vireek"
                className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
              >
                <Phone size={18} />
              </a>
              {SOCIAL_LINKS.map(({ label, href, Icon }) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
                >
                  <Icon size={18} />
                </a>
              ))}
            </div>
          </div>

          {/* Navigation columns */}
          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <h3 className="text-sm font-semibold uppercase tracking-wider text-text-primary">
                {col.title}
              </h3>
              <ul className="mt-4 flex flex-col gap-3">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      to={link.href}
                      className="focus-ring inline-flex items-center gap-2 rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
                    >
                      {link.label === 'Status' && (
                        <span className="relative flex h-1.5 w-1.5 shrink-0">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-500 opacity-75" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success-500" />
                        </span>
                      )}
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-10 flex flex-col items-center justify-between gap-4 border-t border-border pt-8 sm:mt-12 sm:flex-row">
          <p className="text-sm text-text-secondary">© 2026 Vireek. All rights reserved.</p>
          <div className="flex flex-wrap items-center gap-4 sm:gap-6">
            <Link
              to="/privacy"
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Privacy Policy
            </Link>
            <Link
              to="/terms"
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Terms of Service
            </Link>
            <Link
              to="/cookies"
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Cookie Policy
            </Link>
            <Link
              to="/trust"
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Trust Center
            </Link>
            <Link
              to="/sitemap"
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Sitemap
            </Link>
            <a
              href={`mailto:${EMAIL}`}
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Contact
            </a>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('vireek:open-consent'))}
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Cookie Preferences
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
