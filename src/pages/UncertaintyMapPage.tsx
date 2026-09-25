/**
 * Uncertainty & Evidence Map — /dashboard/uncertainty-map
 *
 * Every other page in this dashboard shows a confident number. This one
 * shows the opposite, on purpose: where the evidence behind those numbers is
 * thin, missing, or unreviewed — grouped by Data Quality, Customer Profiles,
 * Forecast Reliability, Integration Sync, and AI Actions Needing You.
 * See src/lib/uncertaintyMap.ts for the disclosed logic behind every item.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, ChevronDown, Fingerprint, RefreshCw, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  buildUncertaintyReport,
  confidenceLabel,
  DOMAIN_ORDER,
  DOMAIN_LABELS,
  SEVERITY_COLORS,
  UNCERTAINTY_ASSUMPTIONS,
  type UncertaintyReport,
  type UncertaintyDomain,
} from '@/lib/uncertaintyMap';

function confidenceTextColor(pct: number): string {
  if (pct >= 80) return 'text-success';
  if (pct >= 55) return 'text-text-primary';
  if (pct >= 30) return 'text-warning-500';
  return 'text-danger';
}

function confidenceBarColor(pct: number): string {
  if (pct >= 80) return 'bg-success';
  if (pct >= 55) return 'bg-text-secondary';
  if (pct >= 30) return 'bg-warning-500';
  return 'bg-danger';
}

export function UncertaintyMapPage() {
  const [report, setReport] = useState<UncertaintyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeDomain, setActiveDomain] = useState<UncertaintyDomain | 'all'>('all');
  const [showAssumptions, setShowAssumptions] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await buildUncertaintyReport());
    } catch {
      setReport(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visibleItems = report?.items.filter((item) => activeDomain === 'all' || item.domain === activeDomain) ?? [];

  return (
    <DashboardLayout activeLabel="Uncertainty & Evidence Map">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Fingerprint size={18} /> Uncertainty &amp; Evidence Map
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Not every number here is equally solid. This maps where a forecast, profile, sync, or AI action is
              currently resting on thin evidence — so you know exactly what to double-check before deciding.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {loading && !report ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : !report ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
            Couldn't build the map just now. Try again in a moment.
          </div>
        ) : (
          <>
            {/* ---- Overall confidence ---- */}
            <div className="mb-3 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex items-center gap-4">
                <div className={`text-4xl font-bold ${confidenceTextColor(report.overallConfidencePct)}`}>
                  {report.overallConfidencePct}%
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    Overall evidence confidence — {confidenceLabel(report.overallConfidencePct)}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {report.items.length === 0
                      ? 'No open uncertainty items right now — every surface below has enough evidence to trust.'
                      : `${report.items.length} open item${report.items.length === 1 ? '' : 's'} across ${DOMAIN_ORDER.length} domains, last ${UNCERTAINTY_ASSUMPTIONS.lookbackDays} days.`}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {report.domainSummaries.map((d) => (
                  <button
                    key={d.domain}
                    type="button"
                    onClick={() => setActiveDomain(activeDomain === d.domain ? 'all' : d.domain)}
                    className={`focus-ring rounded-xl border px-3 py-2 text-left transition-colors ${
                      activeDomain === d.domain ? 'border-text-primary' : 'border-border'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-medium text-text-secondary">{d.label}</p>
                      <p className={`text-xs font-semibold ${confidenceTextColor(d.confidencePct)}`}>{d.confidencePct}%</p>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                      <div
                        className={`h-full rounded-full ${confidenceBarColor(d.confidencePct)}`}
                        style={{ width: `${d.confidencePct}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-text-secondary">
                      {d.itemCount === 0
                        ? 'No open items'
                        : `${d.itemCount} item${d.itemCount === 1 ? '' : 's'}${d.highSeverityCount > 0 ? ` · ${d.highSeverityCount} high` : ''}`}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            {/* ---- Assumptions (disclosed thresholds) ---- */}
            <button
              type="button"
              onClick={() => setShowAssumptions((v) => !v)}
              className="focus-ring mb-3 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              How confidence is calculated
              <ChevronDown size={14} className={`transition-transform ${showAssumptions ? 'rotate-180' : ''}`} />
            </button>
            {showAssumptions && (
              <div className="mb-3 space-y-1 rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
                <p>Lookback window: last {UNCERTAINTY_ASSUMPTIONS.lookbackDays} days of jobs and AI actions.</p>
                <p>A regional forecast built on fewer than {UNCERTAINTY_ASSUMPTIONS.lowSampleForecastThreshold} businesses is flagged low-sample.</p>
                <p>An active/VIP customer with no contact in {UNCERTAINTY_ASSUMPTIONS.staleContactDays} days is flagged stale.</p>
                <p>Each domain starts at 100% and loses points per open item (low −8, medium −22, high −40), floored at 0%.</p>
                <p className="pt-1">Edit UNCERTAINTY_ASSUMPTIONS in src/lib/uncertaintyMap.ts to match your real thresholds.</p>
              </div>
            )}

            {activeDomain !== 'all' && (
              <button
                type="button"
                onClick={() => setActiveDomain('all')}
                className="focus-ring mb-2 text-xs font-medium text-text-secondary underline hover:text-text-primary"
              >
                Showing {DOMAIN_LABELS[activeDomain]} only — clear filter
              </button>
            )}

            {/* ---- Items ---- */}
            {visibleItems.length === 0 ? (
              <div className="flex items-center gap-2 rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
                <ShieldCheck size={16} className="mx-auto text-success" />
                <span className="mx-auto">Nothing open here — this surface currently has enough evidence to trust.</span>
              </div>
            ) : (
              <div className="space-y-2">
                {visibleItems.map((item, i) => {
                  const isOpen = expandedId === item.id;
                  return (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i, 8) * 0.02 }}
                      className="rounded-2xl border border-border bg-bg-secondary p-4"
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedId(isOpen ? null : item.id)}
                        className="focus-ring flex w-full items-start justify-between gap-3 text-left"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {item.severity === 'high' && <AlertTriangle size={14} className="shrink-0 text-danger" />}
                            <p className="truncate text-sm font-medium text-text-primary">{item.title}</p>
                          </div>
                          <p className="mt-0.5 text-xs text-text-secondary">
                            <span className={`mr-2 rounded-md px-1.5 py-0.5 font-medium ${SEVERITY_COLORS[item.severity]}`}>
                              {DOMAIN_LABELS[item.domain]}
                            </span>
                            {item.sampleLabel}
                          </p>
                        </div>
                        <ChevronDown size={16} className={`mt-0.5 shrink-0 text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {isOpen && (
                        <div className="mt-3 space-y-2 border-t border-border pt-3 text-xs">
                          <p className="text-text-secondary">{item.detail}</p>
                          <p className="text-text-primary">
                            <span className="font-medium">Recommended: </span>
                            {item.recommendedAction}
                          </p>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
