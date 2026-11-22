import type { CSSProperties } from 'react';
import './loading.css';
import './brand-loader.css';

export type BrandLoaderVariant = 'thread' | 'fill' | 'signal' | 'network' | 'pulse';
export type BrandLoaderSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

/** Height in px; width follows the 260×240 viewBox. */
const HEIGHT: Record<BrandLoaderSize, number> = { xs: 24, sm: 32, md: 56, lg: 80, xl: 120, xxl: 144 };

const V_PATH = 'M46 50L120 196L194 50';
const DOT = { cx: 194, cy: 50, r: 14 } as const;
const RING_DELAYS = [0, 0.8, 1.6] as const;
const SATELLITES = [
  { x: 160, y: 30, r: 5, tone: 'k' },
  { x: 198, y: 10, r: 5.5, tone: 'i' },
  { x: 230, y: 34, r: 5, tone: 'o' },
  { x: 232, y: 76, r: 6, tone: 'i' },
] as const;

interface BrandLoaderProps {
  /** thread: site open · fill: progress · signal: between pages / small · network: data / dashboard · pulse: in-app navigation */
  variant?: BrandLoaderVariant;
  size?: BrandLoaderSize;
  /** 0–100. Real values only: used by `fill`; omit for the indeterminate loop. */
  progress?: number | null;
  /** Provide for a standalone loader so assistive tech hears the status. Omit when text already announces it. */
  label?: string;
  className?: string;
}

const delay = (s: number): CSSProperties => ({ ['--d' as string]: s });

/** Vireek brand loader: the V mark with the orange "answered" dot. SVG + CSS only, no dependency. */
export function BrandLoader({ variant = 'pulse', size = 'md', progress, label, className = '' }: BrandLoaderProps) {
  const height = HEIGHT[size];
  const determinate = variant === 'fill' && typeof progress === 'number' && Number.isFinite(progress);
  const pct = determinate ? Math.min(100, Math.max(0, progress as number)) : 0;
  const cls = [
    'vrk-v',
    `vrk-v--${variant}`,
    determinate ? 'vrk-v--det' : '',
    determinate && pct >= 100 ? 'vrk-v--done' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const svg = (
    <svg
      className={cls}
      width={Math.round((height * 260) / 240)}
      height={height}
      viewBox="0 0 260 240"
      aria-hidden="true"
      focusable="false"
    >
      {(variant === 'fill' || variant === 'pulse') && <path className="vrk-v__tr" d={V_PATH} />}

      {variant === 'pulse' ? (
        <path className="vrk-v__pl" d={V_PATH} pathLength={1} />
      ) : variant === 'fill' && determinate ? (
        <path
          className="vrk-v__m"
          d={V_PATH}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - pct / 100}
          opacity={pct > 0 ? 1 : 0}
        />
      ) : (
        <path className="vrk-v__m" d={V_PATH} pathLength={1} />
      )}

      {variant === 'signal' &&
        RING_DELAYS.map((d) => <circle key={d} className="vrk-v__rg" cx={DOT.cx} cy={DOT.cy} r={DOT.r} style={delay(d)} />)}

      {variant === 'network' && (
        <g>
          {SATELLITES.map((s, i) => (
            <line
              key={`l${i}`}
              className="vrk-v__lk"
              x1={DOT.cx}
              y1={DOT.cy}
              x2={s.x}
              y2={s.y}
              style={delay(i * 0.22)}
            />
          ))}
          {SATELLITES.map((s, i) => (
            <circle
              key={`s${i}`}
              className={`vrk-v__sat vrk-v__sat--${s.tone}`}
              cx={s.x}
              cy={s.y}
              r={s.r}
              style={delay(i * 0.22 + 0.1)}
            />
          ))}
        </g>
      )}

      <circle className="vrk-v__nd" cx={DOT.cx} cy={DOT.cy} r={DOT.r} />
    </svg>
  );

  if (!label) return svg;
  return (
    <span role="status" className="inline-flex">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
