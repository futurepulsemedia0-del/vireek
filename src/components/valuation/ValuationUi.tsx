import { BAND_LABEL, readinessBand, type Confidence, type ReadinessBand } from '@/lib/valuation';

const BAND_TONE: Record<ReadinessBand, string> = {
  not_ready: 'text-danger',
  early: 'text-warning-500',
  nearly: 'text-accent',
  ready: 'text-success',
};

function bandTone(score: number | null): string {
  const band = readinessBand(score);
  return band ? BAND_TONE[band] : 'text-text-secondary';
}

export function StatCard({ label, value, hint, tone = 'text-text-primary' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 break-words text-2xl font-bold ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

/** Circular 0–100 score. Text is real DOM text so screen readers and tests can read it. */
export function ScoreRing({ score, label, size = 132 }: { score: number | null; label: string; size?: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const pct = score == null ? 0 : Math.min(100, Math.max(0, score));
  const band = readinessBand(score);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={score == null ? `${label}: not scored yet` : `${label}: ${score} out of 100, ${BAND_LABEL[band as ReadinessBand]}`}>
      <svg viewBox="0 0 120 120" width={size} height={size} className={`-rotate-90 ${bandTone(score)}`} aria-hidden="true">
        <circle cx="60" cy="60" r={radius} fill="none" strokeWidth="10" className="stroke-bg-tertiary" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-3xl font-bold ${bandTone(score)}`}>{score == null ? '—' : score}</span>
        <span className="text-[11px] font-medium text-text-secondary">{score == null ? 'Not scored' : 'out of 100'}</span>
      </div>
    </div>
  );
}

export function BandBadge({ score }: { score: number | null }) {
  const band = readinessBand(score);
  if (!band) return <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary">Not scored</span>;
  return <span className={`rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-semibold ${BAND_TONE[band]}`}>{BAND_LABEL[band]}</span>;
}

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-secondary" title="Rises as you answer more of the questionnaire and fill in the optional numbers.">
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

export function ScoreBar({ label, score, detail }: { label: string; score: number | null; detail?: string }) {
  const pct = score ?? 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-text-primary">{label}</span>
        <span className={`shrink-0 font-semibold ${bandTone(score)}`}>{score == null ? '—' : `${score}`}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score ?? 0}>
        <div className={`h-full rounded-full bg-current ${bandTone(score)}`} style={{ width: `${pct}%` }} />
      </div>
      {detail && <p className="mt-1 text-xs text-text-secondary">{detail}</p>}
    </div>
  );
}
