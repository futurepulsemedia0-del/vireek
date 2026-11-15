interface Props {
  score: number;
  size?: number;
  label: string;
  valueText: string;
}

/** Accessible progress ring. Colour from tokens only; no motion for reduced-motion users. */
export function KnowledgeRing({ score, size = 64, label, valueText }: Props) {
  const stroke = Math.max(4, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-border" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          className="text-accent transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
        />
      </svg>
      <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-text-primary">
        {valueText}
      </span>
    </div>
  );
}
