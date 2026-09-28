import { useEffect, useState } from 'react';
import { HeartPulse } from 'lucide-react';
import {
  GRADE_STYLES,
  fetchHomeHealthActions,
  fetchHomeHealthScoreForCustomer,
  windowLabel,
  type HomeHealthAction,
  type HomeHealthScore,
} from '@/lib/homeHealth';

const RISK_DOT: Record<string, string> = {
  high: 'bg-danger-500',
  medium: 'bg-warning-500',
  low: 'bg-success-500',
};

/** Compact Home Health Score for one customer — drop into CustomerDetailPage. */
export function HomeHealthCard({ customerId }: { customerId: string }) {
  const [score, setScore] = useState<HomeHealthScore | null>(null);
  const [actions, setActions] = useState<HomeHealthAction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, a] = await Promise.all([fetchHomeHealthScoreForCustomer(customerId), fetchHomeHealthActions(customerId)]);
        if (cancelled) return;
        setScore(s);
        setActions(a);
      } catch {
        // Non-critical panel: fail quiet rather than break the customer page.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [customerId]);

  if (loading) return null;

  const active = actions.filter((a) => !['verified', 'declined', 'dismissed', 'expired'].includes(a.stage));

  return (
    <div className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10 text-accent"><HeartPulse size={16} /></span>
        <h2 className="text-sm font-semibold text-text-primary">Home Health Score</h2>
      </div>

      {!score ? (
        <p className="text-xs text-text-secondary">
          No score yet. Add equipment with install dates below — the agent scores this home on its next run.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-4">
            <div className="text-3xl font-bold text-text-primary">{score.score}<span className="text-sm font-medium text-text-secondary">/100</span></div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${GRADE_STYLES[score.grade]}`}>Grade {score.grade}</span>
            <span className="text-xs text-text-secondary">{Math.round(score.confidence * 100)}% data confidence</span>
          </div>
          <ul className="mt-3 space-y-1.5">
            {score.breakdown.map((e) => (
              <li key={e.equipment_id} className="flex items-center justify-between gap-3 text-xs">
                <span className="flex items-center gap-2 text-text-primary">
                  <span className={`h-2 w-2 rounded-full ${RISK_DOT[e.risk]}`} aria-hidden />
                  {e.label}
                </span>
                <span className="text-text-secondary">
                  {e.health}/100{e.risk !== 'low' ? ` · service window ${windowLabel(e.window_min_months, e.window_max_months)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {active.length > 0 && (
            <p className="mt-3 text-xs font-medium text-accent">
              {active.length} proactive action{active.length === 1 ? '' : 's'} in progress — {active.map((a) => a.stage.replace('_', ' ')).join(', ')}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
