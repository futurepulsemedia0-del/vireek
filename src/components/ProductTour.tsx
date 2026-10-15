import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';

interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Selectors tried in order; the first VISIBLE match is spotlighted. None → centered card. */
  targets?: string[];
}

export type TourOutcome = 'completed' | 'skipped';

const isMac = () => typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

function buildSteps(): TourStep[] {
  const mod = isMac() ? '⌘' : 'Ctrl';
  return [
    {
      id: 'welcome',
      title: 'Welcome to Vireek',
      body: 'A 30-second tour of where things live. You can leave at any time and replay it from Getting Started.',
    },
    {
      id: 'navigation',
      title: 'Everything is one click away',
      body: 'Jobs, calls, customers, quotes and every intelligence tool live in the navigation. Items you don’t have access to are hidden automatically.',
      targets: ['[data-tour="sidebar"]', '[data-tour="menu-button"]'],
    },
    {
      id: 'search',
      title: 'Jump anywhere instantly',
      body: `Press ${mod} + K from any page to search and open anything. Press ? to see all keyboard shortcuts.`,
    },
    {
      id: 'assistant',
      title: 'Ask the AI assistant',
      body: 'Questions about your business, a customer or how something works? The assistant is always one tap away.',
      targets: ['button[aria-label="Open AI Assistant"]', 'button[aria-label="Close AI Assistant"]'],
    },
    {
      id: 'checklist',
      title: 'Finish setup at your pace',
      body: 'Your setup checklist tracks progress automatically from your real data — no manual ticking. Pick up where you left off any time.',
    },
  ];
}

const PADDING = 8;
const CARD_WIDTH = 360;

function resolveTarget(targets?: string[]): HTMLElement | null {
  if (!targets) return null;
  for (const selector of targets) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

interface Props {
  open: boolean;
  onFinish: (outcome: TourOutcome) => void;
  /** Where the last step's button leads. Omit when already on the checklist. */
  checklistHref?: string;
}

export function ProductTour({ open, onFinish, checklistHref }: Props) {
  const steps = useMemo(buildSteps, []);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const step = steps[index];
  const isLast = index === steps.length - 1;

  const finish = useCallback(
    (outcome: TourOutcome) => {
      setIndex(0);
      onFinish(outcome);
    },
    [onFinish],
  );

  const trapRef = useFocusTrap(open);
  useEscapeToClose(open, () => finish('skipped'));

  const measure = useCallback(() => {
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    setRect(resolveTarget(step.targets)?.getBoundingClientRect() ?? null);
  }, [step]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  // Lock page scroll behind the tour.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && !isLast) setIndex((i) => i + 1);
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isLast]);

  if (!open || typeof document === 'undefined') return null;

  const narrow = viewport.w < 640;
  const spot = rect && {
    top: rect.top - PADDING,
    left: rect.left - PADDING,
    width: rect.width + PADDING * 2,
    height: rect.height + PADDING * 2,
  };

  // Card placement: beside the spotlight on wide screens, bottom sheet on phones, centered with no target.
  let cardStyle: React.CSSProperties;
  if (narrow) {
    cardStyle = { left: 12, right: 12, bottom: 12 };
  } else if (spot) {
    const fitsRight = spot.left + spot.width + 16 + CARD_WIDTH <= viewport.w;
    const left = fitsRight ? spot.left + spot.width + 16 : Math.max(16, spot.left - CARD_WIDTH - 16);
    const top = Math.min(Math.max(16, spot.top), Math.max(16, viewport.h - 280));
    cardStyle = { left: Math.min(left, viewport.w - CARD_WIDTH - 16), top, width: CARD_WIDTH };
  } else {
    cardStyle = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: `min(${CARD_WIDTH}px, calc(100vw - 24px))` };
  }

  return createPortal(
    <div className="fixed inset-0 z-[70]" data-testid="product-tour">
      {spot ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed rounded-2xl ring-2 ring-accent transition-all duration-200"
          style={{ ...spot, boxShadow: '0 0 0 9999px rgba(8, 10, 24, 0.62)' }}
        />
      ) : (
        <div aria-hidden="true" className="fixed inset-0 bg-black/60" />
      )}
      {/* Click-catcher so the page behind is inert while the tour is open. */}
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
          <p className="text-xs font-semibold uppercase tracking-wider text-accent">
            Step {index + 1} of {steps.length}
          </p>
          <button
            type="button"
            onClick={() => finish('skipped')}
            aria-label="Skip tour"
            className="focus-ring -m-1 rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
        <h2 id="tour-title" className="mt-2 text-lg font-bold tracking-tight text-text-primary">
          {step.title}
        </h2>
        <p id="tour-body" className="mt-1.5 text-sm leading-relaxed text-text-secondary">
          {step.body}
        </p>

        <div className="mt-4 flex gap-1.5" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.id} className={`h-1.5 flex-1 rounded-full ${i <= index ? 'bg-accent' : 'bg-bg-tertiary'}`} />
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => finish('skipped')}>
            Skip tour
          </Button>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setIndex((i) => i - 1)} aria-label="Previous step">
                <ArrowLeft size={14} />
              </Button>
            )}
            {isLast ? (
              <Button
                size="sm"
                onClick={() => {
                  finish('completed');
                  if (checklistHref) navigate(checklistHref);
                }}
              >
                {checklistHref ? 'Open checklist' : 'Done'}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setIndex((i) => i + 1)}>
                Next <ArrowRight size={14} />
              </Button>
            )}
          </div>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
