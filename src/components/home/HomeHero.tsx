import { ArrowRight, CalendarCheck, MessageSquareText, Mic, Siren, Wrench } from 'lucide-react';
import { ButtonAnchor, ButtonLink } from '@/components/ui/ButtonLink';
import { useExperiment } from '@/contexts/ExperimentContext';
import { HOME_VARS, useHomeT } from '@/i18n/homeNamespace';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { LIVE_DEMO_SECTION_ID } from '@/lib/site';
import { container, exampleChip } from './sectionStyles';

const STEP_ICONS = [Siren, CalendarCheck, Wrench, MessageSquareText] as const;
const STEP_KEYS = ['emergency', 'booked', 'assigned', 'texted'] as const;

/** Static recreation of the product flow. No timers or animation: nothing competes with the H1 for LCP. */
function HeroVisual() {
  const { t } = useHomeT();
  return (
    <figure className="w-full max-w-md" aria-label={t('hero.visualLabel')}>
      <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-text-primary">{t('hero.visualTitle')}</span>
          <span className={exampleChip}>{t('common.example')}</span>
        </div>
        <div className="space-y-2.5 border-b border-border bg-bg-tertiary/60 px-4 py-4 text-[0.8125rem] leading-snug">
          <p className="max-w-[85%] rounded-xl rounded-ss-sm border border-border bg-bg-primary px-3 py-2 text-text-secondary">
            {t('hero.callerLine')}
          </p>
          <p className="ms-auto max-w-[85%] rounded-xl rounded-se-sm border border-border bg-bg-secondary px-3 py-2 text-text-primary">
            {t('hero.sarahLine')}
          </p>
        </div>
        <ol className="divide-y divide-border/60">
          {STEP_KEYS.map((key, i) => {
            const Icon = STEP_ICONS[i];
            return (
              <li key={key} className="flex items-center gap-3 px-4 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
                  <Icon size={15} aria-hidden="true" />
                </span>
                <span className="text-[0.8125rem] font-medium text-text-primary">{t(`hero.${key}`)}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <figcaption className="mt-3 text-xs text-text-secondary">{t('common.exampleNote')}</figcaption>
    </figure>
  );
}

export function HomeHero() {
  const { t } = useHomeT();
  const variant = useExperiment('hero_headline');
  const b = variant === 'variant_b';
  const line1 = t(b ? 'hero.headlineB1' : 'hero.headlineControl1');
  const line2 = t(b ? 'hero.headlineB2' : 'hero.headlineControl2');

  const proof = [
    { label: t('hero.proofAnswers'), value: t('hero.proofAnswersValue'), detail: t('hero.proofAnswersDetail') },
    { label: t('hero.proofSetup'), value: t('hero.proofSetupValue', HOME_VARS), detail: t('hero.proofSetupDetail') },
    { label: t('hero.proofTrial'), value: t('hero.proofTrialValue', HOME_VARS), detail: t('hero.proofTrialDetail', HOME_VARS) },
  ];

  return (
    <section id="top" aria-labelledby="hero-heading" className="pb-14 pt-28 sm:pb-20 sm:pt-32 lg:pt-36">
      <div className={`${container} grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16`}>
        <div className="text-start">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary rtl:normal-case rtl:tracking-normal">
            {t('hero.eyebrow')}
          </p>

          {/* The page's only H1. No entrance animation so it paints immediately (LCP). */}
          <h1
            id="hero-heading"
            className="mt-4 text-balance font-display text-4xl font-semibold leading-[1.08] tracking-tightest text-text-primary rtl:leading-[1.3] rtl:tracking-normal sm:text-5xl lg:text-[3.5rem]"
          >
            {line1} <span className="block">{line2}</span>
          </h1>

          <p className="mt-5 max-w-xl text-base leading-relaxed text-text-secondary sm:text-lg">{t('hero.sub')}</p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center" data-hero-cta>
            <ButtonLink to="/signup" size="lg" className="w-full sm:w-auto" onClick={() => trackHomeCta('hero_primary')}>
              {t('common.startTrial')}
              <ArrowRight size={18} aria-hidden="true" className="rtl:-scale-x-100" />
            </ButtonLink>
            <ButtonAnchor
              href={`#${LIVE_DEMO_SECTION_ID}`}
              variant="secondary"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => trackHomeCta('hero_demo')}
            >
              <Mic size={16} aria-hidden="true" />
              {t('hero.demo')}
            </ButtonAnchor>
          </div>
          <p className="mt-3 text-sm text-text-secondary">{t('common.trial', HOME_VARS)}</p>

          <dl className="mt-10 grid gap-5 border-t border-border pt-6 sm:grid-cols-3">
            {proof.map((item) => (
              <div key={item.label}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary rtl:normal-case rtl:tracking-normal">
                  {item.label}
                </dt>
                <dd className="mt-1 font-display text-xl font-semibold text-text-primary">{item.value}</dd>
                <dd className="mt-0.5 text-xs leading-snug text-text-secondary">{item.detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex justify-center lg:justify-end">
          <HeroVisual />
        </div>
      </div>
    </section>
  );
}
