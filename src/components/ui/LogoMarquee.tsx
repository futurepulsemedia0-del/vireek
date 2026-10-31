import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { usePrefersReducedMotion } from '@/lib/usePrefersReducedMotion';

export interface MarqueeItem {
  id: string;
  /** Brand name. Used as the visible wordmark when `logo` is omitted, and as the accessible name. */
  name: string;
  /** Internal route. Omit to render a non-interactive item. */
  href?: string;
  /** Official inline SVG that paints with `currentColor`. Omit to render a text wordmark. */
  logo?: ReactNode;
}

export interface LogoMarqueeProps {
  items: readonly MarqueeItem[];
  /** Accessible name of the real list exposed to screen readers. */
  label: string;
  /** Scroll speed in px/s (calm range: 40–60). */
  speed?: number;
  direction?: 'left' | 'right';
  /** Controlled pause (WCAG 2.2.2). The owner renders the pause/play button. */
  paused?: boolean;
  className?: string;
}

const DEFAULT_SPEED = 48;
const FALLBACK_DURATION_S = 40;

const LINK_CLASS =
  'inline-flex h-10 items-center whitespace-nowrap rounded-md px-1 text-text-secondary ' +
  'transition-[color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:text-text-primary ' +
  'focus-visible:-translate-y-0.5 focus-visible:text-text-primary ' +
  'motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:focus-visible:translate-y-0';

function Mark({ item, decorative }: { item: MarqueeItem; decorative: boolean }) {
  const inner = item.logo ? (
    <>
      <span aria-hidden="true" className="flex h-6 items-center [&>svg]:h-full [&>svg]:w-auto">
        {item.logo}
      </span>
      <span className="sr-only">{item.name}</span>
    </>
  ) : (
    <span className="font-display text-lg font-semibold tracking-tight sm:text-xl">{item.name}</span>
  );

  if (!item.href) return <span className={LINK_CLASS}>{inner}</span>;
  return (
    <Link to={item.href} tabIndex={decorative ? -1 : undefined} className={LINK_CLASS}>
      {inner}
    </Link>
  );
}

function Entries({
  items,
  decorative,
  padded,
}: {
  items: readonly MarqueeItem[];
  decorative: boolean;
  padded: boolean;
}) {
  return (
    <>
      {items.map((item) => (
        <li key={item.id} className={padded ? 'shrink-0 pr-12 sm:pr-14' : undefined}>
          <Mark item={item} decorative={decorative} />
        </li>
      ))}
    </>
  );
}

export function LogoMarquee({
  items,
  label,
  speed = DEFAULT_SPEED,
  direction = 'left',
  paused = false,
  className = '',
}: LogoMarqueeProps) {
  const reduced = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<HTMLUListElement>(null);
  const [repeats, setRepeats] = useState(2);
  const [duration, setDuration] = useState(FALLBACK_DURATION_S);
  const [entered, setEntered] = useState(false);
  const [visible, setVisible] = useState(false);

  // Constant px/s speed: duration = one half-track width / speed. Measured on
  // mount and on resize only — never per frame.
  useEffect(() => {
    if (reduced) return undefined;
    const root = rootRef.current;
    const set = setRef.current;
    if (!root || !set) return undefined;

    const measure = () => {
      const setWidth = set.getBoundingClientRect().width;
      const viewWidth = root.clientWidth;
      if (setWidth <= 0 || viewWidth <= 0 || speed <= 0) return;
      // Each half must be at least as wide as the viewport so the loop seam is never visible.
      const reps = Math.max(1, Math.ceil(viewWidth / setWidth));
      setRepeats(reps);
      setDuration(Math.round(((reps * setWidth) / speed) * 100) / 100);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(set);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [reduced, speed, items]);

  // One observer: entrance fade once, and animation only while on screen.
  useEffect(() => {
    if (reduced) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setEntered(true);
      setVisible(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        setVisible(entry.isIntersecting);
        if (entry.isIntersecting) setEntered(true);
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0 },
    );
    io.observe(root);
    return () => io.disconnect();
  }, [reduced]);

  if (reduced) {
    return (
      <ul
        aria-label={label}
        className={`flex flex-wrap items-center justify-center gap-x-10 gap-y-3 ${className}`}
      >
        <Entries items={items} decorative={false} padded={false} />
      </ul>
    );
  }

  const style = { '--marquee-duration': `${duration}s` } as CSSProperties;

  return (
    <div
      ref={rootRef}
      dir="ltr"
      className={`logo-marquee ${className}`}
      data-entered={entered}
      data-visible={visible}
      data-paused={paused}
      data-direction={direction}
      style={style}
    >
      <div className="logo-marquee__viewport overflow-x-clip py-3">
        <div className="logo-marquee__track flex w-max">
          {/* Half A: the one real, focusable list + decorative copies */}
          <div className="flex shrink-0">
            <ul ref={setRef} aria-label={label} className="flex shrink-0 items-center">
              <Entries items={items} decorative={false} padded />
            </ul>
            {repeats > 1 && (
              <div aria-hidden="true" className="flex shrink-0">
                {Array.from({ length: repeats - 1 }, (_, i) => (
                  <ul key={i} className="flex shrink-0 items-center">
                    <Entries items={items} decorative padded />
                  </ul>
                ))}
              </div>
            )}
          </div>
          {/* Half B: identical width, fully decorative */}
          <div aria-hidden="true" className="flex shrink-0">
            {Array.from({ length: repeats }, (_, i) => (
              <ul key={i} className="flex shrink-0 items-center">
                <Entries items={items} decorative padded />
              </ul>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
