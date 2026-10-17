import { useMemo, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Check, Minus, ShieldCheck, Sparkles, ThumbsUp, X } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import type { FeatureValue } from '@/lib/competitors';
import { ALTERNATIVES, alternativePath, alternativeUrl, buildAlternativeJsonLd, resolveAlternative } from '@/lib/alternatives';

function FeatureIcon({ value, highlight }: { value: FeatureValue; highlight?: boolean }) {
  const label = value === 'yes' ? 'Yes' : value === 'partial' ? 'Partial' : 'No';
  const icon =
    value === 'yes' ? (
      <Check size={18} className={`shrink-0 ${highlight ? 'text-accent' : 'text-success-500'}`} strokeWidth={2.5} aria-hidden />
    ) : value === 'partial' ? (
      <Minus size={18} className="shrink-0 text-text-secondary/40" strokeWidth={2.5} aria-hidden />
    ) : (
      <X size={18} className="shrink-0 text-danger/50" strokeWidth={2.5} aria-hidden />
    );
  return (
    <>
      {icon}
      <span className="sr-only">{label}</span>
    </>
  );
}

function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.5, ease: EASE, delay }} className={className}>
      {children}
    </motion.div>
  );
}

const cardCls = 'rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark';
const chipCls =
  'focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent';

export function AlternativePage() {
  const { competitor: param } = useParams<{ competitor: string }>();
  const resolved = resolveAlternative(param);
  const jsonLd = useMemo(() => (resolved ? buildAlternativeJsonLd(resolved) : undefined), [resolved]);

  // Hooks must run before any early return.
  useSEO({
    title: resolved?.alternative.seoTitle ?? 'Compare Vireek | Vireek',
    description: resolved?.alternative.seoDescription ?? 'Compare Vireek, the AI voice receptionist for home-service businesses, to other tools.',
    canonical: resolved ? alternativeUrl(resolved.alternative.slug) : 'https://vireek.com/compare',
    jsonLd,
  });

  if (!resolved) return <Navigate to="/compare" replace />;
  // Alias (e.g. /alternatives/ruby-receptionists) → one canonical URL, so search engines see a single page.
  if (param !== resolved.alternative.slug) return <Navigate to={alternativePath(resolved.alternative.slug)} replace />;

  const { alternative: alt, competitor } = resolved;
  const { name, category, icon: Icon, isVoiceAICompetitor, featureRows, positioning, worksWellTogether } = competitor;
  const others = ALTERNATIVES.filter((a) => a.slug !== alt.slug);

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton fallback="/compare" />
            </div>
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }} className="text-center">
              <div className="mx-auto mb-5 inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-1.5 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Icon className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                <span className="truncate">{name} · {category}</span>
              </div>
              <p className={eyebrowClass()}>{name} Alternative</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">{alt.headline}</h1>
              <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-8 text-text-secondary sm:text-xl">{alt.intro}</p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">Start Free Trial</Button>
                </Link>
                <Link to={`/compare/${competitor.slug}`} className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent">
                  Full Vireek vs {name} comparison
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <Reveal className="mx-auto max-w-2xl text-center">
              <p className={`${eyebrowClass()} text-center`}>Why People Look Elsewhere</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center text-2xl sm:text-3xl`}>Why businesses look for a {name} alternative</h2>
            </Reveal>
            <div className="mt-10 grid gap-5 lg:grid-cols-3">
              {alt.reasons.map((r, i) => (
                <Reveal key={r.title} delay={i * 0.08} className={cardCls}>
                  <h3 className="text-base font-semibold text-text-primary">{r.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary">{r.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-2 lg:gap-8">
            <Reveal className={cardCls}>
              <p className="flex items-center gap-2 text-sm font-semibold text-text-secondary"><ThumbsUp className="h-4 w-4" aria-hidden /> Stay with {name} if</p>
              <ul className="mt-4 space-y-3">
                {alt.stayIf.map((t) => (
                  <li key={t} className="flex gap-2.5 text-sm leading-relaxed text-text-secondary"><Check size={16} className="mt-0.5 shrink-0 text-text-secondary/60" aria-hidden />{t}</li>
                ))}
              </ul>
            </Reveal>
            <Reveal delay={0.1} className="rounded-2xl border border-accent/25 bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
              <p className="flex items-center gap-2 text-sm font-semibold text-accent"><Sparkles className="h-4 w-4" aria-hidden /> Vireek is the better fit if</p>
              <ul className="mt-4 space-y-3">
                {alt.switchIf.map((t) => (
                  <li key={t} className="flex gap-2.5 text-sm leading-relaxed text-text-secondary"><Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />{t}</li>
                ))}
              </ul>
              {worksWellTogether && <p className="mt-5 border-t border-border/60 pt-4 text-sm leading-relaxed text-text-secondary">{worksWellTogether}</p>}
            </Reveal>
          </div>
        </section>

        {!isVoiceAICompetitor && featureRows && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-5xl">
              <Reveal className="mx-auto max-w-2xl text-center">
                <p className={`${eyebrowClass()} text-center`}>Side by Side</p>
                <h2 className={`${sectionHeadingClass()} mt-3 text-center text-2xl sm:text-3xl`}>Vireek vs {name} on phone handling</h2>
              </Reveal>
              <Reveal delay={0.1} className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
                <div className="hidden md:block">
                  <table className="w-full">
                    <caption className="sr-only">Vireek compared with {name}</caption>
                    <thead>
                      <tr className="border-b border-border bg-bg-tertiary">
                        <th scope="col" className="px-6 py-5 text-left text-sm font-semibold text-text-secondary">Capability</th>
                        <th scope="col" className="bg-accent/5 px-6 py-5 text-center text-sm font-semibold text-accent">Vireek</th>
                        <th scope="col" className="px-6 py-5 text-center text-sm font-semibold text-text-secondary">{name}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {featureRows.map((row, i) => (
                        <tr key={row.feature} className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? 'bg-bg-secondary' : 'bg-bg-tertiary/30'}`}>
                          <th scope="row" className="px-6 py-4 text-left text-sm font-medium text-text-primary">{row.feature}</th>
                          <td className="bg-accent/5 px-6 py-4"><div className="flex justify-center"><FeatureIcon value={row.vireek} highlight /></div></td>
                          <td className="px-6 py-4"><div className="flex justify-center"><FeatureIcon value={row.competitor} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-4 p-5 md:hidden">
                  {([{ key: 'vireek', label: 'Vireek', highlight: true }, { key: 'competitor', label: name, highlight: false }] as const).map((col) => (
                    <div key={col.key} className={`rounded-xl border p-4 ${col.highlight ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-tertiary/50'}`}>
                      <h3 className={`text-sm font-bold ${col.highlight ? 'text-accent' : 'text-text-primary'}`}>{col.label}</h3>
                      <ul className="mt-3 space-y-2.5">
                        {featureRows.map((row) => (
                          <li key={row.feature} className="flex items-center gap-2.5"><FeatureIcon value={row[col.key]} highlight={col.highlight} /><span className="text-xs text-text-secondary">{row.feature}</span></li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Reveal>
              <p className="mx-auto mt-4 max-w-2xl text-center text-xs text-text-secondary/70">
                Reflects each product’s core, publicly described focus as of this writing. Features change, so see {name}’s own site for its current list.
              </p>
            </div>
          </section>
        )}

        {isVoiceAICompetitor && positioning && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-5xl">
              <Reveal className="mx-auto max-w-2xl text-center">
                <p className={`${eyebrowClass()} text-center`}>How They Differ</p>
                <h2 className={`${sectionHeadingClass()} mt-3 text-center text-2xl sm:text-3xl`}>Vireek vs {name}: different focus</h2>
              </Reveal>
              <div className="mt-10 grid gap-5 lg:grid-cols-3">
                {positioning.map((p, i) => (
                  <Reveal key={p.title} delay={i * 0.08} className={cardCls}>
                    <h3 className="text-base font-semibold text-text-primary">{p.title}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{p.body}</p>
                  </Reveal>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <Reveal className="mx-auto max-w-2xl text-center">
              <p className={`${eyebrowClass()} text-center`}>Try It Safely</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center text-2xl sm:text-3xl`}>How to try Vireek without disrupting {name}</h2>
            </Reveal>
            <ol className="mt-10 grid gap-5 sm:grid-cols-2">
              {alt.steps.map((s, i) => (
                <motion.li key={s.title} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.5, ease: EASE, delay: i * 0.06 }} className={`${cardCls} list-none`}>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent" aria-hidden>{i + 1}</span>
                  <h3 className="mt-3 text-base font-semibold text-text-primary">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{s.body}</p>
                </motion.li>
              ))}
            </ol>
          </div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <p className={`${eyebrowClass()} text-center`}>FAQ</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>{name} alternative: common questions</h2>
            <div className="mt-8 space-y-3 sm:mt-10 sm:space-y-4">
              {alt.faq.map((item) => (
                <div key={item.q} className="rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card dark:shadow-card-dark sm:p-6">
                  <h3 className="text-base font-semibold text-text-primary">{item.q}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <nav aria-label="More alternatives" className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>More Alternatives</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>Other tools people compare</h2>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {others.map((o) => {
                const c = resolveAlternative(o.slug)?.competitor;
                return c ? (
                  <Link key={o.slug} to={alternativePath(o.slug)} className={chipCls}>
                    <c.icon className="h-4 w-4" aria-hidden />
                    {c.name} alternatives
                  </Link>
                ) : null;
              })}
              <Link to="/compare" className={chipCls}>See the full comparison</Link>
            </div>
          </div>
        </nav>

        <section className="px-6 py-16 md:py-20">
          <Reveal className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-24">
            <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)' }} />
            <div className="relative">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/80"><Sparkles className="mr-1.5 inline h-4 w-4" aria-hidden />See it on your own calls</p>
              <h2 className="mt-4 text-balance text-3xl font-bold leading-[1.15] tracking-tight text-white md:text-5xl">Stop losing jobs to voicemail</h2>
              <p className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-white/85 md:text-lg">The fastest way to judge an alternative is your own call volume. Let Sarah answer a week of real calls.</p>
              <div className="mt-9 flex justify-center">
                <Link to="/login">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">Start Free Trial<ArrowRight size={18} aria-hidden /></Button>
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70"><ShieldCheck size={13} className="shrink-0" aria-hidden />Cancel anytime. No contracts.</p>
            </div>
          </Reveal>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
