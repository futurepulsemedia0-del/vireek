import { Navigate, useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Check, Minus, ShieldCheck, Sparkles, X } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { COMPETITORS, getCompetitorBySlug, type FeatureValue } from '@/lib/competitors';

/* ------------------------------------------------------------------ */
/*  Feature table cell icon (mirrors src/components/sections/Comparison.tsx) */
/* ------------------------------------------------------------------ */

function FeatureIcon({ value, highlight }: { value: FeatureValue; highlight?: boolean }) {
  if (value === 'yes')
    return <Check size={18} className={`shrink-0 ${highlight ? 'text-accent' : 'text-success-500'}`} strokeWidth={2.5} />;
  if (value === 'partial')
    return <Minus size={18} className="shrink-0 text-text-secondary/40" strokeWidth={2.5} />;
  return <X size={18} className="shrink-0 text-danger/50" strokeWidth={2.5} />;
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function CompetitorPage() {
  const { slug } = useParams<{ slug: string }>();
  const competitor = getCompetitorBySlug(slug);

  // Hooks must run unconditionally on every render, so call useSEO before
  // the early return — it no-ops harmlessly if competitor is undefined
  // because we redirect away immediately after.
  useSEO({
    title: competitor?.seoTitle ?? 'Compare Vireek | Vireek',
    description: competitor?.seoDescription ?? 'Compare Vireek, the AI voice receptionist for home-service businesses, to other tools.',
        canonical: `https://vireek.com/compare/${slug ?? ''}`,
  });

  if (!competitor) {
    return <Navigate to="/compare" replace />;
  }

  const { name, category, summary, builtFor, icon: Icon, isVoiceAICompetitor, featureRows, positioning, worksWellTogether, faq } = competitor;
  const otherCompetitors = COMPETITORS.filter((c) => c.slug !== competitor.slug);

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton fallback="/compare" />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-1.5 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Icon className="h-4 w-4 text-accent" />
                {category}
              </div>
              <p className={eyebrowClass()}>The Comparison</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Vireek vs {name}
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                {summary}
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">Start Free Trial</Button>
                </Link>
                <Link
                  to="/pricing"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  View pricing
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* What is {name}? */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-2 lg:gap-8">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <p className={eyebrowClass()}>What {name} Is</p>
              <h2 className="mt-2 text-xl font-bold text-text-primary sm:text-2xl">{category}</h2>
              <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:text-base">{summary}</p>
              <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:text-base">
                <span className="font-semibold text-text-primary">Built for: </span>
                {builtFor}
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
              className="rounded-2xl border border-accent/25 bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <p className={eyebrowClass()}>What Vireek Is</p>
              <h2 className="mt-2 text-xl font-bold text-text-primary sm:text-2xl">AI voice receptionist for the trades</h2>
              <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:text-base">
                Vireek answers every inbound call, 24/7, with a trade-trained AI receptionist named Sarah. She triages
                emergencies, books appointments straight onto your calendar, and syncs the details to your dashboard —
                no manual data entry, no missed calls.
              </p>
              {worksWellTogether && (
                <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:text-base">{worksWellTogether}</p>
              )}
            </motion.div>
          </div>
        </section>

        {/* Feature comparison table (operations tools) OR positioning cards (Avoca AI) */}
        {!isVoiceAICompetitor && featureRows && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-5xl">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="mx-auto max-w-2xl text-center"
              >
                <p className={`${eyebrowClass()} text-center`}>Side by Side</p>
                <h2 className={`${sectionHeadingClass()} mt-3 text-center text-2xl sm:text-3xl`}>
                  Vireek vs {name} on phone handling
                </h2>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
                className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
              >
                {/* Desktop table */}
                <div className="hidden md:block">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border bg-bg-tertiary">
                        <th className="px-6 py-5 text-left text-sm font-semibold text-text-secondary">Capability</th>
                        <th className="rounded-t-xl bg-accent/5 px-6 py-5 text-center text-sm font-semibold text-accent">
                          Vireek
                        </th>
                        <th className="px-6 py-5 text-center text-sm font-semibold text-text-secondary">{name}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {featureRows.map((row, i) => (
                        <tr
                          key={row.feature}
                          className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? 'bg-bg-secondary' : 'bg-bg-tertiary/30'}`}
                        >
                          <td className="px-6 py-4 text-sm font-medium text-text-primary">{row.feature}</td>
                          <td className="bg-accent/5 px-6 py-4 text-center">
                            <div className="flex justify-center">
                              <FeatureIcon value={row.vireek} highlight />
                            </div>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <div className="flex justify-center">
                              <FeatureIcon value={row.competitor} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="space-y-4 p-5 md:hidden">
                  {[
                    { key: 'vireek' as const, label: 'Vireek', highlight: true },
                    { key: 'competitor' as const, label: name, highlight: false },
                  ].map((col) => (
                    <div
                      key={col.key}
                      className={`rounded-xl border p-4 ${col.highlight ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-tertiary/50'}`}
                    >
                      <h3 className={`text-sm font-bold ${col.highlight ? 'text-accent' : 'text-text-primary'}`}>
                        {col.label}
                      </h3>
                      <ul className="mt-3 space-y-2.5">
                        {featureRows.map((row) => (
                          <li key={row.feature} className="flex items-center gap-2.5">
                            <FeatureIcon value={row[col.key]} highlight={col.highlight} />
                            <span className="text-xs text-text-secondary">{row.feature}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </motion.div>
              <p className="mx-auto mt-4 max-w-2xl text-center text-xs text-text-secondary/70">
                Comparison reflects each product\u2019s core, publicly described focus as of this writing. Feature sets
                change — see {name}\u2019s own site for their current, complete feature list.
              </p>
            </div>
          </section>
        )}

        {isVoiceAICompetitor && positioning && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-5xl">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="mx-auto max-w-2xl text-center"
              >
                <p className={`${eyebrowClass()} text-center`}>How They Differ</p>
                <h2 className={`${sectionHeadingClass()} mt-3 text-center text-2xl sm:text-3xl`}>
                  Vireek vs {name}: two AI voice agents, different focus
                </h2>
              </motion.div>

              <div className="mt-10 grid gap-5 sm:grid-cols-1 lg:grid-cols-3">
                {positioning.map((point, index) => (
                  <motion.div
                    key={point.title}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.45, delay: index * 0.08, ease: EASE }}
                    className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
                  >
                    <h3 className="text-base font-semibold text-text-primary">{point.title}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{point.body}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* FAQ */}
        {faq.length > 0 && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-3xl">
              <p className={`${eyebrowClass()} text-center`}>FAQ</p>
              <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>
                Questions about Vireek vs {name}
              </h2>
              <div className="mt-8 space-y-3 sm:mt-10 sm:space-y-4">
                {faq.map((item) => (
                  <div key={item.q} className="rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card dark:shadow-card-dark sm:p-6">
                    <h3 className="text-base font-semibold text-text-primary">{item.q}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.a}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Compare Vireek to other tools */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>More Comparisons</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>Compare Vireek to other tools</h2>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {otherCompetitors.map((other) => (
                <Link
                  key={other.slug}
                  to={`/compare/${other.slug}`}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  <other.icon className="h-4 w-4" />
                  vs {other.name}
                </Link>
              ))}
              <Link
                to="/compare"
                className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
              >
                See the full comparison
              </Link>
            </div>
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
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/80">
                <Sparkles className="mr-1.5 inline h-4 w-4" />
                See it on your own calls
              </p>
              <h2 className="mt-4 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Stop losing jobs to voicemail
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Every call Sarah answers is a customer who reached a real voice instead of a beep — or {name}.
              </p>
              <div className="mt-9 flex justify-center">
                <Link to="/login">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Start Free Trial
                    <ArrowRight size={18} />
                  </Button>
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Cancel anytime. No contracts.
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
