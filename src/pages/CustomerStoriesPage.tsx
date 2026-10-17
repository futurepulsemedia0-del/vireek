import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BadgeCheck, Clock, DollarSign, Info, PhoneMissed, Quote, ShieldCheck, Sparkles, TrendingUp } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import {
  TRADES,
  buildHubJsonLd,
  disclosure,
  filterStories,
  getStories,
  hubSeo,
  isVerified,
  parseTradeParam,
  provenanceLabel,
  storyMetrics,
  tradeCounts,
  type CustomerStory,
} from '@/lib/customerStories';

const FAQ = [
  { q: 'Are these real customers?', a: 'Each story carries a label. “Verified customer” means we have written permission to publish the name, quote, and numbers. “Illustrative example” means the story shows what Vireek is designed to do and is not a statement from a named customer. Nothing is unlabelled.' },
  { q: 'How are the numbers calculated?', a: 'Figures describe a single business over the period in its story: missed calls, typical response time, and estimated revenue at risk. They are not averages across customers, and we do not publish totals across stories.' },
  { q: 'Will I get the same results?', a: 'Not necessarily. Call volume, trade, and how many calls you miss today all change the outcome. These stories show what is possible, not a guarantee.' },
  { q: 'How can I see my own numbers?', a: 'Start a free trial. Your dashboard shows your own calls, leads, and jobs from day one, so you can judge Vireek on your data.' },
];

const ICON = { PhoneMissed, Clock, DollarSign } as const;
const METRIC_ICONS = [ICON.PhoneMissed, ICON.Clock, ICON.DollarSign];

function ProvenanceBadge({ story }: { story: CustomerStory }) {
  const verified = isVerified(story);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
        verified ? 'border-success/30 bg-success/10 text-success' : 'border-border bg-bg-tertiary text-text-secondary'
      }`}
    >
      {verified ? <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> : <Info className="h-3.5 w-3.5" aria-hidden />}
      {provenanceLabel(story)}
    </span>
  );
}

function StoryCard({ story, index }: { story: CustomerStory; index: number }) {
  const metrics = storyMetrics(story);
  const trade = TRADES.find((t) => t.slug === story.tradeSlug)?.label ?? story.industry;
  return (
    <motion.article
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.45, ease: EASE, delay: Math.min(index * 0.06, 0.18) }}
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
      aria-labelledby={`story-${story.slug}`}
    >
      <div className="flex items-start gap-3 border-b border-border p-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent" aria-hidden>{story.initials}</span>
        <div className="min-w-0 flex-1">
          <h3 id={`story-${story.slug}`} className="truncate text-base font-semibold text-text-primary">{story.business}</h3>
          <p className="text-xs text-text-secondary">{story.name} · {trade}</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        <ProvenanceBadge story={story} />

        <p className="flex items-start gap-2 rounded-xl bg-success/10 px-3.5 py-2.5 text-sm font-semibold text-success">
          <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {story.result}
        </p>

        <div className="overflow-hidden rounded-xl border border-border">
          <div aria-hidden className="grid grid-cols-[1fr_auto_auto] gap-x-3 border-b border-border/70 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            <span />
            <span>Before</span>
            <span>After</span>
          </div>
          <dl className="divide-y divide-border/70">
            {metrics.map((m, i) => {
              const MIcon = METRIC_ICONS[i];
              return (
                <div key={m.label} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 px-3 py-2 text-xs">
                  <dt className="flex items-center gap-2 text-text-secondary"><MIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />{m.label}</dt>
                  <dd className="text-right text-text-secondary"><span className="sr-only">Before: </span>{m.before}</dd>
                  <dd className="text-right font-semibold text-text-primary"><span className="sr-only">After: </span>{m.after}</dd>
                </div>
              );
            })}
          </dl>
        </div>

        <figure className="flex-1 rounded-xl bg-bg-tertiary/60 p-4">
          <Quote size={18} className="text-accent/40" aria-hidden />
          <blockquote className="mt-1.5 text-sm italic leading-relaxed text-text-primary">“{story.quote}”</blockquote>
          <figcaption className="mt-2 text-xs font-semibold text-text-secondary">
            {isVerified(story) ? `${story.name}, ${story.business}` : `Illustrative quote · ${story.industry}`}
          </figcaption>
        </figure>

        <Link to={story.href} className="focus-ring inline-flex items-center gap-1.5 self-start rounded-lg text-sm font-semibold text-accent hover:underline">
          Read the full story <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </motion.article>
  );
}

export function CustomerStoriesPage() {
  const [params, setParams] = useSearchParams();
  const trade = parseTradeParam(params.get('trade'));
  const stories = useMemo(() => getStories(), []);
  const counts = useMemo(() => tradeCounts(stories), [stories]);
  const shown = useMemo(() => filterStories(stories, trade), [stories, trade]);
  const banner = useMemo(() => disclosure(stories), [stories]);
  const jsonLd = useMemo(() => buildHubJsonLd(stories), [stories]);
  const seo = hubSeo();
  const tradeLabel = TRADES.find((t) => t.slug === trade)?.label;

  useSEO({ title: seo.title, description: seo.description, canonical: seo.canonical, jsonLd });

  const selectTrade = (slug: string | null) => {
    const next = new URLSearchParams(params);
    if (slug) next.set('trade', slug);
    else next.delete('trade');
    setParams(next, { replace: true });
  };

  const chip = (active: boolean) =>
    `focus-ring inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
      active ? 'border-accent bg-accent text-white' : 'border-border bg-bg-secondary text-text-primary hover:border-accent/40 hover:text-accent'
    }`;

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }} className="mx-auto max-w-3xl text-center">
            <p className={eyebrowClass()}>Customer Stories</p>
            <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">Stories from the trades</h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-8 text-text-secondary">
              How HVAC, plumbing, and electrical businesses use an AI receptionist to stop losing jobs to voicemail. Every story is labelled so you know exactly what you’re reading.
            </p>
          </motion.div>
        </section>

        <section className="px-6 pb-8 pt-12 sm:pb-12">
          <div className="mx-auto max-w-6xl">
            {banner && (
              <div role="note" className="mb-8 flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-4 text-sm leading-relaxed text-text-secondary sm:p-5">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                <p>{banner}</p>
              </div>
            )}

            <div role="group" aria-label="Filter stories by trade" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2 sm:flex-wrap sm:overflow-visible">
              <button type="button" aria-pressed={trade === null} onClick={() => selectTrade(null)} className={`${chip(trade === null)} shrink-0`}>
                All trades <span className="text-xs opacity-80">{stories.length}</span>
              </button>
              {TRADES.map((t) => (
                <button key={t.slug} type="button" aria-pressed={trade === t.slug} onClick={() => selectTrade(t.slug)} className={`${chip(trade === t.slug)} shrink-0`}>
                  {t.label} <span className="text-xs opacity-80">{counts[t.slug]}</span>
                </button>
              ))}
            </div>

            <p className="mt-4 text-sm text-text-secondary" aria-live="polite">
              {shown.length === 0 ? `No ${tradeLabel} stories yet` : `Showing ${shown.length} ${shown.length === 1 ? 'story' : 'stories'}${tradeLabel ? ` in ${tradeLabel}` : ''}`}
            </p>

            {shown.length > 0 ? (
              <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
                {shown.map((s, i) => (
                  <StoryCard key={s.slug} story={s} index={i} />
                ))}
              </div>
            ) : (
              <div className="mt-6">
                <EmptyState
                  icon={ShieldCheck}
                  title={`No published ${tradeLabel} stories yet`}
                  description="We only publish stories we can stand behind, so we would rather show nothing than invent one. Try Vireek on your own calls and see your own numbers."
                  action={{ label: 'See all stories', onClick: () => selectTrade(null) }}
                />
              </div>
            )}
          </div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <p className={`${eyebrowClass()} text-center`}>FAQ</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>About these stories</h2>
            <div className="mt-8 space-y-3 sm:mt-10 sm:space-y-4">
              {FAQ.map((f) => (
                <div key={f.q} className="rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card dark:shadow-card-dark sm:p-6">
                  <h3 className="text-base font-semibold text-text-primary">{f.q}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{f.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="px-6 py-16 md:py-20">
          <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.5, ease: EASE }} className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-24">
            <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)' }} />
            <div className="relative">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/80"><Sparkles className="mr-1.5 inline h-4 w-4" aria-hidden />See it on your own calls</p>
              <h2 className="mt-4 text-balance text-3xl font-bold leading-[1.15] tracking-tight text-white md:text-5xl">Your numbers beat anyone’s story</h2>
              <p className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-white/85 md:text-lg">Let Sarah answer a week of your real calls and judge Vireek on your own results.</p>
              <div className="mt-9 flex justify-center">
                <Link to="/login"><Button variant="primary" size="lg" className="shadow-glow-cta">Start Free Trial<ArrowRight size={18} aria-hidden /></Button></Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70"><ShieldCheck size={13} className="shrink-0" aria-hidden />Cancel anytime. No contracts.</p>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
