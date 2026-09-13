import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  ArrowUpRight,
  Search,
  Map as MapIcon,
  Rocket,
  GitCompare,
  Building2,
  Puzzle,
  BookOpen,
  Building,
  ShieldCheck,
  Mail,
  Phone,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { SARAH_PHONE } from '@/lib/site';
import { BLOG_POSTS } from '@/lib/blog';
import { INDUSTRIES } from '@/lib/industries';
import { INTEGRATIONS } from '@/lib/integrations';
import { COMPETITORS } from '@/lib/competitors';

const EMAIL = 'ali@vireek.com';

interface SiteLink {
  label: string;
  href: string;
  description?: string;
}

interface SiteSection {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  links: SiteLink[];
}

function useSiteSections(): SiteSection[] {
  return useMemo(
    () => [
      {
        id: 'product',
        title: 'Product',
        description: 'What Vireek does, how it works, and how it\u2019s priced.',
        icon: Rocket,
        links: [
          { label: 'Home', href: '/' },
          { label: 'Features', href: '/features' },
          { label: 'AI Lead Qualification', href: '/features/lead-qualification' },
          { label: 'SMS Text-Back', href: '/features/sms-text-back' },
          { label: 'Platform', href: '/platform' },
          { label: 'Services', href: '/services' },
          { label: 'Pricing', href: '/pricing' },
          { label: 'Revenue Calculator', href: '/calculator' },
          { label: 'Book a Demo', href: '/demo' },
          { label: 'Security', href: '/security' },
          { label: 'Brand Guidelines', href: '/brand' },
          { label: 'Trademark Policy', href: '/trademark-policy' },
          { label: 'Enterprise', href: '/enterprise' },
          { label: 'Trust Center', href: '/trust' },
        ],
      },
      {
        id: 'compare',
        title: 'Compare',
        description: 'How Vireek stacks up against other tools and options.',
        icon: GitCompare,
        links: [
            { label: 'Compare Overview', href: '/compare' },
          { label: 'Full Feature Matrix', href: '/compare/matrix' },
          { label: 'AI Receptionist vs. Human Receptionist', href: '/ai-receptionist-vs-human-receptionist' },
          ...COMPETITORS.map((c) => ({ label: `Vireek vs. ${c.name}`, href: `/compare/${c.slug}` })),
        ],
      },
      {
        id: 'industries',
        title: 'Industries',
        description: 'Built for the trades that live and die by the phone.',
        icon: Building2,
        links: [
          { label: 'All Industries', href: '/industries' },
          ...INDUSTRIES.map((i) => ({ label: i.name, href: `/industries/${i.slug}` })),
        ],
      },
      {
        id: 'integrations',
        title: 'Integrations',
        description: 'The tools Vireek connects to in your existing stack.',
        icon: Puzzle,
        links: [
          { label: 'All Integrations', href: '/integrations' },
          ...INTEGRATIONS.map((i) => ({ label: i.name, href: `/integrations/${i.slug}` })),
        ],
      },
      {
        id: 'resources',
        title: 'Blog & Resources',
        description: 'Our best guides on missed calls, dispatch, and running a home service business.',
        icon: BookOpen,
        links: [
          { label: 'Blog Home', href: '/blog' },
          ...BLOG_POSTS.map((p) => ({ label: p.title, href: `/blog/${p.slug}` })),
          { label: 'State of Home Service Calls Report', href: '/report' },
          { label: 'Podcast', href: '/podcast' },
          { label: 'Glossary', href: '/glossary' },
          { label: 'Case Studies', href: '/case-studies' },
          { label: 'Testimonials', href: '/testimonials' },
          { label: 'Onboarding Guide', href: '/onboarding-guide' },
          { label: 'Help Center', href: '/help' },
          { label: 'FAQ', href: '/faq' },
        ],
      },
      {
        id: 'company',
        title: 'Company',
        description: 'Who we are, and how to reach the team behind Vireek.',
        icon: Building,
        links: [
          { label: 'About', href: '/about' },
          { label: 'Culture & Values', href: '/culture' },
          { label: 'Contact', href: '/contact' },
          { label: 'Status', href: '/status' },
          { label: 'Changelog', href: '/changelog' },
          { label: 'Accessibility', href: '/accessibility' },
        ],
      },
      {
        id: 'legal',
        title: 'Legal',
        description: 'Policies covering privacy, terms, and cookies.',
        icon: ShieldCheck,
        links: [
                    { label: 'Privacy Policy', href: '/privacy' },
          { label: 'Terms of Service', href: '/terms' },
          { label: 'Cookie Policy', href: '/cookies' },
          { label: 'DPA', href: '/dpa' },
          { label: 'GDPR Addendum', href: '/gdpr-dpa' },
          { label: 'Sub-processors', href: '/subprocessors' },
          { label: 'Refund & Cancellation Policy', href: '/refund-policy' },
          { label: 'SLA', href: '/sla' },
          { label: 'Acceptable Use Policy', href: '/acceptable-use-policy' },
          { label: 'Vulnerability Disclosure', href: '/vulnerability-disclosure' },
          { label: 'CCPA Rights', href: '/ccpa' },
        ],
      },
    ],
    []
  );
}

function SEO({ sections }: { sections: SiteSection[] }) {
  useSEO({
    title: 'Sitemap — Every Vireek Page in One Place',
    description:
      'Browse every page on Vireek: product and pricing, industries, integrations, competitor comparisons, and our full library of guides for home service businesses.',
    canonical: 'https://vireek.com/sitemap',
  });

  useEffect(() => {
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Vireek Sitemap',
      url: 'https://vireek.com/sitemap',
      hasPart: sections.map((section) => ({
        '@type': 'SiteNavigationElement',
        name: section.title,
        url: section.links.map((link) => `https://vireek.com${link.href}`),
      })),
    };
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify(schema);
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, [sections]);

  return null;
}

function SectionCard({
  section,
  index,
  query,
}: {
  section: SiteSection;
  index: number;
  query: string;
}) {
  const Icon: ComponentType<{ className?: string }> = section.icon;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleLinks = normalizedQuery
    ? section.links.filter((link) => link.label.toLowerCase().includes(normalizedQuery))
    : section.links;

  if (normalizedQuery && visibleLinks.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.45, ease: EASE, delay: Math.min(index * 0.05, 0.3) }}
    >
      <Card className="flex h-full flex-col p-6 hover:-translate-y-0 sm:p-7">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
            <Icon className="h-4.5 w-4.5" />
          </span>
          <h2 className="text-lg font-bold tracking-tight text-text-primary">{section.title}</h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">{section.description}</p>
        <ul className="mt-5 flex-1 space-y-2.5 border-t border-border pt-5">
          {visibleLinks.map((link) => (
            <li key={link.href}>
              <Link
                to={link.href}
                className="focus-ring group flex items-center justify-between gap-2 rounded-lg text-sm text-text-secondary transition-colors hover:text-accent"
              >
                <span className="leading-snug">{link.label}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </motion.div>
  );
}

export function SitemapPage() {
  const sections = useSiteSections();
  const [query, setQuery] = useState('');

  const totalLinks = useMemo(() => sections.reduce((sum, s) => sum + s.links.length, 0), [sections]);
  const normalizedQuery = query.trim().toLowerCase();
  const hasVisibleResults = useMemo(() => {
    if (!normalizedQuery) return true;
    return sections.some((s) => s.links.some((l) => l.label.toLowerCase().includes(normalizedQuery)));
  }, [sections, normalizedQuery]);

  return (
    <>
      <SEO sections={sections} />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-5xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <div className="text-center">
              <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
                <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                  <MapIcon className="h-4 w-4 text-accent" />
                  Sitemap
                </div>
                <h1 className="text-balance text-5xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">
                  Every page on Vireek, in one place
                </h1>
                <p className="mx-auto mt-6 max-w-3xl text-xl leading-8 text-text-secondary sm:text-2xl">
                  Product, industries, integrations, comparisons, and our full library of guides &mdash; {totalLinks}+
                  {' '}pages, organized so you can find exactly what you need.
                </p>

                {/* Search */}
                <div className="mx-auto mt-10 max-w-2xl">
                  <div className="group relative flex items-center rounded-2xl border border-border bg-bg-secondary shadow-card transition-colors focus-within:border-accent/50 dark:shadow-card-dark">
                    <Search className="ml-5 h-5 w-5 shrink-0 text-text-secondary/60 group-focus-within:text-accent" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search every page&hellip;"
                      aria-label="Search the sitemap"
                      className="w-full bg-transparent py-4 pl-3 pr-5 text-base text-text-primary placeholder:text-text-secondary/50 focus:outline-none"
                    />
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Sections grid */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl">
            {!hasVisibleResults ? (
              <div className="rounded-3xl border border-border bg-bg-secondary p-10 text-center shadow-card dark:shadow-card-dark">
                <p className="text-lg font-semibold text-text-primary">No pages found</p>
                <p className="mt-2 text-text-secondary">Try a different search term, or browse the categories below.</p>
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {sections.map((section, index) => (
                  <SectionCard key={section.id} section={section} index={index} query={query} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Contact strip */}
        <section className="px-6 pb-8">
          <div className="mx-auto max-w-5xl rounded-2xl border border-border bg-bg-secondary/60 px-6 py-6 sm:px-8">
            <div className="flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
              <p className="text-sm text-text-secondary">
                Can&rsquo;t find what you&rsquo;re looking for?
              </p>
              <div className="flex flex-wrap items-center justify-center gap-5">
                <a
                  href={`mailto:${EMAIL}`}
                  className="focus-ring inline-flex items-center gap-2 rounded text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  <Mail className="h-4 w-4 text-accent" />
                  {EMAIL}
                </a>
                <a
                  href={SARAH_PHONE}
                  className="focus-ring inline-flex items-center gap-2 rounded text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  <Phone className="h-4 w-4 text-accent" />
                  Call Vireek
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Ready when your customers call</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              See Vireek answer your calls.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Start a free trial, or book a live demo with the team.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/login">
                <Button variant="primary" size="lg">
                  Start Free Trial
                </Button>
              </Link>
              <Link
                to="/demo"
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                Book a demo <ArrowRight className="h-4 w-4" />
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
