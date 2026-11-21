import type { CSSProperties } from 'react';
import './loading.css';
import './brand-loader.css';

const RING_DELAYS = [0, 0.8, 1.6] as const;
const delay = (s: number): CSSProperties => ({ ['--d' as string]: s });

interface BrandDotProps {
  /** px. Designed for spots under 32px, where the full V would be unreadable. */
  size?: number;
  className?: string;
  /** Provide for a standalone dot so assistive tech hears the status. Omit when text already announces it. */
  label?: string;
}

/**
 * The orange "answered" dot with signal rings: the small-spot form of the brand loader (BrandLoader `signal`).
 * Use on neutral surfaces (toasts, pull-to-refresh, inline status). On orange buttons keep <Spinner />:
 * an orange dot would vanish there. SVG + CSS only; reduced motion → static dot with a slow opacity pulse.
 */
export function BrandDot({ size = 20, className = '', label }: BrandDotProps) {
  const px = Math.max(12, Math.round(size));
  const svg = (
    <svg
      className={`vrk-v vrk-v--signal vrk-v--dot ${className}`.trim()}
      width={px}
      height={px}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      {RING_DELAYS.map((d) => (
        <circle key={d} className="vrk-v__rg" cx={20} cy={20} r={5} style={delay(d)} />
      ))}
      <circle className="vrk-v__nd" cx={20} cy={20} r={5} />
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
