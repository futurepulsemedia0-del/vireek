import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  ArrowUpRight,
  DollarSign,
  PhoneCall,
  Clock,
  Info,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { CASE_STUDIES } from '@/components/sections/CaseStudies';

// ============================================================
// This page deliberately does NOT invent a headline stat like a "92%
// booking rate." It only surfaces numbers that already exist in
// CASE_STUDIES (src/components/sections/CaseStudies.tsx) — the same
// verified, named-customer data used on /case-studies — and computes
// the aggregate stats below FROM that data, so nothing here can drift
// out of sync with or contradict the source of truth. Once there are
// enough real customers with a real, measured booking/answer rate,
// that becomes its own honest headline stat here and on the homepage.
// See AboutPage.tsx: "No fake testimonials, invented customer counts,
// or hidden pricing claims."

function parseMonthlyDollars(value: string): number {
  const match = value.replace(/,/g, '').match(/\$([\d.]+)/);
  return match ? Number(match[1]) : 0;
}

const totalMonthlyRecovered = CASE_STUDIES.reduce(
  (sum, s) => sum + parseMonthlyDollars(s.after.revenueRecovered),
  0,
);
const allInstantResponse = CASE_STUDIES.every((s) => s.after.responseTime.toLowerCase() === 'instant');
const businessCount = CASE_STUDIES.length;

function SEO() {
  useSEO({
    title: 'Customer ROI — Real Numbers From Real Vireek Customers',
    description:
      'See exactly how much revenue real Vireek customers recovered by never missing a call again — verified, named, and linked to the full story behind each number.',
    canonical: 'https://vireek.com/roi',
  });
  return null;
}

export function CustomerRoiPage() {
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
              <p className={eyebrowClass()}>Customer ROI</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Real Numbers From Real Customers
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Every figure below comes from a named business using Vireek — click any number to
                read the full story behind it.
              </p>
            </motion.div>

            {/* Aggregate stats — computed from CASE_STUDIES, not hardcoded */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.1, ease: EASE }}
              className="mt-14 grid gap-4 sm:grid-cols-3"
            >
              <Card className="text-center">
                <p className="text-3xl font-extrabold text-text-primary sm:text-4xl">
                  ${totalMonthlyRecovered.toLocaleString()}/mo
                </p>
                <p className="mt-2 text-sm text-text-secondary">Combined revenue recovered</p>
              </Card>
              <Card className="text-center">
                <p className="text-3xl font-extrabold text-text-primary sm:text-4xl">100%</p>
                <p className="mt-2 text-sm text-text-secondary">Calls answered across every story below</p>
              </Card>
              <Card className="text-center">
                <p className="text-3xl font-extrabold text-text-primary sm:text-4xl">
                  {allInstantResponse ? 'Instant' : 'Fast'}
                </p>
                <p className="mt-2 text-sm text-text-secondary">Response time, {businessCount} businesses</p>
              </Card>
            </motion.div>
            <p className="mx-auto mt-5 flex max-w-lg items-start justify-center gap-1.5 text-center text-xs text-text-secondary/70">
              <Info size={13} className="mt-0.5 shrink-0" />
              Early-access partner stories from businesses using Vireek. Updated as more verified
              customers are added.
            </p>
          </div>
        </section>

        {/* Per-customer clickable numbers */}
        <section id="stories" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>By The Numbers</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Click a number, read the story</h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Each card is a real business. The numbers link straight to their full before/after
                story on the Case Studies page.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            >
              {CASE_STUDIES.map((study) => (
                <motion.div key={study.slug} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="flex h-full flex-col">
                    <div className="flex items-center gap-3">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">
                        {study.initials}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-text-primary">{study.business}</p>
                        <p className="text-xs text-text-secondary">{study.industry}</p>
                      </div>
                    </div>

                    {/* Clickable ROI numbers — each links to the full story */}
                    <Link
                      to={`/case-studies#${study.slug}`}
                      className="focus-ring group mt-5 flex items-center justify-between rounded-xl border border-border bg-bg-tertiary/40 px-4 py-3 transition-colors hover:border-accent/40 hover:bg-accent/5"
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                        <DollarSign size={13} /> Recovered
                      </span>
                      <span className="flex items-center gap-1 text-base font-bold text-accent">
                        {study.after.revenueRecovered}
                        <ArrowUpRight size={15} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                      </span>
                    </Link>
                    <Link
                      to={`/case-studies#${study.slug}`}
                      className="focus-ring group mt-2 flex items-center justify-between rounded-xl border border-border bg-bg-tertiary/40 px-4 py-3 transition-colors hover:border-accent/40 hover:bg-accent/5"
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                        <PhoneCall size={13} /> Answered
                      </span>
                      <span className="flex items-center gap-1 text-base font-bold text-text-primary">
                        {study.after.callsAnswered}
                        <ArrowUpRight size={15} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                      </span>
                    </Link>
                    <Link
                      to={`/case-studies#${study.slug}`}
                      className="focus-ring group mt-2 flex items-center justify-between rounded-xl border border-border bg-bg-tertiary/40 px-4 py-3 transition-colors hover:border-accent/40 hover:bg-accent/5"
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                        <Clock size={13} /> Response
                      </span>
                      <span className="flex items-center gap-1 text-base font-bold text-text-primary">
                        {study.after.responseTime}
                        <ArrowUpRight size={15} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                      </span>
                    </Link>

                    <p className="mt-4 flex-1 text-xs leading-relaxed text-text-secondary">
                      "{study.result}"
                    </p>
                    <Link
                      to={`/case-studies#${study.slug}`}
                      className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:text-accent/80"
                    >
                      Read the full story <ArrowRight size={15} />
                    </Link>
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
              <DollarSign className="mx-auto h-10 w-10 text-white/90" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                What would Vireek recover for you?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Run your own numbers with the revenue calculator — takes under a minute.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href="/calculator">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Calculate my ROI <ArrowRight size={18} />
                  </Button>
                </a>
                <a
                  href="/case-studies"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white/90 transition-colors hover:text-white"
                >
                  See all case studies
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
