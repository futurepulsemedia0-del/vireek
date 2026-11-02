import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useReducedMotion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { SarahOrb } from '@/components/sarah/SarahOrb';
import { counterValue, heroAnnouncement, shouldAnimateCounter, type HeroView } from '@/lib/todayHome.logic';
import { formatCents } from '@/lib/todayHomeApi';

const COUNT_MS = 700;
const ANNOUNCE_EVERY_MS = 30_000;

/**
 * "Sarah recovered $X today". The number on screen is ALWAYS the engine's credited amount; the count-up only
 * runs for genuine changes after first paint and always lands exactly on the true value. The definition is a
 * real disclosure (keyboard + screen-reader + touch), not a hover-only tooltip.
 */
export function RecoveredHero({ hero, tv = false }: { hero: HeroView; tv?: boolean }) {
  const reduced = !!useReducedMotion();
  const [shown, setShown] = useState(hero.valueCents);
  const prev = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [spoken, setSpoken] = useState(() => heroAnnouncement(hero, formatCents));
  const lastSpoken = useRef(0);

  useEffect(() => {
    const target = hero.valueCents;
    const from = prev.current;
    prev.current = target;
    if (!shouldAnimateCounter(from, target, reduced)) {
      setShown(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const p = (t - start) / COUNT_MS;
      setShown(counterValue(from as number, target, p));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      setShown(target); // never leave a half-counted number behind
    };
  }, [hero.valueCents, reduced]);

  // Screen readers hear the settled value, at most every 30 s (not every animation frame, not every refresh).
  useEffect(() => {
    const text = heroAnnouncement(hero, formatCents);
    const wait = Math.max(0, lastSpoken.current + ANNOUNCE_EVERY_MS - Date.now());
    const id = window.setTimeout(() => {
      lastSpoken.current = Date.now();
      setSpoken(text);
    }, wait);
    return () => window.clearTimeout(id);
  }, [hero]);

  return (
    <section
      aria-labelledby={`${panelId}-label`}
      className={`rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark ${tv ? 'p-10' : 'p-5 sm:p-7'}`}
    >
      <div className="flex items-center gap-2.5">
        <SarahOrb state="idle" size={tv ? 40 : 28} decorative />
        <h3 id={`${panelId}-label`} className={`font-semibold text-text-secondary ${tv ? 'text-2xl' : 'text-sm'}`}>
          Sarah recovered today
        </h3>
      </div>

      <p
        aria-hidden="true"
        className={`mt-3 font-display font-semibold tabular-nums tracking-tight text-text-primary ${tv ? 'text-[9rem] leading-none' : 'text-5xl sm:text-6xl'}`}
      >
        {formatCents(shown, hero.currency)}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {spoken}
      </p>

      <p className={`mt-3 text-text-secondary ${tv ? 'text-2xl' : 'text-sm'}`}>
        {hero.valueCents > 0
          ? `${hero.creditedCount} ${hero.creditedCount === 1 ? 'recovery' : 'recoveries'} with money received`
          : 'Nothing recovered yet today. Only money actually received is counted.'}
      </p>

      {!tv && (
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            className="focus-ring -ml-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent/10"
          >
            How is this calculated?
            <ChevronDown size={16} aria-hidden="true" className={open ? 'rotate-180' : ''} />
          </button>
          <div id={panelId} hidden={!open} className="mt-2 space-y-2 rounded-xl bg-bg-tertiary/60 p-4 text-sm leading-relaxed text-text-secondary">
            {hero.definition.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>
              <Link to="/dashboard/recovery/statements" className="focus-ring font-medium text-accent underline-offset-2 hover:underline">
                See every recovery in the weekly statement
              </Link>
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
