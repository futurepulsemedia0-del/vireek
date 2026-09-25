/**
 * Value-at-Risk Engine — /dashboard/value-at-risk
 *
 * Takes the existing Missed-Revenue Recovery Ledger and, for every open
 * event, prices the full exposure — not just the invoice number — across
 * Revenue, Margin, Cash, Customer LTV, Reputation, Capacity and Compliance.
 * See src/lib/valueAtRisk.ts for the disclosed formula behind every figure.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, ChevronDown, Loader2, Radar, RefreshCw } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import FragilityScorePanel from '@/components/FragilityScorePanel';
import { SOURCE_TYPE_LABELS, relativeTime, type RecoverySourceType } from '@/lib/revenueRecovery';
import {
  buildValueAtRiskReport,
  formatCents,
  DIMENSION_ORDER,
  DIMENSION_LABELS,
  DIMENSION_COLORS,
  VALUE_AT_RISK_ASSUMPTIONS,
  type ValueAtRiskReport,
} from '@/lib/valueAtRisk';

export function ValueAtRiskPage() {
  const [report, setReport] = useState<ValueAtRiskReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAssumptions, setShowAssumptions] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await buildValueAtRiskReport());
    } catch {
      setReport(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <DashboardLayout activeLabel="Value at Risk">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Radar size={18} /> Value-at-Risk Engine
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              A cancelled job is rarely just its own invoice. This prices every open exposure across Revenue, Margin,
              Cash, Customer LTV, Reputation, Capacity and Compliance — with the exact math for every number.
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
            Couldn't build the report just now. Try again in a moment.
          </div>
        ) : (
          <>
            {/* ---- Summary ---- */}
            <div className="mb-3 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="flex items-center gap-4">
                <div className="text-4xl font-bold text-danger">{formatCents(report.grandTotal_cents)}</div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Total value at risk</p>
                  <p className="text-xs text-text-secondary">
                    Across {report.items.length} open event{report.items.length === 1 ? '' : 's'} from the last{' '}
                    {report.assumptions.lookbackDays} days.
                    {report.reputationBaseline.avgRating !== null
                      ? ` Review average: ${report.reputationBaseline.avgRating.toFixed(1)}★ (${report.reputationBaseline.sampleSize} reviews).`
                      : ''}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {DIMENSION_ORDER.map((key) => (
                  <div key={key} className={`rounded-xl px-3 py-2 ${DIMENSION_COLORS[key]}`}>
                    <p className="text-[11px] font-medium opacity-80">{DIMENSION_LABELS[key]}</p>
                    <p className="text-sm font-semibold">{formatCents(report.totalsByDimension[key])}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* ---- Assumptions (disclosed formula) ---- */}
            <button
              type="button"
              onClick={() => setShowAssumptions((v) => !v)}
              className="focus-ring mb-3 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              How these numbers are calculated
              <ChevronDown size={14} className={`transition-transform ${showAssumptions ? 'rotate-180' : ''}`} />
            </button>
            {showAssumptions && (
              <div className="mb-3 space-y-1 rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
                <p>Margin: {Math.round(VALUE_AT_RISK_ASSUMPTIONS.marginPct * 100)}% assumed gross margin on lost revenue.</p>
                <p>Customer LTV: {Math.round(VALUE_AT_RISK_ASSUMPTIONS.relationshipRiskPct * 100)}% of the customer's paid history, for events that damage the relationship.</p>
                <p>Reputation: {Math.round(VALUE_AT_RISK_ASSUMPTIONS.referralMultiplier * 100)}% referral value on customer-facing failures, scaled up below a {VALUE_AT_RISK_ASSUMPTIONS.reputationFragileThreshold}★ review average.</p>
                <p>Capacity: fleet-average paid job value, when a job is cancelled within {VALUE_AT_RISK_ASSUMPTIONS.capacityBackfillWindowHours}h of its slot.</p>
                <p>Compliance: {formatCents(VALUE_AT_RISK_ASSUMPTIONS.complianceExposureCents)} flat exposure when the assigned technician has an expiring/expired credential.</p>
                <p className="pt-1 text-text-secondary">Edit VALUE_AT_RISK_ASSUMPTIONS in src/lib/valueAtRisk.ts to match your real numbers.</p>
              </div>
            )}

            {/* ---- Items ---- */}
            {report.items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
                Nothing open right now — every recovery-ledger event is resolved.
              </div>
            ) : (
              <div className="space-y-2">
                {report.items.map((item, i) => {
                  const isOpen = expandedId === item.event.id;
                  return (
                    <motion.div
                      key={item.event.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i, 8) * 0.02 }}
                      className="rounded-2xl border border-border bg-bg-secondary p-4"
                    >
                      <button
                        type="button"
                        onClick={() => setExpandedId(isOpen ? null : item.event.id)}
                        className="focus-ring flex w-full items-start justify-between gap-3 text-left"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {item.total_cents >= 100_000 && <AlertTriangle size={14} className="shrink-0 text-danger" />}
                            <p className="truncate text-sm font-medium text-text-primary">{item.event.customer_name || 'Unknown customer'}</p>
                          </div>
                          <p className="mt-0.5 text-xs text-text-secondary">
                            {SOURCE_TYPE_LABELS[item.event.source_type as RecoverySourceType]} · {relativeTime(item.event.occurred_at)}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-semibold text-danger">{formatCents(item.total_cents)}</p>
                          <p className="text-[11px] text-text-secondary">at risk</p>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                          {item.dimensions.filter((d) => d.flagged).map((d) => (
                            <div key={d.key} className="flex items-start justify-between gap-3 text-xs">
                              <div className="min-w-0">
                                <span className={`mr-2 rounded-md px-1.5 py-0.5 font-medium ${DIMENSION_COLORS[d.key]}`}>
                                  {DIMENSION_LABELS[d.key]}
                                </span>
                                <span className="text-text-secondary">{d.basis}</span>
                              </div>
                              <span className="shrink-0 font-medium text-text-primary">{formatCents(d.amount_cents)}</span>
                            </div>
                          ))}
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
