import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import './vireekMark.css';
import {
  NET,
  NET_LINKS,
  SEQUENCE,
  SHAPES,
  VIEW_H,
  VIEW_W,
  copyPts,
  easeInOutCubic,
  follow,
  mix,
  pathFor,
  type Pt,
} from './vireekMarkGeometry';

/**
 * Animated Vireek mark (symbol only — no wordmark).
 *
 * One continuous line draws itself, becomes the V, and its orange end-point blooms into a network.
 * Click / Enter / Space (when `interactive`) plays the morph signal → loop → growth and returns home.
 *
 *   size      rendered WIDTH in px (height follows the artwork)
 *   animated  false → settled artwork, no motion
 *   intro     'always' plays the line-drawing every mount; 'once' plays it once per browser session
 *             and renders the settled mark afterwards (ideal for screens users see often, e.g. sign-in)
 *   interactive  click/keyboard morph + pointer tilt
 *   decorative   hide from assistive tech (use when the brand name is already announced nearby)
 *
 * Use ONE animated mark per view. Under 32 px the plain V is rendered (no network, no motion).
 * Motion stops when the tab is hidden or the mark is off-screen, and is disabled under
 * prefers-reduced-motion. All colours follow the design tokens, so light/dark switches automatically.
 */
export interface VireekMarkProps {
  size?: number;
  animated?: boolean;
  intro?: 'always' | 'once';
  interactive?: boolean;
  /** Repeat the morph cycle automatically (default true). Still stops under reduced motion and while off-screen. */
  loop?: boolean;
  decorative?: boolean;
  label?: string;
  className?: string;
}

const SEEN_KEY = 'vireek:mark-intro-seen';
const INTRO_MS = 2200;
const MORPH_MS = 1300;
const HOLD_MS = 1100;
const HOME_HOLD_MS = 3200;

const readSeen = (): boolean => {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
};
const writeSeen = (): void => {
  try {
    window.sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage unavailable (private mode / blocked): the intro simply replays next time */
  }
};
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function VireekMark({
  size = 160,
  animated = true,
  intro = 'always',
  interactive = false,
  loop = true,
  decorative = false,
  label = 'Vireek',
  className,
}: VireekMarkProps) {
  const [reduced] = useState(prefersReducedMotion);
  const tiny = size < 32;
  const still = !animated || reduced || tiny;
  const shape = tiny ? 'v' : 'thread';
  const pts = SHAPES[shape];
  const end = pts[9];
  const showNet = shape === 'thread';
  const canMorph = interactive && !still;

  const svgRef = useRef<SVGSVGElement>(null);
  const echoRef = useRef<SVGPathElement>(null);
  const mainRef = useRef<SVGPathElement>(null);
  const netRef = useRef<SVGGElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const nodeRef = useRef<SVGCircleElement>(null);

  useLayoutEffect(() => {
    if (still) return undefined;
    const svg = svgRef.current;
    const echo = echoRef.current;
    const main = mainRef.current;
    const net = netRef.current;
    const ring = ringRef.current;
    const node = nodeRef.current;
    if (!svg || !echo || !main || !net || !ring || !node) return undefined;

    const home = SHAPES.thread;
    const cur: Pt[] = copyPts(home);
    const lag: Pt[] = copyPts(home);
    let from: Pt[] = copyPts(cur);
    let to: readonly Pt[] = home;
    let k = 0;
    let moving = false;
    let t0 = 0;
    let hold = INTRO_MS + HOME_HOLD_MS;
    let b = 0; // network scale (spring)
    let bv = 0;
    let rot = 0;
    let tilt = 0;
    let clock = 0; // accumulated animation time (ms): pausing off-screen never skips the intro
    let introDone = false;
    let raf = 0;
    let last = 0;
    let visible = true;
    let disposed = false;

    if (intro === 'once' && readSeen()) {
      introDone = true;
      b = 1;
      hold = HOME_HOLD_MS;
    } else {
      main.style.strokeDasharray = '1';
      main.style.strokeDashoffset = '1';
      echo.style.visibility = 'hidden';
    }

    const write = (appear: number): void => {
      main.setAttribute('d', pathFor(cur));
      echo.setAttribute('d', pathFor(lag));
      const p = cur[9];
      const r = (11 + 3 * Math.min(b, 1.3)) * appear;
      for (const c of [node, ring]) {
        c.setAttribute('cx', String(p[0]));
        c.setAttribute('cy', String(p[1]));
        c.setAttribute('r', String(r));
      }
      if (b < 0.01) net.setAttribute('display', 'none');
      else {
        net.removeAttribute('display');
        net.setAttribute('transform', `translate(${p[0]} ${p[1]}) rotate(${rot}) scale(${b})`);
      }
    };

    const start = (): void => {
      k = (k + 1) % SEQUENCE.length;
      from = copyPts(cur);
      to = SHAPES[SEQUENCE[k]];
      t0 = clock;
      moving = true;
    };

    const canRun = (): boolean => visible && !document.hidden;

    const frame = (now: number): void => {
      raf = 0;
      if (disposed || !canRun()) return;
      const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
      last = now;
      clock += dt * 1000;

      const iu = Math.min(clock / INTRO_MS, 1);
      if (!introDone) {
        main.style.strokeDashoffset = String(Math.pow(1 - iu, 3));
        if (iu >= 1) {
          introDone = true;
          main.style.strokeDasharray = 'none';
          main.style.strokeDashoffset = '0';
          echo.style.visibility = 'visible';
          if (intro === 'once') writeSeen();
        }
      }
      if (introDone && !moving && (k !== 0 || loop) && clock >= hold) start();
      if (moving) {
        const u = Math.min((clock - t0) / MORPH_MS, 1);
        mix(cur, from, to, easeInOutCubic(u));
        if (u >= 1) {
          moving = false;
          hold = clock + (k === 0 ? HOME_HOLD_MS : HOLD_MS);
        }
      }

      const atHome = introDone && !moving && k === 0;
      const target = atHome ? 1 : 0;
      bv += ((target - b) * 170 - bv * 15) * dt;
      b = Math.max(0, b + bv * dt);
      const rotT = atHome ? tilt * 10 : 0;
      rot += (rotT - rot) * (1 - Math.exp(-dt / 0.25));

      const lagging = lag.some((p, i) => Math.abs(p[0] - cur[i][0]) + Math.abs(p[1] - cur[i][1]) > 0.04);
      if (lagging || moving) follow(lag, cur, dt, 0.12);

      const active =
        !introDone || moving || lagging || Math.abs(target - b) > 0.002 || Math.abs(bv) > 0.002 || Math.abs(rot - rotT) > 0.05;
      write(introDone ? 1 : Math.max(0, (iu - 0.85) / 0.15));
      // Sleep when fully settled; pointer input or visibility changes wake the loop again.
      if (active || k !== 0 || loop) raf = requestAnimationFrame(frame);
    };

    const wake = (): void => {
      if (disposed || raf || !canRun()) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const onMove = (ev: PointerEvent): void => {
      const r = svg.getBoundingClientRect();
      if (r.width > 0) tilt = ((ev.clientX - r.left) / r.width - 0.5) * 2;
      wake();
    };
    const onLeave = (): void => {
      tilt = 0;
      wake();
    };
    const play = (): void => {
      if (introDone && !moving && k === 0) {
        start();
        wake();
      }
    };
    const onVisibility = (): void => {
      if (canRun()) wake();
    };

    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerleave', onLeave);
    if (canMorph) svg.addEventListener('pointerdown', play);
    document.addEventListener('visibilitychange', onVisibility);
    svg.addEventListener('vk-play', play);

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) wake();
      });
      observer.observe(svg);
    }

    write(introDone ? 1 : 0);
    wake();

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerleave', onLeave);
      svg.removeEventListener('pointerdown', play);
      svg.removeEventListener('vk-play', play);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [still, intro, canMorph, loop]);

  const onKeyDown = (ev: KeyboardEvent<SVGSVGElement>): void => {
    if (!canMorph || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    svgRef.current?.dispatchEvent(new Event('vk-play'));
  };

  const sw = size < 48 ? 12 : 9;
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : canMorph
      ? ({ role: 'button', 'aria-label': `${label} — play animation`, tabIndex: 0 } as const)
      : ({ role: 'img', 'aria-label': label } as const);

  return (
    <svg
      ref={svgRef}
      className={className ? `vk-mark ${className}` : 'vk-mark'}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width={size}
      height={Math.round((size * VIEW_H) / VIEW_W)}
      focusable="false"
      data-still={still ? '' : undefined}
      data-interactive={canMorph ? '' : undefined}
      onKeyDown={onKeyDown}
      {...a11y}
    >
      <path ref={echoRef} className="vk-echo" d={pathFor(pts)} strokeWidth={sw} />
      <path ref={mainRef} className="vk-main" d={pathFor(pts)} strokeWidth={sw} pathLength={1} />
      {showNet && (
        <g ref={netRef} transform={`translate(${end[0]} ${end[1]})`}>
          {NET_LINKS.map(([a, c]) => (
            <line key={`l${a}${c}`} className="vk-link" x1={NET[a][0]} y1={NET[a][1]} x2={NET[c][0]} y2={NET[c][1]} />
          ))}
          {NET.map((q, i) => (
            <line key={`s${i}`} className="vk-link vk-spoke" x1={0} y1={0} x2={q[0]} y2={q[1]} />
          ))}
          {NET.map((q, i) => (
            <circle key={`c${i}`} className={`vk-t-${q[3]}`} cx={q[0]} cy={q[1]} r={q[2]} />
          ))}
        </g>
      )}
      <circle ref={ringRef} className="vk-ring" cx={end[0]} cy={end[1]} r={11} />
      <circle ref={nodeRef} className="vk-node" cx={end[0]} cy={end[1]} r={showNet ? 14 : 11} />
    </svg>
  );
}
