import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HeartHandshake, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { SIGNAL_TYPE_LABELS, SEVERITY_COLORS, SEVERITY_LABELS, bySeverityThenRecency, formatRelativeTime, type Severity, type SignalType } from '@/lib/serviceRecovery';

interface SignalRow {
  id: string;
  customer_name: string;
  signal_type: SignalType;
  severity: Severity;
  signal_excerpt: string | null;
  detected_at: string;
}

const MAX_ROWS = 6;

/**
 * Self-contained on purpose (own fetch) — same idiom as WarrantyIntelligence /
 * ReworkIntelligence — so it drops into AnalyticsPage.tsx with one line.
 *
 * Reads the live `service_recovery_signals` table. Detection itself (missed
 * ETAs, overdue promises, negative sentiment calls, negative private
 * reviews) happens server-side in the detect-service-recovery-signals cron
 * function — this card is a live read of the same data, not a second
 * detector, so the two can never disagree about what's at risk.
 */
export function ServiceRecoveryIntelligence() {
  const { user } = useAuth();
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from('service_recovery_signals')
      .select('id, customer_name, signal_type, severity, signal_excerpt, detected_at')
      .eq('status', 'open')
      .order('detected_at', { ascending: false })
      .limit(50);
    setRows(bySeverityThenRecency((data as SignalRow[] | null) ?? []));
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="animate-pulse rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
        <div className="h-5 w-56 rounded bg-bg-tertiary" />
        <div className="mt-4 h-16 rounded bg-bg-tertiary" />
      </div>
    );
  }

  const criticalCount = rows.filter((r) => r.severity === 'critical').length;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
          <HeartHandshake size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Service Recovery Intelligence</h3>
          <p className="text-xs text-text-secondary">Missed ETAs, overdue promises, negative sentiment and low private reviews — before they become a churn or a bad review</p>
        </div>
        {rows.length > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger">
            {rows.length} open{criticalCount > 0 ? ` · ${criticalCount} critical` : ''}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-text-secondary">
          <ShieldCheck size={16} className="shrink-0 text-success-500" />
          Nothing at risk right now — every open signal has been handled.
        </div>
      ) : (
        <div className="mt-5 space-y-2">
          {rows.slice(0, MAX_ROWS).map((row) => (
            <Link
              key={row.id}
              to="/dashboard/service-recovery"
              className="flex items-center justify-between gap-3 rounded-xl bg-bg-primary px-3 py-2 transition-colors hover:bg-bg-tertiary"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-text-primary">{row.customer_name || 'Unknown customer'}</p>
                <p className="truncate text-xs text-text-secondary">{row.signal_excerpt || SIGNAL_TYPE_LABELS[row.signal_type]}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_COLORS[row.severity]}`}>{SEVERITY_LABELS[row.severity]}</span>
                <span className="text-[11px] text-text-secondary">{formatRelativeTime(row.detected_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {rows.length > MAX_ROWS && (
        <Link to="/dashboard/service-recovery" className="focus-ring mt-4 block text-center text-xs font-medium text-accent hover:underline">
          View all {rows.length} open signals
        </Link>
      )}
    </div>
  );
}
