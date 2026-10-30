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
  if (!s) return <div className="h-28 w-full animate-pulse rounded-2xl bg-bg-tertiary" />;
  if (s.active === 0) return null;

  const overdue = s.overdue > 0;
  return (
    <Link
      to="/dashboard/refrigerant-leaks"
      className={`focus-ring flex h-full items-center gap-4 rounded-2xl border p-5 shadow-card transition-colors dark:shadow-card-dark ${overdue ? 'border-danger/40 bg-danger/5 hover:border-danger' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
    >
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${overdue ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent'}`}
      >
        {overdue ? (
          <AlertTriangle size={20} aria-hidden="true" />
        ) : (
          <Snowflake size={20} aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
          Refrigerant leak cases
        </p>
        <p className="mt-0.5 flex items-baseline gap-2">
          <span className={`text-3xl font-bold ${overdue ? 'text-danger' : 'text-text-primary'}`}>
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
