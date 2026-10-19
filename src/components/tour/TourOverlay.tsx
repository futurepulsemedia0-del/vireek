import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useDirection } from '@/hooks/useDirection';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import { computeCardPosition, normalizePath, type TourStep } from '@/lib/productTours';
import { useTourT } from './useTourT';

const PADDING = 8;
const CARD_WIDTH = 360;
const FIND_TIMEOUT_MS = 2500;

const isMac = () =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** First VISIBLE match across all selectors (the desktop sidebar link is hidden on phones, etc.). */
export function findVisibleTarget(selectors?: readonly string[]): HTMLElement | null {
  if (!selectors) return null;
  for (const selector of selectors) {
    let matches: HTMLElement[];
    try {
      matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
    } catch {
      continue; // invalid selector must never break the tour
    }
    for (const el of matches) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

export interface TourOverlayProps {
  tourId: string;
  steps: readonly TourStep[];
  index: number;
  finishCta?: { label: string; href: string };
  onStep: (index: number) => void;
  /** ✕ / Esc: keep progress, resume later. */
  onPause: () => void;
  /** "Skip tour": never auto-shows again (replay stays available). */
  onSkip: () => void;
  onFinish: () => void;
}

type Phase = { stepId: string; value: 'pending' | 'found' | 'none' };

export function TourOverlay({ tourId, steps, index, finishCta, onStep, onPause, onSkip, onFinish }: TourOverlayProps) {
  const tt = useTourT();
  const reduceMotion = useReducedMotion();
  const { isRtl } = useDirection();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const step = steps[index];
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  const direction = useRef<1 | -1>(1);
  const targetRef = useRef<HTMLElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [phase, setPhase] = useState<Phase>({ stepId: '', value: 'pending' });
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [cardHeight, setCardHeight] = useState(260);

  const trapRef = useFocusTrap(true);
  useEscapeToClose(true, onPause);

  const routeReady = !step.route || normalizePath(pathname) === normalizePath(step.route);
  const phaseValue = phase.stepId === step.id ? phase.value : 'pending';

  // 1) Go to the page the step lives on.
  useEffect(() => {
    if (!routeReady && step.route) navigate(step.route);
  }, [routeReady, step.route, navigate]);

  // 2) Find the target (waits for it to render; gives up after a short timeout).
  useEffect(() => {
    targetRef.current = null;
    setRect(null);
    if (!step.targets || step.targets.length === 0) {
      setPhase({ stepId: step.id, value: 'none' });
      return;
    }
    setPhase({ stepId: step.id, value: 'pending' });
    if (!routeReady) return;

    let frame = 0;
    let timer = 0;
    let observer: MutationObserver | null = null;

    const stop = () => {
      observer?.disconnect();
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const attempt = () => {
      const el = findVisibleTarget(step.targets);
      if (!el) return false;
      targetRef.current = el;
      el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      setRect(el.getBoundingClientRect());
      setPhase({ stepId: step.id, value: 'found' });
      return true;
    };

    if (attempt()) return;
    observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (attempt()) stop();
      });
    });
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'],
    });
    timer = window.setTimeout(() => {
      stop();
      setPhase({ stepId: step.id, value: 'none' });
    }, FIND_TIMEOUT_MS);
    return stop;
  }, [step, routeReady, reduceMotion]);

  // 3) Keep the spotlight aligned on scroll / resize / layout changes.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      let el = targetRef.current;
      if (el && !el.isConnected) {
        el = findVisibleTarget(step.targets);
        targetRef.current = el;
      }
      if (el) setRect(el.getBoundingClientRect());
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [step]);

  // 4) Optional steps whose target never showed up are skipped in the direction of travel.
  useEffect(() => {
    if (phaseValue !== 'none' || !step.optional || !step.targets?.length || !routeReady) return;
    const next = index + direction.current;
    if (next >= 0 && next < steps.length) onStep(next);
  }, [phaseValue, step, routeReady, index, steps.length, onStep]);

  // Real card height → accurate placement.
  useLayoutEffect(() => {
    const h = trapRef.current?.offsetHeight ?? 0;
    if (h > 0 && Math.abs(h - cardHeight) > 1) setCardHeight(h);
  });

  const goNext = useCallback(() => {
    direction.current = 1;
    onStep(index + 1);
  }, [index, onStep]);
  const goBack = useCallback(() => {
    direction.current = -1;
    onStep(index - 1);
  }, [index, onStep]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const forward = isRtl ? 'ArrowLeft' : 'ArrowRight';
      const backward = isRtl ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === forward && !isLast) goNext();
      if (e.key === backward && !isFirst) goBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isRtl, isFirst, isLast, goNext, goBack]);

  const spot =
    rect && phaseValue === 'found'
      ? {
          top: rect.top - PADDING,
          left: rect.left - PADDING,
          width: rect.width + PADDING * 2,
          height: rect.height + PADDING * 2,
        }
      : null;
  const position = computeCardPosition(spot, viewport, { w: CARD_WIDTH, h: cardHeight });
  const cardStyle: CSSProperties =
    position.kind === 'sheet'
      ? { left: 12, right: 12, bottom: 12 }
      : position.kind === 'anchored'
        ? { top: position.top, left: position.left, width: CARD_WIDTH }
        : {
            left: 0, right: 0, marginInline: 'auto',
            top: Math.max(16, (viewport.h - cardHeight) / 2),
            width: `min(${CARD_WIDTH}px, calc(100vw - 24px))`,
          };

  const title = tt(`tour.${tourId}.${step.id}.title`, step.title);
  const body = tt(`tour.${tourId}.${step.id}.body`, step.body, { mod: isMac() ? '⌘' : 'Ctrl' });
  const stepOf = tt('tour.ui.stepOf', 'Step {{current}} of {{total}}', { current: index + 1, total: steps.length });

  return createPortal(
    <div className="fixed inset-0 z-[70]" data-testid="product-tour">
      {spot ? (
        <div
          aria-hidden="true"
          data-testid="tour-spotlight"
          className="pointer-events-none fixed rounded-2xl ring-2 ring-accent transition-all duration-200 motion-reduce:transition-none"
          style={{ ...spot, boxShadow: '0 0 0 9999px rgba(8, 10, 24, 0.62)' }}
        />
      ) : (
        <div aria-hidden="true" className="fixed inset-0 bg-black/60" />
      )}
      {/* Click-catcher: the page behind is inert while the tour is open. */}
      <div className="fixed inset-0" aria-hidden="true" />

      <motion.div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="fixed rounded-2xl border border-border bg-bg-secondary p-5 shadow-2xl outline-none"
        style={cardStyle}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">{stepOf}</p>
          <button
            type="button"
            onClick={onPause}
            aria-label={tt('tour.ui.close', 'Close tour (you can resume later)')}
            className="focus-ring -m-1 rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
        <h2 id="tour-title" className="mt-2 text-lg font-bold tracking-tight text-text-primary">
          {title}
        </h2>
        <p id="tour-body" className="mt-1.5 text-sm leading-relaxed text-text-secondary">
          {body}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {stepOf}: {title}
        </p>

        <div className="mt-4 flex gap-1.5" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.id} className={`h-1.5 flex-1 rounded-full ${i <= index ? 'bg-accent' : 'bg-bg-tertiary'}`} />
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onSkip}>
            {tt('tour.ui.skip', 'Skip tour')}
          </Button>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <Button variant="secondary" size="sm" onClick={goBack} aria-label={tt('tour.ui.back', 'Previous step')}>
                <ArrowLeft size={14} className="rtl:-scale-x-100" />
              </Button>
            )}
            {isLast ? (
              <Button
                size="sm"
                onClick={() => {
                  onFinish();
                  if (finishCta) navigate(finishCta.href);
                }}
              >
                {finishCta ? tt('tour.ui.finishCta', finishCta.label) : tt('tour.ui.done', 'Done')}
              </Button>
            ) : (
              <Button size="sm" onClick={goNext}>
                {tt('tour.ui.next', 'Next')} <ArrowRight size={14} className="rtl:-scale-x-100" />
              </Button>
            )}
          </div>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
