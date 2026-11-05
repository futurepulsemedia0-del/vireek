import './loading.css';

export type PulseSize = 'xs' | 'sm' | 'md' | 'lg';

const PX: Record<PulseSize, number> = { xs: 16, sm: 24, md: 40, lg: 64 };

// Same five-bar waveform as the boot loader in index.html (viewBox 40×40). The centre bar is the "answered" accent.
const BARS = [
  { x: 2, h: 14 },
  { x: 10, h: 24 },
  { x: 18, h: 34 },
  { x: 26, h: 24 },
  { x: 34, h: 14 },
] as const;

interface PulseMarkProps {
  size?: PulseSize;
  className?: string;
  /** Provide for a standalone mark so assistive tech hears the status. Omit when text already announces it. */
  label?: string;
}

/** Vireek Pulse: indigo bars wave in a 90ms stagger; the orange centre bar + ripple ring mark the answer. */
export function PulseMark({ size = 'md', className = '', label }: PulseMarkProps) {
  const px = PX[size];
  const svg = (
    <svg
      className={`vrk-pulse ${className}`.trim()}
      width={px}
      height={px}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="vrk-pulse__ring vrk-anim" cx="20" cy="20" r="18" />
      {BARS.map((b, i) => (
        <rect
          key={b.x}
          className={`vrk-pulse__bar vrk-anim${i === 2 ? ' vrk-pulse__core' : ''}`}
          x={b.x}
          y={20 - b.h / 2}
          width="4"
          height={b.h}
          rx="2"
          style={{ animationDelay: `${i * 90}ms` }}
        />
      ))}
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
