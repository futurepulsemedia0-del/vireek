import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Target, Info } from 'lucide-react';
import type { Call } from '@/lib/supabase';

const UNATTRIBUTED_LABEL = 'Direct / Not tracked';

const BAR_COLORS = ['bg-accent', 'bg-cta', 'bg-success-500', 'bg-warning-500', 'bg-blue-500', 'bg-text-secondary/50'];

interface LeadSourceBreakdownProps {
  calls: Call[];
}

/**
 * Groups calls by `source_label` (stamped by vapi-webhook when the dialed
 * number matches a configured row in `call_sources` — see
 * 20260912070000_call_source_attribution.sql). Deliberately NOT trying to
 * guess a source when none is configured — that's just "Direct / Not
 * tracked", which is the honest answer for a business with one phone number.
 */
export function LeadSourceBreakdown({ calls }: LeadSourceBreakdownProps) {
  const data = useMemo(() => {
    const counts = new Map<string, number>();
    for (const call of calls) {
      const label = (call.source_label as string | null | undefined)?.trim() || UNATTRIBUTED_LABEL;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const total = calls.length;
    const rows = Array.from(counts.entries())
      .map(([label, count]) => ({ label, count, pct: total > 0 ? Math.round((count / total) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);
    const hasAnyAttribution = rows.some((r) => r.label !== UNATTRIBUTED_LABEL);
    return { rows, total, hasAnyAttribution };
  }, [calls]);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Target size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Lead Source</h3>
          <p className="text-xs text-text-secondary">Which channel each call came from, this period</p>
        </div>
      </div>

      {data.total === 0 ? (
        <p className="mt-6 text-sm text-text-secondary">No calls in this period yet.</p>
      ) : (
        <div className="mt-5 space-y-3">
          {data.rows.map((row, i) => (
            <div key={row.label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium text-text-primary">{row.label}</span>
                <span className="text-text-secondary">
                  {row.count} · {row.pct}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${row.pct}%` }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className={`h-full rounded-full ${BAR_COLORS[i % BAR_COLORS.length]}`}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {!data.hasAnyAttribution && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-dashed border-border p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
          <p className="text-xs leading-relaxed text-text-secondary">
            Every call is showing as unattributed because no call tracking numbers are set up. Add one per
            channel (Google Business Profile, a specific ad campaign, a referral partner) in{' '}
            <a href="/dashboard/business-profile" className="font-semibold text-accent hover:underline">
              Business Profile → Call Sources
            </a>{' '}
            to start splitting this out.
          </p>
        </div>
      )}
    </div>
  );
}
