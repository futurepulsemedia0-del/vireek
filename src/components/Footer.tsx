

import { useId, useState, useRef, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Linkedin, Phone, Facebook, Instagram, ArrowRight, CheckCircle2, Loader2, ShieldCheck, CreditCard } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { SARAH_PHONE } from '@/lib/site';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { PlatformEndorsement, EndorsementStructuredData } from '@/components/brand/PlatformEndorsement';
import { getEndorsementLineForPath } from '@/lib/brand/platformEndorsement';
import { openAccessibilityCenter } from '@/lib/uiEvents';
import { AppInstallCta } from '@/components/AppInstallCta';

const FOOTER_COLUMN_TITLE_KEYS: Record<string, string> = {
  Product: 'footer.product',
  Integrations: 'footer.integrations',
  Industries: 'footer.industries',
  Resources: 'footer.resources',
  Compare: 'nav.compare',
  Company: 'footer.company',
  Legal: 'footer.legal',
};

// Sarah's number, formatted for display next to the tel: link.
// (Same number as SARAH_PHONE — already public elsewhere on the site.)
const SARAH_PHONE_DISPLAY = '+1 (650) 910-6703';

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
      { label: 'WhatsApp & Instagram DMs', href: '/features/whatsapp-instagram-dm' },
      { label: 'Live Escalation', href: '/features/live-escalation' },
      { label: 'Platform', href: '/platform' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Revenue Calculator', href: '/calculator' },
      { label: 'Book a Demo', href: '/demo' },
      { label: 'Security', href: '/security' },
      { label: 'Security Whitepaper', href: '/security/whitepaper' },
      { label: 'Enterprise', href: '/enterprise' },
      { label: 'Switch Guides', href: '/switch' },
      { label: 'Services', href: '/services' },
      { label: 'Free Missed-Call Audit', href: '/audit' },
      { label: 'Contact Sales', href: '/contact-sales' },
      { label: 'Start Free', href: '/signup' },
    ],
  },
  {
title: 'Compare',
    links: [
      { label: 'All Comparisons', href: '/compare' },
      { label: 'Full Feature Matrix', href: '/compare/matrix' },
      { label: 'vs ServiceTitan', href: '/compare/servicetitan' },
      { label: 'vs Housecall Pro', href: '/compare/housecall-pro' },
      { label: 'vs Jobber', href: '/compare/jobber' },
      { label: 'vs Answering Service', href: '/compare/answering-service' },
      { label: 'vs Avoca AI', href: '/compare/avoca-ai' },
      { label: 'vs Sameday AI', href: '/compare/sameday-ai' },
      { label: 'vs Smith.ai', href: '/compare/smith-ai' },
      { label: 'vs Podium', href: '/compare/podium' },
      { label: 'vs Numa', href: '/compare/numa' },
      { label: 'vs Goodcall', href: '/compare/goodcall' },
      { label: 'vs Rosie & My AI Front Desk', href: '/compare/rosie-my-ai-front-desk' },
      { label: 'vs FieldRoutes', href: '/compare/fieldroutes' },
      { label: 'vs Service Fusion', href: '/compare/service-fusion' },
      { label: 'vs Workiz', href: '/compare/workiz' },
      { label: 'vs Dialzara', href: '/compare/dialzara' },
      { label: 'vs Ruby Receptionists', href: '/compare/ruby-receptionists' },
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
      { label: 'HubSpot', href: '/integrations/hubspot' },
      { label: 'Salesforce', href: '/integrations/salesforce' },
      { label: 'Slack', href: '/integrations/slack' },
      { label: 'Twilio', href: '/integrations/twilio' },
      { label: 'Microsoft 365', href: '/integrations/microsoft-365' },
    ],
  },
  {
    title: 'Trust',
    links: [
      { label: 'Trust Center', href: '/trust' },
      { label: 'Compliance Status', href: '/trust/compliance' },
      { label: 'Security Portal', href: '/trust/security' },
      { label: 'How We Verify', href: '/how-we-verify' },
      { label: 'Open Voice Benchmark', href: '/open-voice-benchmark' },
      { label: 'Fair Sale Promise', href: '/fair-sale-promise' },
      { label: 'Verified Badge', href: '/badge' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'Developer Docs', href: '/docs' },
      { label: 'Marketplace', href: '/marketplace' },
      { label: 'SDKs (Node.js & Python)', href: '/sdks' },
      { label: 'Sandbox', href: '/sandbox' },
      { label: 'API Reference', href: '/developers/api-reference' },
      { label: 'Quickstarts', href: '/developers/quickstarts' },
      { label: 'Developer Changelog', href: '/developers/changelog' },
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
      { label: 'Pest Control', href: '/industries/pest-control' },
      { label: 'Lawn Care', href: '/industries/lawn-care' },
      { label: 'Cleaning', href: '/industries/cleaning' },
      { label: 'Pool Service', href: '/industries/pool-service' },
      { label: 'Appliance Repair', href: '/industries/appliance-repair' },
      { label: 'Solar', href: '/industries/solar' },
      { label: 'Painting', href: '/industries/painting' },
      { label: 'All Industries', href: '/industries' },
      { label: 'Service Areas', href: '/locations' },
    ],
  },
  {
    title: 'Use Cases',
    links: [
      { label: 'Missed Calls', href: '/use-cases/missed-calls' },
      { label: 'After-Hours Calls', href: '/use-cases/after-hours' },
      { label: 'Emergency Dispatch', href: '/use-cases/emergency-dispatch' },
      { label: 'Estimate Follow-Up', href: '/use-cases/estimate-follow-up' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Free Resources', href: '/resources' },
      { label: 'State of Home Service Calls Report', href: '/report' },
      { label: 'Customer ROI', href: '/roi' },
      { label: 'Customer Stories', href: '/customers' },
      { label: 'Case Studies', href: '/case-studies' },
      { label: 'Blog', href: '/blog' },
      { label: 'Podcast', href: '/podcast' },
      { label: 'Onboarding Guide', href: '/onboarding-guide' },
      { label: 'System Requirements', href: '/system-requirements' },
      { label: 'Academy', href: '/academy' },
      { label: 'Community', href: '/community' },
      { label: 'Champions', href: '/ambassador' },
      { label: 'Glossary', href: '/glossary' },
      { label: 'Testimonials', href: '/testimonials' },
      { label: 'Help Center', href: '/help' },
      { label: 'FAQ', href: '/faq' },
      { label: 'AI vs Human Receptionist', href: '/ai-receptionist-vs-human-receptionist' },
      { label: 'Status', href: '/status' },
      { label: 'Changelog', href: '/changelog' },
      { label: 'Roadmap', href: '/roadmap' },
      { label: 'Webinars & Events', href: '/webinars' },
      { label: 'Events', href: '/events' },
      { label: 'Insights', href: '/insights' },
      { label: 'Agent Readiness', href: '/agent-readiness' },
    ],
  },
  {
    // New column. "About" and "Contact" moved here from Resources (not
    // removed) since they're company info, not product resources — this
    // also gives Careers/Press/Partners a proper home. Those three pages
    // already exist in src/pages/ (fully built) but had no <Route> and no
    // footer link, so they were unreachable; wire them up in App.tsx
    // alongside this file (see chat) to make these links live.
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Manifesto', href: '/manifesto' },
      { label: 'Leadership', href: '/leadership' },
      { label: 'Careers', href: '/careers' },
      { label: 'Talent Board', href: '/talent' },
      { label: 'Culture & Values', href: '/culture' },
      { label: 'Press', href: '/press' },
      { label: 'Brand Guidelines', href: '/brand' },
      { label: 'Partners', href: '/partners' },
      { label: 'Affiliate Program', href: '/affiliate' },
      { label: 'Referral Program', href: '/referral' },
      { label: 'Beta Program', href: '/beta' },
      { label: 'Contact', href: '/contact' },
    ],
  },
  {
        title: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
      { label: 'MSA', href: '/msa' },
      { label: 'Cookie Policy', href: '/cookies' },
      { label: 'DPA', href: '/dpa' },
      { label: 'GDPR Addendum', href: '/gdpr-dpa' },
      { label: 'Impressum', href: '/impressum' },
      { label: 'Sub-processors', href: '/subprocessors' },
      { label: 'Refund Policy', href: '/refund-policy' },
      { label: 'SLA', href: '/sla' },
      { label: 'Acceptable Use', href: '/acceptable-use-policy' },
      { label: 'Trademark Policy', href: '/trademark-policy' },
      { label: 'DMCA & Copyright', href: '/dmca' },
      { label: 'Vulnerability Disclosure', href: '/vulnerability-disclosure' },
      { label: 'Responsible AI', href: '/responsible-ai' },
      { label: 'AI Call Disclosure', href: '/ai-disclosure' },
      { label: 'Call Recording', href: '/call-recording-consent' },
      { label: 'Data Retention', href: '/data-retention' },
      { label: 'Billing Terms', href: '/billing-terms' },
      { label: 'Disclaimer', href: '/disclaimer' },
      { label: 'Limitation of Liability', href: '/limitation-of-liability' },
      { label: 'IP Policy', href: '/intellectual-property' },
      { label: 'Incident Response', href: '/incident-response' },
      { label: 'Export Control', href: '/export-control' },
      { label: 'CCPA Rights', href: '/ccpa' },
      { label: 'SMS Terms', href: '/sms-terms' },
      { label: 'Data Request', href: '/data-request' },
      { label: 'Accessibility Statement', href: '/accessibility-statement' },
      { label: 'Accessibility', href: '/accessibility' },
      { label: 'Accessibility Conformance', href: '/accessibility/conformance' },
    ],
  },
];

const EMAIL = 'ali@vireek.com';

const EASE = [0.16, 1, 0.0, 1] as const;

type NewsletterState = 'idle' | 'loading' | 'success' | 'error';

function FooterNewsletter() {
  const { t } = useTranslation();
  const statusId = useId();
  const [emailValue, setEmailValue] = useState('');
  const [trap, setTrap] = useState('');
  const [state, setState] = useState<NewsletterState>('idle');
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = state === 'loading' || state === 'success';

  const fail = (text: string) => {
    setState('error');
    setMessage(text);
    inputRef.current?.focus();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const email = emailValue.trim().toLowerCase();
    if (!email) return fail('Please enter your email address.');
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail('Please enter a valid email address.');
    }

    // Honeypot: real visitors never see or fill this field. Bots get a fake success.
    if (trap) {
      setState('success');
      setMessage(t('footer.newsletterSuccess'));
      setEmailValue('');
      return;
    }

    setState('loading');
    setMessage('');
    try {
      const { error } = await supabase.from('newsletter_subscribers').insert({ email });
      if (error && error.code !== '23505') throw error;
      setState('success');
      setMessage(t('footer.newsletterSuccess'));
      setEmailValue('');
    } catch {
      setState('error');
      setMessage('Something went wrong. Please try again.');
    }
  };

  const frameClass =
    state === 'error'
      ? 'border-danger/60 focus-within:border-danger focus-within:shadow-[0_0_0_3px_rgb(var(--danger)/0.12)]'
      : state === 'success'
        ? 'border-success/50'
        : 'border-border hover:border-border focus-within:border-accent/60 focus-within:shadow-[0_0_0_3px_rgb(var(--accent-primary)/0.12)]';

  return (
    <div className="w-full max-w-md lg:max-w-none">
      <h3 className="text-sm font-semibold tracking-tight text-text-primary">{t('footer.newsletterTitle')}</h3>
      <p className="mt-1 text-sm leading-relaxed text-text-secondary">{t('footer.newsletterSubtitle')}</p>

      <form onSubmit={handleSubmit} noValidate className="mt-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <div
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-control border bg-bg-primary px-3 shadow-sm transition-[border-color,box-shadow] duration-200 ${frameClass}`}
        >
          <Mail className="h-4 w-4 shrink-0 text-graphic-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            type="email"
            name="email"
            inputMode="email"
            autoComplete="email"
            maxLength={254}
            value={emailValue}
            onChange={(e) => {
              setEmailValue(e.target.value);
              if (state === 'error') {
                setState('idle');
                setMessage('');
              }
            }}
            placeholder={t('footer.newsletterPlaceholder')}
            disabled={busy}
            aria-label="Email address"
            aria-invalid={state === 'error'}
            aria-describedby={statusId}
            className="h-11 min-w-0 flex-1 bg-transparent text-base text-text-primary placeholder:text-text-placeholder focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm"
          />
        </div>
          <button
            type="submit"
            disabled={busy}
            className="focus-ring inline-flex h-11 w-full shrink-0 items-center justify-center gap-1.5 bg-accent px-5 text-sm font-semibold text-on-accent rounded-control transition-all duration-200 ease-out hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-80 sm:w-auto"
          >
            <AnimatePresence mode="wait" initial={false}>
              {state === 'loading' ? (
                <motion.span
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-1.5"
                >
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>Subscribing…</span>
                </motion.span>
              ) : state === 'success' ? (
                <motion.span
                  key="success"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="flex items-center gap-1.5"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  <span>Subscribed</span>
                </motion.span>
              ) : (
                <motion.span
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="group flex items-center gap-1.5"
                >
                  <span>{t('footer.newsletterButton')}</span>
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>

        {/* Honeypot — hidden from people and assistive tech */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
        </div>

        <div id={statusId} className="mt-2 min-h-[1.25rem]">
          <AnimatePresence mode="wait" initial={false}>
            {message && (
              <motion.p
                key={state}
                role={state === 'error' ? 'alert' : 'status'}
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: EASE }}
                className={`flex items-center gap-1.5 text-xs font-medium ${state === 'error' ? 'text-danger' : 'text-success'}`}
              >
                {state === 'success' && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                {message}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </form>

      <p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-muted">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-graphic-muted" aria-hidden="true" />
        <span>No spam, unsubscribe anytime</span>
        <span aria-hidden="true">·</span>
        <span>Join 2,000+ contractors</span>
      </p>
    </div>
  );
}

export function Footer() {
const { t } = useTranslation();
  const { pathname } = useLocation();
  const showEndorsement = getEndorsementLineForPath(pathname) !== null;
  return (
    <footer className="border-t border-border bg-bg-tertiary">
      <div className="mx-auto max-w-7xl px-6 py-16">

        {/* Brand band — full width, sits above the nav links as its own row
            instead of squeezed into the first grid track, so it reads
            cleanly at every breakpoint including mobile. */}
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start lg:gap-20">
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
              aria-label={`Call Vireek at ${SARAH_PHONE_DISPLAY}`}
              className="focus-ring flex h-10 items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3.5 text-text-secondary transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
            >
              <Phone size={16} />
              <span className="text-sm font-medium">{SARAH_PHONE_DISPLAY}</span>
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
          <div className="flex flex-col gap-6">
            <FooterNewsletter />
            <AppInstallCta variant="compact" />
          </div>
        </div>

        {/* Navigation columns — a balanced CSS multi-column flow (2 columns
            on mobile, 3 on tablet, 5 from desktop up) instead of a rigid
            grid. Columns vary a lot in link count (Product has 14, Legal
            has 3), and with a plain grid the tallest column forces empty
            space next to every shorter one in its row — this flows each
            titled block independently so the layout stays even and never
            looks lopsided or "jumbled" on narrow screens. */}
        <div role="navigation" aria-label="Footer" className="mt-12 columns-2 gap-x-8 sm:mt-14 sm:columns-3 lg:columns-5 lg:gap-x-10">
          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title} className="mb-9 break-inside-avoid last:mb-0">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-text-primary">
                {FOOTER_COLUMN_TITLE_KEYS[col.title] ? t(FOOTER_COLUMN_TITLE_KEYS[col.title]) : col.title}
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
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
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

        {/* Trust + utility row — real, working features only: Stripe is an
            actual payment integration (see src/lib/integrations.ts /
            BillingPage.tsx), CurrencySwitcher is the same live control
            already used on the Pricing page (backed by CurrencyContext),
            and LanguageSwitcher (moved here from Header.tsx) is the same
            live control already used site-wide (backed by i18next). */}
        <div className="mt-10 flex flex-col items-center gap-4 sm:mt-12 sm:flex-row sm:justify-between">
          <span className="flex items-center gap-2 text-xs font-medium text-text-muted">
            <CreditCard className="h-4 w-4 text-graphic-muted" />
            Secure payments powered by Stripe
          </span>
          <div className="flex items-center gap-2">
            <LanguageSwitcher className="!px-3 !py-1.5 !text-xs" />
            <CurrencySwitcher className="!px-3 !py-1.5 !text-xs" />
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-6 flex flex-col items-center gap-5 border-t border-border pt-8 sm:mt-8 sm:flex-row sm:justify-between sm:gap-4">
          <p className="order-2 text-sm text-text-secondary sm:order-1">© {new Date().getFullYear()} Vireek. {t('footer.rightsReserved')}</p>
          <div className="order-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:order-2 sm:justify-end sm:gap-6">
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
              to="/sitemap"
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Sitemap
            </Link>
           
            <button
              type="button"
              onClick={openAccessibilityCenter}
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Accessibility Preferences
            </button>           
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('vireek:open-consent'))}
              className="focus-ring rounded text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Cookie Preferences
            </button>
          </div>
        </div>
        {showEndorsement && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-text-secondary sm:justify-start">
            <PlatformEndorsement />
            <Link to="/legal/company" className="focus-ring rounded underline-offset-2 hover:text-text-primary hover:underline">
              Company information
            </Link>
            <EndorsementStructuredData />
          </div>
        )}
      </div>
    </footer>
  );
}
