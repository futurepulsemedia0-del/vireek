import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Search,
  ChevronDown,
  ArrowRight,
  Mail,
  Phone,
  MessageCircle,
  Rocket,
  PhoneCall,
  LayoutDashboard,
  Users,
  CreditCard,
  Plug,
  Bell,
  ShieldCheck,
  Wrench,
  BookOpen,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { EASE, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { SARAH_PHONE } from '@/lib/site';
import { INDUSTRIES } from '@/lib/industries';

/* ------------------------------------------------------------------ */
/*  Content — Help Center categories & articles                        */
/* ------------------------------------------------------------------ */

const SUPPORT_EMAIL = 'ali@vireek.com';
const PHONE_DISPLAY = '+1 (650) 910-6703';

interface HelpArticle {
  q: string;
  a: string;
}

interface HelpCategory {
  id: string;
  name: string;
  icon: LucideIcon;
  description: string;
  articles: HelpArticle[];
}

const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: 'getting-started',
    name: 'Getting Started',
    icon: Rocket,
    description: 'Create your account, connect your number, and take your first call with Sarah.',
    articles: [
      {
        q: 'How do I create a Vireek account?',
        a: 'Go to the Sign Up page and create your account with a work email and password. You will move straight into a short onboarding flow where you tell Sarah about your business — industry, service area, hours, and how you want calls handled.',
      },
      {
        q: 'Do I need to change my business phone number?',
        a: 'No. Keep the number your customers already know. Most businesses simply forward calls to Vireek (all calls, after-hours only, or overflow when your line is busy) so Sarah answers under the same number.',
      },
      {
        q: 'How long does setup take?',
        a: 'Most businesses are live within about 15 minutes: create an account, complete the Business Profile (services, hours, FAQs, escalation contact), forward your calls, and place a test call to confirm the greeting sounds right.',
      },
      {
        q: 'Can I test Sarah before going live?',
        a: 'Yes. Use the Live Demo on the marketing site or place a call to your forwarded number after setup to hear exactly what your customers will hear, then adjust the script from your Business Profile.',
      },
    ],
  },
  {
    id: 'call-handling',
    name: 'Call Handling & Sarah',
    icon: PhoneCall,
    description: 'How your AI receptionist answers, qualifies, and escalates every call.',
    articles: [
      {
        q: 'What does Sarah actually do on a call?',
        a: 'Sarah answers with your greeting, asks the qualifying questions relevant to your trade (service needed, address, urgency, availability), and captures the details your team needs — then books an appointment, logs a lead, or escalates, depending on what the caller needs.',
      },
      {
        q: 'Can Sarah handle emergency calls?',
        a: 'Yes. Sarah is trained to recognize urgent language, gather the key safety and location details, and immediately flag the call for fast follow-up. Sarah is not a replacement for 911 or licensed emergency dispatch, but she makes sure a real emergency never sits in a voicemail queue.',
      },
      {
        q: 'Can I customize what Sarah says?',
        a: 'Yes, from Dashboard → Business Profile. You control the greeting, service list, hours, FAQ answers, qualifying questions, and who calls get escalated to. Changes take effect on the next call — no redeployment needed.',
      },
      {
        q: 'What happens when Sarah can\u2019t answer a caller\u2019s question?',
        a: 'Sarah will offer to take a message, schedule a callback, or transfer to your designated escalation contact based on the rules you set in Business Profile, rather than guessing or ending the call.',
      },
    ],
  },
  {
    id: 'dashboard',
    name: 'Dashboard & Reporting',
    icon: LayoutDashboard,
    description: 'Where every call, lead, and job lives after Sarah answers the phone.',
    articles: [
      {
        q: 'Where do I see my calls?',
        a: 'Dashboard → Calls shows every conversation Sarah has handled in real time, including a transcript, caller intent, and outcome. New calls appear at the top the moment they finish — no refresh needed.',
      },
      {
        q: 'What\u2019s the difference between Leads and Jobs?',
        a: 'Leads (Dashboard → Leads) are captured inquiries that haven\u2019t been converted yet. Jobs (Dashboard → Jobs) are confirmed, scheduled work with a status you can move through your pipeline (scheduled, in progress, completed, cancelled).',
      },
      {
        q: 'Can I see revenue and performance trends?',
        a: 'Yes. Dashboard → Analytics breaks down call volume, answer rate, lead conversion, and estimated revenue recovered over any date range. Dashboard → Insights adds AI-generated summaries of what changed and why.',
      },
      {
        q: 'Is my dashboard data live?',
        a: 'Yes. Calls, Jobs, and the Overview stat cards update in real time. A small Live / Reconnecting indicator next to the page title shows the current connection status.',
      },
    ],
  },
  {
    id: 'team',
    name: 'Team & Permissions',
    icon: Users,
    description: 'Invite technicians, dispatchers, and office staff with the right access level.',
    articles: [
      {
        q: 'How do I invite a team member?',
        a: 'Go to Dashboard → Team and send an invite by email. The invite includes a secure sign-up link, and you can resend it if it expires before they accept.',
      },
      {
        q: 'Can I limit what a team member sees?',
        a: 'Yes. Roles control access — for example, a technician can be limited to only the jobs assigned to them, while an office manager can see every call, lead, and job across the account.',
      },
      {
        q: 'A team member says they aren\u2019t seeing new calls update live. What\u2019s going on?',
        a: 'Realtime updates are scoped to your account, not to any single login, so this should work automatically. If it doesn\u2019t, ask them to refresh the page once — if the issue persists, contact support with their account email.',
      },
    ],
  },
  {
    id: 'billing',
    name: 'Billing & Plans',
    icon: CreditCard,
    description: 'Plans, usage, invoices, and how to change or cancel your subscription.',
    articles: [
      {
        q: 'How is Vireek priced?',
        a: 'Plans are based on call volume and features. Compare current plans on the Pricing page, or use the Revenue Calculator to estimate what missed calls are costing you today versus a Vireek plan.',
      },
      {
        q: 'Where do I manage billing and invoices?',
        a: 'Dashboard → Billing shows your current plan, usage against your call allowance, and past invoices, and lets you update your payment method or change plans.',
      },
      {
        q: 'What happens if I go over my plan\u2019s call limit?',
        a: 'You\u2019ll get a usage alert (in-app and via the Notification Center) as you approach your limit so you can upgrade before it affects call answering. We don\u2019t cut off calls without warning you first.',
      },
      {
        q: 'Can I cancel anytime?',
        a: 'Yes, from Dashboard → Billing. There\u2019s no long-term contract requirement for standard plans — check your plan details for the exact terms that apply to your account.',
      },
    ],
  },
  {
    id: 'integrations',
    name: 'Integrations',
    icon: Plug,
    description: 'Connect Vireek to the CRM, calendar, and tools you already use.',
    articles: [
      {
        q: 'Does Vireek integrate with my CRM?',
        a: 'Dashboard → Integrations lists the connections available for your plan. Vireek captures structured call and lead data specifically so it can flow into your existing tools instead of living in a separate silo.',
      },
      {
        q: 'Does Sarah book directly onto my calendar?',
        a: 'Yes — appointments booked during a call are written to Dashboard → Calendar and, where connected, synced to your integrated calendar so there\u2019s one source of truth for scheduling.',
      },
      {
        q: 'An integration shows as disconnected. What should I do?',
        a: 'Reconnect it from Dashboard → Integrations — this usually resolves an expired authorization. If it reconnects and then drops again, contact support so we can check the connection logs on our side.',
      },
    ],
  },
  {
    id: 'notifications',
    name: 'Notifications & Alerts',
    icon: Bell,
    description: 'Stay on top of emergency calls, new insights, and account activity.',
    articles: [
      {
        q: 'How do I get notified about an emergency call?',
        a: 'Emergency calls automatically create a notification (bell icon in the dashboard header) and, if enabled, an email or SMS alert. Configure exactly which events notify you at Dashboard → Settings → Notification Preferences.',
      },
      {
        q: 'Can I turn off certain notification types?',
        a: 'Yes. Dashboard → Settings lets you toggle email and SMS alerts independently for emergencies, new bookings, and usage warnings, without turning off in-app notifications.',
      },
      {
        q: 'Where can I see my full notification history?',
        a: 'Dashboard → Notifications keeps a complete, searchable history and lets you mark items as read individually or all at once.',
      },
    ],
  },
  {
    id: 'security',
    name: 'Security & Privacy',
    icon: ShieldCheck,
    description: 'How your account, caller data, and team access are protected.',
    articles: [
      {
        q: 'How is my customer call data protected?',
        a: 'Data is protected with encryption in transit and at rest, strict database-level access rules (Row Level Security) scoped to your account, and role-based permissions so team members only ever see what they\u2019re allowed to. See the full Security page for details.',
      },
      {
        q: 'What is the Audit Log?',
        a: 'Dashboard → Settings → Security records sensitive account changes — team permission changes, job deletions, billing plan changes, business profile edits, and integration connect/disconnect events — as an append-only log for accountability.',
      },
      {
        q: 'What are trusted devices?',
        a: 'When you verify a new device during login, you can mark it as trusted so future sign-ins from that device skip extra verification. Manage or revoke trusted devices anytime from Dashboard → Settings → Security.',
      },
      {
        q: 'Where do I read the full privacy policy?',
        a: 'The complete Privacy Policy and Terms of Service are always available in the site footer and explain exactly what data is collected, why, and how long it\u2019s kept.',
      },
    ],
  },
  {
    id: 'troubleshooting',
    name: 'Troubleshooting',
    icon: Wrench,
    description: 'Fixes for the most common setup and call-handling issues.',
    articles: [
      {
        q: 'Calls aren\u2019t reaching Sarah.',
        a: 'Double-check the call-forwarding number configured with your phone carrier matches the number shown in Dashboard → Business Profile exactly, including country code. Most issues come from a forwarding rule pointing at the wrong number or being scoped to \u201cbusy only\u201d instead of \u201cno answer.\u201d',
      },
      {
        q: 'A caller says Sarah didn\u2019t understand them.',
        a: 'Background noise and heavy accents can occasionally affect recognition. Check the call transcript in Dashboard → Calls — if it\u2019s a recurring pattern rather than a one-off, send us the call ID so we can review it.',
      },
      {
        q: 'I don\u2019t see a booked appointment on my calendar.',
        a: 'Confirm the integration is still connected at Dashboard → Integrations, then check Dashboard → Calendar directly, since a booking always lands there first regardless of external sync status.',
      },
      {
        q: 'I\u2019m not receiving email or SMS alerts.',
        a: 'Check Dashboard → Settings → Notification Preferences to confirm the relevant toggle is on, and check your spam folder for the sending address. If alerts still don\u2019t arrive, contact support.',
      },
    ],
  },
];

const QUICK_LINKS = [
  { label: 'Read the FAQ', href: '/faq', icon: BookOpen },
  { label: 'Book a Demo', href: '/demo', icon: PhoneCall },
  { label: 'Security overview', href: '/security', icon: ShieldCheck },
  { label: 'Contact support', href: '/contact', icon: MessageCircle },
] as const;

/* ------------------------------------------------------------------ */
/*  SEO + structured data                                              */
/* ------------------------------------------------------------------ */

function buildHelpSchema() {
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: HELP_CATEGORIES.flatMap((category) =>
      category.articles.map((article) => ({
        '@type': 'Question',
        name: article.q,
        acceptedAnswer: {
          '@type': 'Answer',
          text: article.a,
        },
      }))
    ),
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://vireek.com/' },
      { '@type': 'ListItem', position: 2, name: 'Help Center', item: 'https://vireek.com/help' },
    ],
  };

  return [faqSchema, breadcrumbSchema];
}

function SEO() {
  useSEO({
    title: 'Help Center — Vireek Docs & Support',
    description:
      'Find answers about Vireek setup, call handling, billing, integrations, notifications, security, and troubleshooting — or reach our support team directly.',
    canonical: 'https://vireek.com/help',
  });

  useEffect(() => {
    const scripts = buildHelpSchema().map((schema) => {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.text = JSON.stringify(schema);
      document.head.appendChild(script);
      return script;
    });
    return () => {
      scripts.forEach((script) => script.remove());
    };
  }, []);

  return null;
}

/* ------------------------------------------------------------------ */
/*  Article accordion item                                             */
/* ------------------------------------------------------------------ */

function HelpArticleItem({
  question,
  answer,
  id,
  isOpen,
  onToggle,
}: {
  question: string;
  answer: string;
  id: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const panelId = `${id}-panel`;
  const buttonId = `${id}-button`;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary/90 shadow-card transition-colors dark:shadow-card-dark">
      <h3>
        <button
          id={buttonId}
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="focus-ring flex w-full items-center justify-between gap-5 rounded-2xl px-5 py-5 text-left sm:px-6"
        >
          <span className="text-base font-semibold leading-7 text-text-primary sm:text-lg">{question}</span>
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
              isOpen ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border bg-bg-tertiary text-text-secondary'
            }`}
          >
            <ChevronDown className={`h-5 w-5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-6 text-base leading-8 text-text-secondary sm:px-6">{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                           */
/* ------------------------------------------------------------------ */

export function HelpCenterPage() {
  const [query, setQuery] = useState('');
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>(HELP_CATEGORIES[0].id);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredCategories = useMemo(() => {
    if (!normalizedQuery) return HELP_CATEGORIES;

    return HELP_CATEGORIES.map((category) => ({
      ...category,
      articles: category.articles.filter(
        (article) =>
          article.q.toLowerCase().includes(normalizedQuery) ||
          article.a.toLowerCase().includes(normalizedQuery) ||
          category.name.toLowerCase().includes(normalizedQuery)
      ),
    })).filter((category) => category.articles.length > 0);
  }, [normalizedQuery]);

  const totalResults = useMemo(
    () => filteredCategories.reduce((sum, category) => sum + category.articles.length, 0),
    [filteredCategories]
  );

  const scrollToCategory = (id: string) => {
    setActiveCategory(id);
    const el = document.getElementById(id);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 104;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero + search */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-5xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <div className="text-center">
              <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
                <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                  <Sparkles className="h-4 w-4 text-accent" />
                  Help Center &amp; Docs
                </div>
                <h1 className="text-balance text-5xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">
                  How can we help?
                </h1>
                <p className="mx-auto mt-6 max-w-3xl text-xl leading-8 text-text-secondary sm:text-2xl">
                  Search setup guides, dashboard how-tos, billing answers, and security details — or reach our team
                  directly.
                </p>

                {/* Search */}
                <div className="mx-auto mt-10 max-w-2xl">
                  <div className="group relative flex items-center rounded-2xl border border-border bg-bg-secondary shadow-card transition-colors focus-within:border-accent/50 dark:shadow-card-dark">
                    <Search className="ml-5 h-5 w-5 shrink-0 text-text-secondary/60 group-focus-within:text-accent" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search for call forwarding, billing, notifications…"
                      aria-label="Search the Help Center"
                      className="w-full bg-transparent py-4 pl-3 pr-5 text-base text-text-primary placeholder:text-text-secondary/50 focus:outline-none"
                    />
                  </div>
                  {normalizedQuery && (
                    <p className="mt-3 text-sm text-text-secondary" role="status">
                      {totalResults > 0
                        ? `${totalResults} article${totalResults === 1 ? '' : 's'} matching "${query.trim()}"`
                        : `No articles matching "${query.trim()}" — try a different term or contact support below.`}
                    </p>
                  )}
                </div>

                {/* Quick links */}
                <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-3">
                  {QUICK_LINKS.map(({ label, href, icon: Icon }) => (
                    <Link
                      key={href}
                      to={href}
                      className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary/80 px-4 py-2.5 text-sm font-semibold text-text-secondary backdrop-blur transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </Link>
                  ))}
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Category nav + articles */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.5fr]">
            <aside className="lg:sticky lg:top-28 lg:self-start">
              <div className="rounded-3xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Browse by topic</p>
                <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary">Jump to a category</h2>
                <nav className="mt-6 flex flex-col gap-1.5" aria-label="Help Center categories">
                  {HELP_CATEGORIES.map((category) => {
                    const Icon = category.icon;
                    const isActive = activeCategory === category.id && !normalizedQuery;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => scrollToCategory(category.id)}
                        className={`focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                          isActive
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {category.name}
                      </button>
                    );
                  })}
                </nav>
                <div className="mt-6 border-t border-border pt-6">
                  <p className="text-sm font-semibold text-text-primary">Still stuck?</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                    Our team typically replies within one business day.
                  </p>
                  <a
                    href={`mailto:${SUPPORT_EMAIL}`}
                    className="focus-ring mt-4 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
                  >
                    <Mail className="h-4 w-4" />
                    {SUPPORT_EMAIL}
                  </a>
                </div>
              </div>
            </aside>

            <div className="space-y-10">
              {filteredCategories.length === 0 && (
                <div className="rounded-3xl border border-border bg-bg-secondary p-10 text-center shadow-card dark:shadow-card-dark">
                  <p className="text-lg font-semibold text-text-primary">No matching articles</p>
                  <p className="mt-2 text-text-secondary">
                    Try a shorter search term, or{' '}
                    <Link to="/contact" className="text-accent hover:underline">
                      contact support
                    </Link>{' '}
                    directly.
                  </p>
                </div>
              )}

              {filteredCategories.map((category, categoryIndex) => {
                const Icon = category.icon;
                return (
                  <motion.section
                    key={category.id}
                    id={category.id}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.45, ease: EASE, delay: Math.min(categoryIndex * 0.06, 0.24) }}
                    className="scroll-mt-28"
                  >
                    <div className="mb-5 flex items-start gap-4">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <h2 className="text-2xl font-bold tracking-tight text-text-primary">{category.name}</h2>
                        <p className="mt-1 text-base leading-7 text-text-secondary">{category.description}</p>
                      </div>
                    </div>
                    <div className="space-y-4">
                      {category.articles.map((article, articleIndex) => {
                        const id = `${category.id}-${articleIndex}`;
                        return (
                          <HelpArticleItem
                            key={article.q}
                            id={id}
                            question={article.q}
                            answer={article.a}
                            isOpen={openItem === id}
                            onToggle={() => setOpenItem(openItem === id ? null : id)}
                          />
                        );
                      })}
                    </div>
                  </motion.section>
                );
              })}
            </div>
          </div>
        </section>

        {/* Industry-specific guides */}
        <section className="px-6 pb-4 pt-4">
          <div className="mx-auto max-w-7xl rounded-[2rem] border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark sm:p-10">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">By industry</p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
              Looking for trade-specific guidance?
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-7 text-text-secondary">
              Each industry page covers the exact call scenarios, qualifying questions, and setup tips for that trade.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {INDUSTRIES.map((industry) => {
                const Icon = industry.icon;
                return (
                  <Link
                    key={industry.slug}
                    to={`/industries/${industry.slug}`}
                    className="focus-ring group flex items-center gap-3 rounded-xl border border-border bg-bg-tertiary/60 p-4 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-text-primary">{industry.name}</span>
                      <span className="block truncate text-xs text-text-secondary">{industry.tagline}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-text-secondary/30 transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
                  </Link>
                );
              })}
            </div>
          </div>
        </section>

        {/* Contact support CTA */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Can&apos;t find your answer?</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Talk to a real person on our team.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Email, call, or send us a message — we&apos;ll help you get Sarah set up and answering calls correctly.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/contact">
                <Button variant="primary" size="lg">
                  Contact Support
                </Button>
              </Link>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                <Mail className="h-4 w-4" />
                {SUPPORT_EMAIL}
              </a>
              <a
                href={SARAH_PHONE}
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                <Phone className="h-4 w-4" />
                {PHONE_DISPLAY}
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
