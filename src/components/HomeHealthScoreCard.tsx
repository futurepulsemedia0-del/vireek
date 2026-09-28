import { useMemo } from 'react';
import { HeartPulse, ShieldAlert, TrendingUp, Info } from 'lucide-react';
import type { PropertyTwin } from '@/lib/propertyTwin';
import {
  computeHomeHealth,
  TIER_LABELS,
  tierForScore,
  type HealthTier,
  type RiskLevel,
  type ScoreConfidence,
} from '@/lib/homeHealthScore';

const TIER_TEXT: Record<HealthTier, string> = {
  excellent: 'text-success-500',
  good: 'text-success-500',
  fair: 'text-warning-500',
  at_risk: 'text-danger-500',
  critical: 'text-danger-500',
};

const TIER_BAR: Record<HealthTier, string> = {
  excellent: 'bg-success-500',
  good: 'bg-success-500',
  fair: 'bg-warning-500',
  at_risk: 'bg-danger-500',
  critical: 'bg-danger-500',
};

const TIER_STROKE: Record<HealthTier, string> = {
  excellent: 'stroke-success-500',
  good: 'stroke-success-500',
  fair: 'stroke-warning-500',
  at_risk: 'stroke-danger-500',
  critical: 'stroke-danger-500',
};

const RISK_BADGE: Record<RiskLevel, string> = {
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-success-500/10 text-success-500',
};

const CONFIDENCE_COPY: Record<ScoreConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence — add install dates or missing systems to sharpen it',
  low: 'Low confidence — few systems or install dates on record',
};

const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ScoreRing({ score, tier }: { score: number; tier: HealthTier }) {
  const offset = RING_CIRCUMFERENCE * (1 - score / 100);
  return (
    <div className="relative h-32 w-32 shrink-0" role="img" aria-label={`Home Health Score ${score} out of 100, ${TIER_LABELS[tier]}`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r={RING_RADIUS} fill="none" strokeWidth="9" className="stroke-border" />
        <circle
          cx="60"
          cy="60"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          className={`${TIER_STROKE[tier]} transition-[stroke-dashoffset] duration-700 ease-out`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold leading-none text-text-primary">{score}</span>
        <span className="mt-1 text-[11px] font-medium text-text-secondary">out of 100</span>
      </div>
    </div>
  );
}

export function HomeHealthScoreCard({ twin }: { twin: PropertyTwin }) {
  const health = useMemo(() => computeHomeHealth(twin), [twin]);

  if (health.score === null || health.tier === null) {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <div className="mb-2 flex items-center gap-2">
          <HeartPulse size={16} className="text-cta" />
          <p className="text-sm font-semibold text-text-primary">Home Health Score</p>
        </div>
        <p className="text-sm text-text-secondary">
          Add the HVAC, plumbing, electrical, water heater, roof or safety equipment installed at this property to unlock its score.
        </p>
      </div>
    );
  }

  const { score, tier, projectedScore } = health;
  const gain = projectedScore !== null ? projectedScore - score : 0;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-4 flex items-center gap-2">
        <HeartPulse size={16} className="text-cta" />
        <p className="text-sm font-semibold text-text-primary">Home Health Score</p>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex items-center gap-5">
          <ScoreRing score={score} tier={tier} />
          <div>
            <p className={`text-lg font-semibold ${TIER_TEXT[tier]}`}>{TIER_LABELS[tier]}</p>
            {gain >= 3 && projectedScore !== null && (
              <p className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                <TrendingUp size={12} className="text-success-500" />
                Reaches {projectedScore} once open service items are resolved
              </p>
            )}
            {health.capped && (
              <p className="mt-1 text-xs text-text-secondary">Held down by one critical system.</p>
            )}
            <p className="mt-2 flex items-start gap-1 text-[11px] text-text-secondary">
              <Info size={11} className="mt-0.5 shrink-0" />
              <span>
                {CONFIDENCE_COPY[health.confidence]} · {health.coveredCategories} of 6 systems scored
                {health.unclassifiedCount > 0 ? ` · ${health.unclassifiedCount} other item${health.unclassifiedCount === 1 ? '' : 's'} not scored` : ''}
              </span>
            </p>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {health.categories.map((c) => (
            <div key={c.key}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium text-text-primary">{c.label}</span>
                <span className={c.tier ? `font-semibold ${TIER_TEXT[c.tier]}` : 'text-text-secondary'}>
                  {c.score === null ? 'Not recorded' : c.score}
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-border"
                role="progressbar"
                aria-label={`${c.label} health`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={c.score ?? undefined}
              >
                {c.score !== null && c.tier && (
                  <div className={`h-full rounded-full ${TIER_BAR[c.tier]} transition-[width] duration-700 ease-out`} style={{ width: `${c.score}%` }} />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldAlert size={15} className="text-cta" />
          <p className="text-sm font-semibold text-text-primary">Top risks over the next 12 months</p>
        </div>
        {health.topRisks.length === 0 ? (
          <p className="text-sm text-text-secondary">Nothing on record is likely to need major attention in the next 12 months.</p>
        ) : (
          <ol className="space-y-2">
            {health.topRisks.map((r, i) => (
              <li key={r.equipmentId} className="flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-secondary text-xs font-semibold text-text-secondary">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="truncate font-medium text-text-primary">
                      {r.label} <span className="font-normal text-text-secondary">· {r.categoryLabel}</span>
                    </p>
                    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${RISK_BADGE[r.level]}`}>
                      {Math.round(r.probability12m * 100)}% · {r.level.toUpperCase()}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-text-secondary">{r.reason}</p>
                  <p className="text-xs text-text-secondary">
                    → {r.action}
                    {r.dueBy ? ` (expected by ${new Date(r.dueBy).toLocaleDateString()})` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-[11px] text-text-secondary">
          Estimated from equipment age vs. expected lifespan, service history and predictive alerts. Scale: {TIER_LABELS[tierForScore(90)]} 90+ · {TIER_LABELS[tierForScore(75)]} 75+ · {TIER_LABELS[tierForScore(60)]} 60+ · {TIER_LABELS[tierForScore(40)]} 40+.
        </p>
      </div>
    </div>
  );
}
