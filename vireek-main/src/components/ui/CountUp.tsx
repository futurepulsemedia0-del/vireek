import { useEffect, useRef, useState } from 'react';
import { useInView } from 'framer-motion';

interface CountUpProps {
  /** Final display value, e.g. "85%", "$1,200+", "60\u201380%", "$36K". */
  value: string;
  className?: string;
  /** Animation duration in ms. Kept short and snappy per the site's motion system. */
  duration?: number;
}

/**
 * Splits a stat string into its numeric runs so each can be counted up from 0,
 * while every non-numeric character (currency signs, %, commas, en-dashes, +, K/M suffixes)
 * stays static in place. Handles single values ("85%") and ranges ("60\u201380%") alike.
 */
function parseSegments(value: string) {
  const regex = /\d+/g;
  const segments: { text: string; isNumber: boolean }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: value.slice(lastIndex, match.index), isNumber: false });
    }
    segments.push({ text: match[0], isNumber: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) {
    segments.push({ text: value.slice(lastIndex), isNumber: false });
  }
  return segments;
}

/** Animates a stat's digits counting up from 0 the first time it scrolls into view. */
export function CountUp({ value, className = '', duration = 900 }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!inView) return;
    let raf: number;
    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      // Decelerating ease — matches the site's confident-slowdown motion curve.
      const eased = 1 - Math.pow(1 - t, 3);
      setProgress(eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, duration]);

  const segments = parseSegments(value);

  return (
    <span ref={ref} className={className} aria-label={value}>
      {segments.map((seg, i) => {
        if (!seg.isNumber) return <span key={i}>{seg.text}</span>;
        const target = parseInt(seg.text, 10);
        const current = Math.round(target * progress);
        return <span key={i}>{current}</span>;
      })}
    </span>
  );
}
