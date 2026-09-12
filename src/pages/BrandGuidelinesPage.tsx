import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

/**
 * Brand Guidelines / Style Guide — public reference for partners, media,
 * and integration builders on how to represent the Vireek brand
 * correctly. Every value on this page (colors, fonts, logo files) is
 * pulled from the same source of truth the app itself uses —
 * tailwind.config.js and the CSS custom properties in src/index.css —
 * so this page can never silently drift out of sync with the real
 * product. If those files change, update the constants below to match.
 */

interface ColorToken {
  name: string;
  lightHex: string;
  darkHex?: string;
  usage: string;
}

const ACCENT_COLORS: ColorToken[] = [
  { name: 'Accent — Default (light mode)', lightHex: '#203AD8', usage: 'Primary buttons, links, active states' },
  { name: 'Accent — Default (dark mode)', lightHex: '#6C82FF', usage: 'Same role, tuned for dark backgrounds' },
  { name: 'Accent 50', lightHex: '#EEF1FF', usage: 'Tinted backgrounds, badges' },
  { name: 'Accent 400', lightHex: '#5E72F5', usage: 'Hover accents, icons' },
  { name: 'Accent 700', lightHex: '#1A2FAE', usage: 'Hover state for primary buttons' },
  { name: 'Accent 950', lightHex: '#0D1440', usage: 'High-contrast text on light accent tints' },
];

const CTA_COLORS: ColorToken[] = [
  { name: 'CTA — Default (light mode)', lightHex: '#D6582A', usage: 'Live/urgent moments only — never a generic CTA' },
  { name: 'CTA — Default (dark mode)', lightHex: '#FF8A5A', usage: 'Same role, tuned for dark backgrounds' },
  { name: 'CTA 50', lightHex: '#FDF3EE', usage: 'Tinted backgrounds for alerts' },
  { name: 'CTA 500', lightHex: '#D6582A', usage: 'Active-call and emergency-detection indicators' },
];

const SEMANTIC_COLORS: ColorToken[] = [
  { name: 'Success (light)', lightHex: '#168458', usage: 'Confirmations, positive states' },
  { name: 'Success (dark)', lightHex: '#4AC78C', usage: 'Same role, dark mode' },
  { name: 'Danger (light)', lightHex: '#C83030', usage: 'Errors, destructive actions' },
  { name: 'Danger (dark)', lightHex: '#F06464', usage: 'Same role, dark mode' },
  { name: 'Warning (light)', lightHex: '#B46A14', usage: 'Caution states' },
  { name: 'Warning (dark)', lightHex: '#EBAA46', usage: 'Same role, dark mode' },
];

const NEUTRAL_COLORS: ColorToken[] = [
  { name: 'Background Primary (light)', lightHex: '#FDFCFA', darkHex: '#090A0D', usage: 'Page background' },
  { name: 'Background Secondary (light)', lightHex: '#FFFFFF', darkHex: '#101115', usage: 'Cards, panels' },
  { name: 'Text Primary (light)', lightHex: '#17171A', darkHex: '#F2F1EE', usage: 'Headings, body copy' },
  { name: 'Text Secondary (light)', lightHex: '#676770', darkHex: '#9A9AA3', usage: 'Supporting copy' },
  { name: 'Border (light)', lightHex: '#E7E5E0', darkHex: '#25252C', usage: 'Dividers, card borders' },
];

const LOGO_DONT: { title: string; body: string }[] = [
  { title: 'Recolor the mark', body: 'Never change the logo colors, apply gradients, or place it on a clashing background.' },
  { title: 'Stretch or distort', body: 'Always scale proportionally — never stretch, skew, or rotate the logo.' },
  { title: 'Add effects', body: 'No drop shadows, outlines, glows, or 3D effects added to the mark.' },
  { title: 'Crowd the mark', body: "Keep clear space around the logo at least equal to the mark's own height." },
  { title: 'Recreate it', body: 'Never redraw, trace, or reconstruct the logo — always use the provided files.' },
  { title: 'Combine it with other logos', body: 'Do not merge the Vireek mark with another company\u2019s logo in a way that implies a partnership or merger unless approved in writing.' },
];

const TYPE_SCALE = [
  { label: 'Display / Headings', family: 'Sora', weights: '500, 600, 700, 800', sample: 'Never miss a call again' },
  { label: 'Body / UI', family: 'Inter', weights: '400, 500, 600, 700, 800', sample: 'Answer every call, capture every lead.' },
];

const VOICE_PRINCIPLES = [
  { title: 'Direct, not salesy', body: 'Lead with the concrete outcome (missed calls, booked jobs) rather than adjectives like "revolutionary" or "game-changing."' },
  { title: 'Written for operators', body: 'Assume the reader runs or works at a home-service business — speak in terms of jobs, dispatch, and call volume, not generic SaaS jargon.' },
  { title: 'Confident, not hyped', body: 'State what the product does plainly. Let the specifics (24/7, real numbers, real integrations) do the persuading.' },
  { title: 'Plain language', body: 'Short sentences. No unnecessary acronyms. If a term needs explaining, explain it once and move on.' },
];

const DOWNLOAD_ASSETS = [
  { title: 'Logo — Dark', description: 'For use on light backgrounds.', href: '/assets/logos/logo-dark.png', meta: 'PNG · 1024×1024' },
  { title: 'Logo — Light', description: 'For use on dark backgrounds.', href: '/assets/logos/logo-light.png', meta: 'PNG · 1024×1024' },
  { title: 'Favicon / Mark', description: 'Vector app icon, scales to any size.', href: '/favicon.svg', meta: 'SVG' },
];

function SEO() {
  useSEO({
    title: 'Brand Guidelines — Vireek',
    description:
      "Vireek's brand guidelines: logo usage, color palette, typography, and voice — the reference for partners, media, and integration builders.",
    canonical: 'https://vireek.com/brand',
  });
  return null;
}

function ColorSwatch({ token }: { token: ColorToken }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(token.lightHex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="focus-ring group flex flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary text-left shadow-card transition-shadow hover:shadow-card-hover dark:shadow-card-dark"
    >
      <span
        className="flex h-20 w-full items-end justify-end p-2.5"
        style={{ backgroundColor: token.lightHex }}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/20 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </span>
      </span>
      <span className="flex flex-col gap-1 p-4">
        <span className="text-sm font-semibold text-text-primary">{token.name}</span>
        <span className="font-mono text-xs text-text-secondary">
          {copied ? 'Copied!' : token.lightHex}
          {token.darkHex ? ` · ${token.darkHex}` : ''}
        </span>
        <span className="mt-1 text-xs leading-relaxed text-text-secondary/80">{token.usage}</span>
      </span>
    </button>
  );
}

function ColorSection({ eyebrow, title, tokens }: { eyebrow: string; title: string; tokens: ColorToken[] }) {
  return (
    <div className="mt-14 first:mt-0">
      <p className={eyebrowClass()}>{eyebrow}</p>
      <h3 className="mt-2 text-xl font-bold tracking-tight text-text-primary md:text-2xl">{title}</h3>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tokens.map((token) => (
          <ColorSwatch key={token.name} token={token} />
        ))}
      </div>
    </div>
  );
}

export function BrandGuidelinesPage() {
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
              <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-sm font-semibold text-accent">
                <Sparkles size={16} />
                Brand Guidelines
              </span>
              <h1 className="mt-6 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                How to represent Vireek correctly
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Colors, type, logo usage, and voice — the same reference our own product is built
                from, for partners, media, and anyone integrating with Vireek.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href="#downloads">
                  <Button variant="primary" size="lg" className="gap-2">
                    Download Logo Files
                    <Download size={16} />
                  </Button>
                </a>
                <Link
                  to="/trademark-policy"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  Read the Trademark Policy
                  <ArrowRight size={16} />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Logo */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Logo</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>The mark, on any background</h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Two versions cover every surface — never generate a third by recoloring these.
              </p>
            </motion.div>

            <div className="mt-12 grid gap-6 sm:grid-cols-2">
              <Card className="flex flex-col items-center justify-center gap-6 !bg-white py-16">
                <img src="/assets/logos/logo-dark.png" alt="Vireek logo, dark version" className="h-20 w-20 object-contain" />
                <span className="text-sm font-medium text-neutral-500">On light backgrounds</span>
              </Card>
              <Card className="flex flex-col items-center justify-center gap-6 !bg-[#0A0A0C] py-16">
                <img src="/assets/logos/logo-light.png" alt="Vireek logo, light version" className="h-20 w-20 object-contain" />
                <span className="text-sm font-medium text-neutral-400">On dark backgrounds</span>
              </Card>
            </div>

            <div className="mt-14 grid gap-6 lg:grid-cols-2">
              <div className="rounded-2xl border border-success/30 bg-success/[0.04] p-6 md:p-8">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-success/15 text-success">
                    <Check size={18} />
                  </span>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-success">Do</p>
                </div>
                <ul className="space-y-2 text-sm leading-relaxed text-text-secondary">
                  <li>• Use the provided PNG or SVG files exactly as delivered</li>
                  <li>• Keep clear space around the mark at least equal to its own height</li>
                  <li>• Choose the dark or light version based on background contrast</li>
                  <li>• Scale proportionally, keeping width and height locked together</li>
                </ul>
              </div>
              <div className="rounded-2xl border border-danger/30 bg-danger/[0.04] p-6 md:p-8">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-danger/15 text-danger">
                    <X size={18} />
                  </span>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-danger">Don&apos;t</p>
                </div>
                <ul className="space-y-2 text-sm leading-relaxed text-text-secondary">
                  {LOGO_DONT.map((item) => (
                    <li key={item.title}>
                      <span className="font-medium text-text-primary">{item.title}.</span> {item.body}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Colors */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Color</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>The palette, exactly as shipped</h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Tap any swatch to copy its hex value. These are the live tokens from the product —
                not approximations.
              </p>
            </motion.div>

            <ColorSection eyebrow="Primary" title="Signal Cobalt — Accent" tokens={ACCENT_COLORS} />
            <ColorSection eyebrow="Reserved" title="Signal Copper — Live &amp; urgent moments only" tokens={CTA_COLORS} />
            <ColorSection eyebrow="Semantic" title="Success, danger &amp; warning" tokens={SEMANTIC_COLORS} />
            <ColorSection eyebrow="Neutrals" title="Backgrounds, text &amp; borders" tokens={NEUTRAL_COLORS} />

            <p className="mt-8 text-center text-sm text-text-secondary">
              Signal Copper is reserved for active-call and emergency-detection states across the
              product — please don&apos;t use it as a generic call-to-action color in your own
              materials.
            </p>
          </div>
        </section>

        {/* Typography */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Typography</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Two typefaces, one job each</h2>
            </motion.div>

            <div className="mt-12 space-y-6">
              {TYPE_SCALE.map((type) => (
                <Card key={type.family}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold uppercase tracking-wider text-text-secondary/70">
                      {type.label}
                    </p>
                    <p className="text-xs font-medium text-text-secondary">
                      {type.family} &middot; weights {type.weights}
                    </p>
                  </div>
                  <p
                    className={`mt-4 text-3xl text-text-primary md:text-4xl ${
                      type.family === 'Sora' ? 'font-display font-bold tracking-tight' : 'font-medium'
                    }`}
                  >
                    {type.sample}
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* Voice & tone */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Voice</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>How Vireek sounds in writing</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 grid gap-6 sm:grid-cols-2"
            >
              {VOICE_PRINCIPLES.map((v) => (
                <motion.div key={v.title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="h-full">
                    <h3 className="text-base font-semibold text-text-primary">{v.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{v.body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Downloads */}
        <section id="downloads" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Downloads</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Logo files</h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Need product screenshots or the full press kit too?{' '}
                <Link to="/press" className="font-semibold text-accent hover:underline">
                  Visit the Press &amp; Media page
                </Link>
                .
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 grid gap-6 sm:grid-cols-3"
            >
              {DOWNLOAD_ASSETS.map((asset) => (
                <motion.div key={asset.title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="flex h-full flex-col">
                    <h3 className="text-base font-semibold text-text-primary">{asset.title}</h3>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-text-secondary">{asset.description}</p>
                    <p className="mt-3 text-xs font-medium text-text-secondary/70">{asset.meta}</p>
                    <a href={asset.href} download className="mt-5">
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

        {/* Final CTA */}
        <section className="px-6 pb-24">
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
                Using the Vireek name or logo?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Read the trademark policy for what&apos;s pre-approved and what needs written
                permission first.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/trademark-policy">
                  <Button variant="primary" size="lg" className="shadow-glow-cta gap-2">
                    Read Trademark Policy
                    <ArrowRight size={18} />
                  </Button>
                </Link>
                <Link
                  to="/press"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white/90 transition-colors hover:text-white"
                >
                  Full Press Kit
                  <ArrowRight size={16} />
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Questions? Email ali@vireek.com
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
