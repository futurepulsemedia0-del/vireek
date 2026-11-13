import { useEffect, useRef, type CSSProperties, type MutableRefObject } from 'react';
import { usePrefersReducedMotion } from '@/lib/usePrefersReducedMotion';
import './sarah-orb.css';
import {
  barCountFor,
  clampSize,
  isAmplitudeState,
  normalizeLevel,
  orbLabel,
  poseFor,
  smoothAmplitude,
  weightsFor,
  type SarahState,
} from './sarahOrb.logic';

export type { SarahState } from './sarahOrb.logic';

export interface SarahOrbProps {
  state?: SarahState;
  /** px, clamped to 16–256. */
  size?: number;
  /**
   * Real audio level, 0–1 (e.g. Vapi `volume-level`). Pass EITHER a number (re-renders on change) OR a ref that
   * an event handler writes to (no re-render, preferred for per-frame audio). Only used in listening/speaking.
   */
  amplitude?: number;
  amplitudeRef?: MutableRefObject<number>;
  /** Overrides the accessible name. */
  label?: string;
  /** True when nearby text already says what Sarah is doing (chat avatar, call card): hides the orb from AT. */
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
}

const CENTRES: Record<3 | 5, number[]> = { 5: [8.5, 12.25, 16, 19.75, 23.5], 3: [11.5, 16, 20.5] };

/**
 * Sarah's single visual identity: the Vireek waveform in a disc. One component for the chat widget, live demo,
 * loading screens, call cards, notifications and empty states. SVG + CSS only (no Lottie, no images).
 * Bars are scaled by CSS (`--h` pose + `--a` live amplitude), so audio never re-renders React.
 */
export function SarahOrb({
  state = 'idle',
  size = 32,
  amplitude,
  amplitudeRef,
  label,
  decorative = false,
  className = '',
  style,
}: SarahOrbProps) {
  const px = clampSize(size);
  const count = barCountFor(px);
  const pose = poseFor(state, count);
  const weights = weightsFor(count);
  const reduced = usePrefersReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const latest = useRef(0);
  const hasSource = amplitude !== undefined || !!amplitudeRef;
  const live = hasSource && isAmplitudeState(state) && !reduced;

  useEffect(() => {
    if (amplitude !== undefined) latest.current = amplitude;
  }, [amplitude]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    if (!live) {
      el.style.setProperty('--a', '0');
      return;
    }
    let raf = 0;
    let last = 0;
    let cur = 0;
    const tick = (t: number) => {
      const target = normalizeLevel(amplitudeRef ? amplitudeRef.current : latest.current);
      cur = smoothAmplitude(cur, target, last ? t - last : 16);
      last = t;
      el.style.setProperty('--a', cur.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!raf && !document.hidden) {
        last = 0;
        raf = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVis = () => (document.hidden ? stop() : start());
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      el.style.setProperty('--a', '0');
    };
  }, [live, amplitudeRef]);

  const lead = Math.floor(count / 2);
  const w = count === 5 ? 2.6 : 3.4;

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 32 32"
      width={px}
      height={px}
      className={`sarah-orb ${className}`.trim()}
      style={style}
      data-state={state}
      data-compact={count === 3 ? '' : undefined}
      data-live={live ? '' : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : orbLabel(state, label)}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      <circle className="sarah-orb__disc" cx="16" cy="16" r="16" />
      <circle className="sarah-orb__ring" cx="16" cy="16" r="14.5" />
      {CENTRES[count].map((cx, i) => (
        <rect
          key={cx}
          className={`sarah-orb__bar${i === lead ? ' sarah-orb__bar--lead' : ''}`}
          x={cx - w / 2}
          y="8"
          width={w}
          height="16"
          rx={w / 2}
          style={{ '--h': pose[i], '--w': weights[i], '--i': i } as CSSProperties}
        />
      ))}
      <path className="sarah-orb__slash" d="M9 23L23 9" />
    </svg>
  );
}
