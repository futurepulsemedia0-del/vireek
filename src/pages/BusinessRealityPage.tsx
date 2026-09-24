/**
 * Business Reality Engine — /dashboard/reality
 *
 * Reads current data directly (no cache, no AI) and shows what's
 * actually going on: missing data, reported-vs-field contradictions,
 * and pending Decision Engine calls resting on thin data. See
 * src/lib/businessReality.ts for every check and its exact source.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Telescope } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  buildRealityReport,
  CATEGORY_LABELS,
  RealityCategory,
  RealityReport,
  SEVERITY_COLORS,
  SEVERITY_LABELS,
} from '@/lib/businessReality';

function scoreTone(score: number): string {
  if (score >= 85) return 'text-success-500';
  if (score >= 60) return 'text-warning-500';
  return 'text-danger';
}

export function BusinessRealityPage() {
  const [report, setReport] = useState<RealityReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await buildRealityReport());
    } catch {
      setReport(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const grouped: Record<RealityCategory, typeof report extends null ? never : RealityReport['findings']> = {
    missing_data: report?.findings.filter((f) => f.category === 'missing_data') ?? [],
    contradiction: report?.findings.filter((f) => f.category === 'contradiction') ?? [],
    unreliable_decision: report?.findings.filter((f) => f.category === 'unreliable_decision') ?? [],
  } as Record<RealityCategory, RealityReport['findings']>;

  return (
    <DashboardLayout activeLabel="Business Reality">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Telescope size={18} /> Business Reality Engine
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              What's actually true right now, not what the dashboards assume. Computed live from your own data — nothing cached, nothing invented.
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
          <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
            Couldn't scan your data just now. Try again in a moment.
          </div>
        ) : (
          <>
            <div className="mb-5 flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className={`text-4xl font-bold ${scoreTone(report.score)}`}>{report.score}</div>
              <div>
                <p className="text-sm font-medium text-text-primary">Reality score</p>
                <p className="text-xs text-text-secondary">
                  100 minus a fixed deduction per open issue (5/10/15 by severity) — no hidden weighting. Billing data {report.domainCompleteness.billingPct ?? '—'}% complete · dispatch data {report.domainCompleteness.dispatchPct ?? '—'}% complete.
                </p>
              </div>
            </div>

            {report.findings.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-success-500" />
                <p className="text-sm text-text-secondary">Nothing off right now — reported state matches what the checks can see.</p>
              </div>
            ) : (
              (Object.keys(CATEGORY_LABELS) as RealityCategory[]).map((cat) =>
                grouped[cat].length === 0 ? null : (
                  <div key={cat} className="mb-5">
                    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{CATEGORY_LABELS[cat]}</h2>
                    <div className="space-y-2">
                      {grouped[cat].map((f) => (
                        <motion.div key={f.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border bg-bg-secondary p-4">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <AlertTriangle size={14} className="text-text-secondary" />
                            <p className="text-sm font-semibold text-text-primary">{f.title}</p>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SEVERITY_COLORS[f.severity]}`}>{SEVERITY_LABELS[f.severity]}</span>
                            <span className="ml-auto text-xs text-text-secondary">{f.count} affected</span>
                          </div>
                          <p className="text-xs text-text-secondary">{f.detail}</p>
                          {f.sample.length > 0 && (
                            <p className="mt-1.5 text-[11px] text-text-secondary/70">e.g. {f.sample.slice(0, 5).join(', ')}{f.count > f.sample.length ? '…' : ''}</p>
                          )}
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
