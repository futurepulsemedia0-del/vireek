import { motion } from 'framer-motion';
import {
  ArrowRight,
  ShieldCheck,
  Download,
  Newspaper,
  Mail,
  Image as ImageIcon,
  FileText,
  Mic,
  Wrench,
  Globe,
  Copy,
  Check,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

const PRESS_EMAIL = 'ali@vireek.com';

const BOILERPLATE =
  'Vireek is an AI voice receptionist built for home-service businesses — plumbing, HVAC, ' +
  'electrical, roofing, and restoration. Vireek answers every call 24/7, captures lead details, ' +
  'books appointments, and syncs with the CRM tools contractors already use, so a missed call ' +
  'never becomes a lost job.';

const QUICK_FACTS = [
  { label: 'Product', value: 'AI voice receptionist for home-service businesses' },
  { label: 'Industries served', value: 'HVAC, plumbing, roofing, electrical, restoration, locksmith' },
  { label: 'Team', value: 'Remote-first, early-stage' },
  { label: 'Website', value: 'vireek.com' },
  { label: 'Press contact', value: PRESS_EMAIL },
];

type BrandAsset = {
  icon: typeof ImageIcon;
  title: string;
  description: string;
  href: string;
  meta: string;
};

const BRAND_ASSETS: BrandAsset[] = [
  {
    icon: ImageIcon,
    title: 'Logo — Dark',
    description: 'For use on light backgrounds.',
    href: '/assets/logos/logo-dark.png',
    meta: 'PNG · 1024×1024',
  },
  {
    icon: ImageIcon,
    title: 'Logo — Light',
    description: 'For use on dark backgrounds.',
    href: '/assets/logos/logo-light.png',
    meta: 'PNG · 1024×1024',
  },
  {
    icon: FileText,
    title: 'Favicon / Mark',
    description: 'Vector app icon, scales to any size.',
    href: '/favicon.svg',
    meta: 'SVG',
  },
  {
    icon: ImageIcon,
    title: 'Social / OG Card',
    description: 'Preview image used when Vireek links are shared.',
    href: '/og-image.png',
    meta: 'PNG · 1424×752',
  },
];

const PRESS_TOPICS = [
  {
    icon: Wrench,
    title: 'AI in the trades',
    body: 'How AI voice agents are changing customer intake for HVAC, plumbing, roofing, and electrical contractors.',
  },
  {
    icon: Mic,
    title: 'Founder interviews',
    body: 'On-record conversations about building AI infrastructure for an industry software has historically underserved.',
  },
  {
    icon: Globe,
    title: 'The missed-call problem',
    body: 'Data and firsthand stories on how much revenue home-service businesses lose to unanswered calls.',
  },
];

function SEO() {
  useSEO({
    title: 'Press & Media Kit — Vireek',
    description:
      'Press resources for Vireek, the AI voice receptionist for home-service businesses: company boilerplate, brand assets, and media contact.',
    canonical: 'https://vireek.com/press',
  });
  return null;
}

function CopyBoilerplateButton() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(BOILERPLATE);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
    >
      {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
      {copied ? 'Copied' : 'Copy boilerplate'}
    </button>
  );
}

export function PressPage() {
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
              <p className={eyebrowClass()}>Press &amp; Media</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Resources for Journalists and Media
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Company background, brand assets, and a direct line to the team for anyone
                covering AI, home services, or the trades.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href="#brand-assets">
                  <Button variant="primary" size="lg">
                    Download Brand Assets
                  </Button>
                </a>
                <a
                  href={`mailto:${PRESS_EMAIL}?subject=${encodeURIComponent('Press inquiry')}`}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  Email press contact
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Boilerplate + Quick Facts */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1.4fr_1fr]">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className={eyebrowClass()}>Company Boilerplate</p>
              <h2 className={`${sectionHeadingClass()} mt-3`}>About Vireek, in one paragraph</h2>
              <Card className="mt-8">
                <p className="text-base leading-relaxed text-text-secondary">{BOILERPLATE}</p>
                <div className="mt-6">
                  <CopyBoilerplateButton />
                </div>
              </Card>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
            >
              <p className={eyebrowClass()}>Quick Facts</p>
              <h2 className={`${sectionHeadingClass()} mt-3`}>At a glance</h2>
              <Card className="mt-8">
                <dl className="divide-y divide-border">
                  {QUICK_FACTS.map(({ label, value }) => (
                    <div key={label} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                      <dt className="text-xs font-semibold uppercase tracking-wider text-text-secondary/70">
                        {label}
                      </dt>
                      <dd className="text-sm font-medium text-text-primary">{value}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* Brand Assets */}
        <section id="brand-assets" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Brand Assets</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Logos and images, ready to download
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Please use these files as-is — do not recolor, stretch, or alter the mark.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {BRAND_ASSETS.map(({ icon: Icon, title, description, href, meta }) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="flex h-full flex-col">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={24} />
                    </span>
                    <h3 className="mt-5 text-base font-semibold text-text-primary">{title}</h3>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-text-secondary">{description}</p>
                    <p className="mt-3 text-xs font-medium text-text-secondary/70">{meta}</p>
                    <a href={href} download className="mt-5">
                      <Button variant="secondary" size="sm" className="w-full">
                        <Download size={15} />
                        Download
                      </Button>
                    </a>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* In the News */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>In the News</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Press coverage</h2>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-12"
            >
              <Card className="mx-auto max-w-2xl text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                  <Newspaper size={24} />
                </span>
                <h3 className="mt-5 text-lg font-semibold text-text-primary">
                  No press coverage listed yet
                </h3>
                <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-text-secondary">
                  Vireek is early and has not yet been covered by outside press. If you are working
                  on a story about AI, home services, or the trades, we are glad to talk — this
                  section will list coverage here as it happens.
                </p>
              </Card>

              <div className="mt-10 grid gap-6 sm:grid-cols-3">
                {PRESS_TOPICS.map(({ icon: Icon, title, body }) => (
                  <div key={title} className="rounded-2xl border border-border bg-bg-secondary p-6">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={20} />
                    </span>
                    <h4 className="mt-4 text-sm font-semibold text-text-primary">{title}</h4>
                    <p className="mt-2 text-xs leading-relaxed text-text-secondary">{body}</p>
                  </div>
                ))}
              </div>
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
              <h2 className="text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Working on a story?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Reach out for interviews, quotes, product demos, or background on the home-service
                industry. We reply personally, usually the same day.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href={`mailto:${PRESS_EMAIL}?subject=${encodeURIComponent('Press inquiry')}`}>
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    <Mail size={18} />
                    Email {PRESS_EMAIL}
                  </Button>
                </a>
                <Link
                  to="/about"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white/90 transition-colors hover:text-white"
                >
                  Learn about Vireek
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                No PR agency — you'll hear from the actual team.
              </p>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
