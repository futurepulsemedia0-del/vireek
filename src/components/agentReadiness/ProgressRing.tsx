import { ringOffset, scoreTone, type ScoreTone } from '@/lib/agentReadinessCore';

const R = 52;
const C = 2 * Math.PI * R;
const TONE: Record<ScoreTone, string> = { good: 'text-success-500', ok: 'text-accent', poor: 'text-warning-500' };

/** Score ring. The number is real text (not only colour), and the arc animation is off under reduced motion. */
export function ProgressRing({ score, label, unknownLabel }: { score: number | null; label: string; unknownLabel: string }) {
  return (
    <div className="relative h-36 w-36 shrink-0" role="img" aria-label={score === null ? unknownLabel : `${label}: ${score} / 100`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" strokeWidth="10" className="text-bg-tertiary" />
        <circle cx="60" cy="60" r={R} fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={ringOffset(score, C)}
          className={`${TONE[scoreTone(score)]} transition-[stroke-dashoffset] duration-700 ease-out-expo motion-reduce:transition-none`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums text-text-primary">{score ?? '–'}</span>
        {score !== null && <span className="text-xs text-text-secondary">/ 100</span>}
      </div>
    </div>
  );
}
