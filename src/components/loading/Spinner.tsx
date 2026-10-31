import './loading.css';

interface SpinnerProps {
  /** px. Drop-in for lucide's `size` prop. Tailwind `h-*`/`w-*` classes override it. */
  size?: number;
  className?: string;
  /** Provide for a standalone spinner so assistive tech hears the status. */
  label?: string;
}

/** Mini waveform. Monochrome: inherits `currentColor`, so `text-*` classes work. */
const BARS = [
  { x: 4, h: 10 },
  { x: 10, h: 20 },
  { x: 16, h: 10 },
] as const;

export function Spinner({ size = 16, className = '', label }: SpinnerProps) {
  const svg = (
    <svg
      className={`vrk-spin ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {BARS.map((b, i) => (
        <rect
          key={b.x}
          className="vrk-anim"
          x={b.x}
          y={12 - b.h / 2}
          width="4"
          height={b.h}
          rx="2"
          style={{ animationDelay: `${i * 110}ms` }}
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
