/**
 * Invisible Revenue Map — /dashboard/revenue-map
 *
 * Future revenue not yet in the pipeline, pulled live from Equipment
 * Lifecycle, Capacity Demand, and your own job/customer history. See
 * src/lib/invisibleRevenueMap.ts for exactly where each item comes from.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2, MapPinned, RefreshCw } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  buildRevenueMap,
  OpportunityType,
  RevenueMapReport,
  RevenueOpportunity,
  TYPE_LABELS,
} from '@/lib/invisibleRevenueMap';

function formatDollars(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function InvisibleRevenueMapPage() {
  const [report, setReport] = useState<RevenueMapReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await buildRevenueMap());
    } catch {
      setReport(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const grouped: Record<OpportunityType, RevenueOpportunity[]> = {
    asset_risk: report?.opportunities.filter((o) => o.type === 'asset_risk') ?? [],
    capacity_gap: report?.opportunities.filter((o) => o.type === 'capacity_gap') ?? [],
    churn_upsell: report?.opportunities.filter((o) => o.type === 'churn_upsell') ?? [],
    referral_candidate: report?.opportunities.filter((o) => o.type === 'referral_candidate') ?? [],
  };

  return (
    <DashboardLayout activeLabel="Revenue Map">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <MapPinned size={18} /> Invisible Revenue Map
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Money that's likely coming but isn't in any pipeline yet — with the next step to actually go get it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Re-scan
          </button>
        </div>

        {loading && !report ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : !report ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">Couldn't build the map just now. Try again in a moment.</div>
        ) : (
          <>
            <div className="mb-5 rounded-2xl border border-accent/30 bg-accent/5 p-4">
              <p className="text-xs text-text-secondary">Estimated, where a real number could be backed by your own history</p>
              <p className="text-2xl font-bold text-text-primary">{formatDollars(report.totalEstimatedValue)}</p>
            </div>

            {report.opportunities.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
                Nothing surfaced right now — check back after your next few jobs are logged.
              </div>
            ) : (
              (Object.keys(TYPE_LABELS) as OpportunityType[]).map((type) =>
                grouped[type].length === 0 ? null : (
                  <div key={type} className="mb-5">
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{TYPE_LABELS[type]}</h2>
                    <div className="space-y-2">
                      {grouped[type].map((o) => (
                        <motion.div key={o.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-4">
                          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold text-text-primary">{o.title}</p>
                            {o.estimatedValue !== null && <span className="text-sm font-semibold text-success-500">{formatDollars(o.estimatedValue)}</span>}
                          </div>
                          <p className="text-xs text-text-secondary">{o.detail}</p>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <p className="text-xs font-medium text-text-primary">→ {o.nextAction}</p>
                            <Link to={o.actionHref} className="focus-ring flex shrink-0 items-center gap-1 text-xs text-accent">
                              Open <ArrowRight size={11} />
                            </Link>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )
              )
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
