import { useEffect, useRef, useState, useCallback, type PointerEvent } from 'react';
import { motion } from 'framer-motion';
import {
  PhoneCall,
  Zap,
  Siren,
  CalendarCheck,
  Languages,
  TrendingUp,
  DatabaseZap,
  ShieldCheck,
  MessageSquareText,
  Sparkles,
  Hand,
  type LucideIcon,
} from 'lucide-react';
import { EASE, viewport } from '@/lib/motion';

type Tone = 'accent' | 'cta' | 'success' | 'danger' | 'neutral';

interface HighlightItem {
  icon: LucideIcon;
  tone: Tone;
  title: string;
  detail: string;
}

const TONE_STYLES: Record<Tone, string> = {
  accent: 'bg-accent/10 text-accent',
  cta: 'bg-cta/10 text-cta',
  success: 'bg-success/10 text-success',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-text-secondary/10 text-text-secondary',
};

const ITEMS: HighlightItem[] = [
  { icon: PhoneCall, tone: 'accent', title: 'Answers Every Call', detail: '24/7, no voicemail' },
  { icon: Zap, tone: 'cta', title: 'Live in Under 10 Minutes', detail: 'No hardware, no contracts' },
  { icon: Siren, tone: 'danger', title: 'Emergency Detection', detail: 'Urgent jobs jump the queue' },
  { icon: CalendarCheck, tone: 'success', title: 'Books the Job', detail: 'Straight to your calendar' },
  { icon: Languages, tone: 'accent', title: 'Speaks Their Language', detail: 'English & Spanish, natively' },
  { icon: TrendingUp, tone: 'cta', title: 'Recovers Missed Revenue', detail: 'Every unanswered call, followed up' },
  { icon: DatabaseZap, tone: 'neutral', title: 'Syncs to Your CRM', detail: 'Automatically, every time' },
  { icon: ShieldCheck, tone: 'success', title: 'Bank-Grade Security', detail: 'SOC 2-ready infrastructure' },
  { icon: MessageSquareText, tone: 'accent', title: 'Texts Customers Back', detail: 'Instant confirmations' },
  { icon: Sparkles, tone: 'cta', title: 'Sounds Human', detail: 'Not a robotic phone tree' },
];

// Content is repeated three times so the track can be dragged freely in
// either direction: we always keep the visible scroll position parked in
// the middle copy and silently snap it back by exactly one copy-width the
// instant it drifts into a neighboring copy, so the loop never shows a
// seam or a jump.
const COPIES = 3;

function HighlightPill({ item }: { item: HighlightItem }) {
  const Icon = item.icon;
  return (
    <div className="flex shrink-0 items-center gap-3 whitespace-nowrap rounded-2xl border border-border/70 bg-bg-secondary/90 px-4 py-3 shadow-sm backdrop-blur-sm dark:bg-bg-secondary/80">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${TONE_STYLES[item.tone]}`}>
        <Icon size={19} strokeWidth={2.25} aria-hidden="true" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-[13.5px] font-semibold text-text-primary sm:text-sm">{item.title}</span>
        <span className="text-[11.5px] font-medium text-text-secondary/80 sm:text-xs">{item.detail}</span>
      </span>
    </div>
  );
}

export function HighlightBanner() {
  const trackRef = useRef<HTMLDivElement>(null);
  const segmentWidthRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const isPausedRef = useRef(false);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartScrollRef = useRef(0);

  const [hasInteracted, setHasInteracted] = useState(false);

  // Slow, deliberate drift — roughly one pill every ~2.5s. Direction is
  // "content moves left / new items arrive from the right", which reads
  // to a viewer as the track sliding in from the right edge.
  const PIXELS_PER_MS = 0.032;

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    segmentWidthRef.current = track.scrollWidth / COPIES;
    // Park the scroll position in the middle copy so the user can drag
    // either direction before a wrap correction is ever needed.
    track.scrollLeft = segmentWidthRef.current;
  }, []);

  const normalize = useCallback(() => {
    const track = trackRef.current;
    const segment = segmentWidthRef.current;
    if (!track || !segment) return;
    // Keep scrollLeft inside the middle copy; jump by exactly one
    // segment when it drifts out, which is invisible since the copies
    // are pixel-identical.
    if (track.scrollLeft < segment * 0.5) {
      track.scrollLeft += segment;
    } else if (track.scrollLeft > segment * 1.5) {
      track.scrollLeft -= segment;
    }
  }, []);

  const tick = useCallback(
    (time: number) => {
      const track = trackRef.current;
      if (lastTimeRef.current === null) lastTimeRef.current = time;
      const delta = time - lastTimeRef.current;
      lastTimeRef.current = time;

      if (track && !isPausedRef.current && !isDraggingRef.current) {
        track.scrollLeft += PIXELS_PER_MS * delta;
        normalize();
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [normalize]
  );

  useEffect(() => {
    measure();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    isPausedRef.current = reduceMotion;

    const onResize = () => measure();
    window.addEventListener('resize', onResize);

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [measure, tick]);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track) return;
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartScrollRef.current = track.scrollLeft;
    track.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !isDraggingRef.current) return;
    const deltaX = e.clientX - dragStartXRef.current;
    if (Math.abs(deltaX) > 3 && !hasInteracted) {
      setHasInteracted(true);
    }
    track.scrollLeft = dragStartScrollRef.current - deltaX;
    normalize();
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    isDraggingRef.current = false;
    if (track && track.hasPointerCapture(e.pointerId)) {
      track.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <section
      aria-label="Why home service businesses choose Vireek"
      className="relative overflow-hidden border-y border-border/60 bg-bg-secondary/50 bg-noise py-10 sm:py-14"
    >
      {/* Ambient brand glow, matching the rest of the page's accent language */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 12% 20%, rgb(var(--accent-primary) / 0.07), transparent 55%), radial-gradient(circle at 88% 80%, rgb(var(--accent-secondary) / 0.06), transparent 55%)',
        }}
      />

      <div className="mx-auto max-w-2xl px-5 text-center sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <span className="text-eyebrow font-semibold uppercase tracking-[0.16em] text-accent">
            Built For Home Service Teams
          </span>
          <h2 className="mt-2 text-xl font-bold leading-[1.2] tracking-tight text-text-primary sm:text-2xl md:text-3xl">
            Everything Your Front Desk Never Had Time For
          </h2>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={viewport}
        transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
        className="relative mt-8 sm:mt-10"
      >
        <div
          ref={trackRef}
          role="group"
          aria-label="Vireek feature highlights, draggable"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerLeave={(e) => {
            isPausedRef.current = false;
            endDrag(e);
          }}
          onPointerEnter={() => {
            isPausedRef.current = true;
          }}
          className="no-scrollbar flex w-full cursor-grab touch-pan-y select-none gap-3 overflow-x-auto overscroll-x-contain py-1 active:cursor-grabbing [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]"
        >
          {Array.from({ length: COPIES }).map((_, copyIndex) => (
            <div key={copyIndex} className="flex shrink-0 items-stretch gap-3 pr-3" aria-hidden={copyIndex !== 0}>
              {ITEMS.map((item) => (
                <HighlightPill key={`${copyIndex}-${item.title}`} item={item} />
              ))}
            </div>
          ))}
        </div>

        {/* One-time "drag me" nudge — fades out the moment the visitor
            actually drags the track, and never reappears in this session. */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: hasInteracted ? 0 : 1, y: 0 }}
          transition={{ duration: 0.4, delay: hasInteracted ? 0 : 1.1, ease: EASE }}
          className="pointer-events-none absolute -bottom-7 left-1/2 hidden -translate-x-1/2 items-center gap-1.5 text-[11px] font-medium text-text-secondary/60 sm:flex"
        >
          <Hand size={13} strokeWidth={2.25} aria-hidden="true" />
          Drag to explore
        </motion.div>
      </motion.div>

      {/* Accessible summary for screen readers, since the marquee track
          itself is decorative/duplicated and hidden from the a11y tree. */}
      <p className="sr-only">
        Vireek answers every call 24/7, gets set up in under 10 minutes, detects emergencies and
        prioritizes them automatically, books the job straight to your calendar, speaks to
        customers in their own language, follows up on every missed call to recover lost revenue,
        syncs to your CRM automatically, runs on SOC 2-ready infrastructure, texts customers back
        instantly, and sounds like a real person rather than a robotic phone tree.
      </p>
    </section>
  );
}
