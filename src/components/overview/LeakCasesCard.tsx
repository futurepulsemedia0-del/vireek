import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Snowflake } from 'lucide-react';
import { fetchLeakSummary, type LeakSummary } from '@/lib/leakRepair';

/**
 * Overview widget: refrigerant leak cases. Turns red when any case is overdue.
 * Renders nothing when the account has no active case (or the lookup fails),
 * so shops without regulated refrigerant never see it.
 */
export function LeakCasesCard() {
  const [s, setS] = useState<LeakSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchLeakSummary()
      .then((v) => alive && setS(v))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  if (failed) return null;
  if (!s) return <div className="h-28 w-full vrk-skel rounded-xl bg-bg-tertiary" />;
  if (s.active === 0) return null;

  const overdue = s.overdue > 0;
  return (
    <Link
      to="/dashboard/refrigerant-leaks"
      className={`focus-ring flex h-full items-center gap-4 rounded-xl border p-5 transition-colors ${overdue ? 'border-danger/40 bg-danger/5 hover:border-danger' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center ${overdue ? 'text-danger' : 'text-text-muted'}`}
      >
        {overdue ? (
          <AlertTriangle size={20} aria-hidden="true" />
        ) : (
          <Snowflake size={20} aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-text-secondary">
          Refrigerant leak cases
        </p>
        <p className="mt-0.5 flex items-baseline gap-2">
          <span className={`text-2xl font-semibold tabular-nums ${overdue ? 'text-danger' : 'text-text-primary'}`}>
            {overdue ? s.overdue : s.active}
          </span>
          <span className="text-sm text-text-secondary">{overdue ? 'overdue' : 'active'}</span>
        </p>
        <p className="mt-1 truncate text-xs text-text-secondary">
          {s.active} active · {s.due_soon} due within 7 days · {s.failed} repair failed
        </p>
      </div>
      <ArrowRight size={16} className="shrink-0 text-text-secondary" />
    </Link>
  );
}
