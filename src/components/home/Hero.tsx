import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { ArrowRight, BellRing, CalendarCheck, Mic, PhoneIncoming, Siren } from 'lucide-react';
import { ButtonAnchor, ButtonLink } from '@/components/ui/ButtonLink';
import { useExperiment } from '@/contexts/ExperimentContext';
import { LIVE_DEMO_SECTION_ID } from '@/lib/site';
import { HERO_HEADLINES, HERO_PROOF, TRADES, TRIAL } from '@/lib/homeContent';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { container, exampleChip } from './sectionStyles';

// Example lines only — this is an illustration of a typical call, not a recording of a real customer.
const EXAMPLE_LINES = [
  '“Thanks for calling Example Plumbing, this is Sarah. How can I help?”',
  '“Is water actively running right now, or has it stopped?”',
  '“I can have someone out today at 2:30. Does that work?”',
  '“You’re booked. A text confirmation is on its way.”',
] as const;

const EXAMPLE_STEPS = [
  { icon: PhoneIncoming, label: 'Call answered' },
  { icon: Siren, label: 'Emergency flagged' },
  { icon: CalendarCheck, label: 'Job booked on your calendar' },
  { icon: BellRing, label: 'Customer texted a confirmation' },
] as const;

function ExampleTranscript() {
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduceMotion) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % EXAMPLE_LINES.length), 3600);
    return () => window.clearInterval(id);
  }, [reduceMotion]);

  // Reduced motion: show the whole exchange as static text instead of an auto-rotating line.
  if (reduceMotion) {
    return (
      <ul className="space-y-1.5 px-4 py-4 text-[0.8125rem] italic leading-snug text-text-secondary">
        {EXAMPLE_LINES.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex h-16 items-center px-4" role="img" aria-label="Example of what Sarah says on a call">
      <p key={index} className="motion-safe:animate-fade-in text-[0.8125rem] italic leading-snug text-text-secondary">
        {EXAMPLE_LINES[index]}
      </p>
    </div>
  );
}

/** Live recreation of the product flow. Clearly labelled as an example; contains no performance figures. */
function ProductVisual() {
  return (
    <figure className="w-full max-w-md" aria-label="Example call handled by Sarah">
      <div className="overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-text-primary">Sarah · incoming call</span>
          <span className={exampleChip}>Example</span>
        </div>
        <div className="border-b border-border bg-bg-tertiary/60">
          <ExampleTranscript />
        </div>
        <ol className="divide-y divide-border/60">
          {EXAMPLE_STEPS.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-secondary">
                <Icon size={15} aria-hidden="true" />
              </span>
              <span className="text-[0.8125rem] font-medium text-text-primary">{label}</span>
            </li>
          ))}
        </ol>
      </div>
      <figcaption className="mt-3 text-xs text-text-secondary">
        Illustration of a typical call. Business name and times are made up.
      </figcaption>
    </figure>
  );
}

export function Hero() {
  const variant = useExperiment('hero_headline');
  const headline = variant === 'variant_b' ? HERO_HEADLINES.variant_b : HERO_HEADLINES.control;

  return (
    <section id="top" aria-labelledby="hero-heading" className="pt-28 pb-14 sm:pt-32 sm:pb-20 lg:pt-36">
      <div className={`${container} grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16`}>
        <div className="text-start">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary">
            AI receptionist for {TRADES.map((t) => t.toLowerCase()).slice(0, 3).join(', ')} &amp; roofing contractors
          </p>

          {/* The page's only H1. Rendered without an entrance animation so it paints immediately (LCP). */}
          <h1
            id="hero-heading"
            className="mt-4 font-display text-4xl font-semibold leading-[1.08] tracking-tightest text-text-primary sm:text-5xl lg:text-[3.5rem]"
          >
            {headline.line1} <span className="block">{headline.line2}</span>
          </h1>

          <p className="mt-5 max-w-xl text-base leading-relaxed text-text-secondary sm:text-lg">
            Sarah picks up every call, even at 2 a.m., books the job on your calendar and texts the customer. You stop
            losing work to voicemail.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center" data-hero-cta>
            <ButtonLink
              to="/signup"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => trackHomeCta('hero_primary')}
            >
              Start free trial
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
              Hear Sarah live
            </ButtonAnchor>
          </div>
          <p className="mt-3 text-sm text-text-secondary">{TRIAL.short}</p>

          <dl className="mt-10 grid gap-5 border-t border-border pt-6 sm:grid-cols-3">
            {HERO_PROOF.map((item) => (
              <div key={item.label}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{item.label}</dt>
                <dd className="mt-1 font-display text-xl font-semibold text-text-primary">{item.value}</dd>
                <dd className="mt-0.5 text-xs leading-snug text-text-secondary">{item.detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex justify-center lg:justify-end">
          <ProductVisual />
        </div>
      </div>
    </section>
  );
}
