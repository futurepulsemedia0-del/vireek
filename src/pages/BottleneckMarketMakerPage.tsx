/**
 * Bottleneck Market Maker — /dashboard/bottleneck-market
 *
 * Finds the single scarcest technician-skill category this week, then
 * ranks every customer/lead currently competing for it by long-term value,
 * and coordinates Booking, Pricing, Marketing and Dispatch around that one
 * answer. See src/lib/bottleneckMarketMaker.ts for the disclosed logic.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Crosshair,
  RefreshCw,
  ChevronDown,
  CalendarClock,
  DollarSign,
  Megaphone,
  Truck,
  ShieldCheck,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  buildMarketMakerPlan,
  formatCents,
  DECISION_LABELS,
  DECISION_COLORS,
  MARKET_MAKER_ASSUMPTIONS,
  type MarketMakerPlan,
} from '@/lib/bottleneckMarketMaker';

const RECOMMENDATION_SECTIONS: {
  key: keyof MarketMakerPlan['recommendations'];
  label: string;
  icon: typeof CalendarClock;
}[] = [
  { key: 'booking', label: 'Booking', icon: CalendarClock },
  { key: 'pricing', label: 'Pricing', icon: DollarSign },
  { key: 'marketing', label: 'Marketing', icon: Megaphone },
  { key: 'dispatch', label: 'Dispatch', icon: Truck },
];

export function BottleneckMarketMakerPage() {
  const [plan, setPlan] = useState<MarketMakerPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAssumptions, setShowAssumptions] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPlan(await buildMarketMakerPlan());
    } catch {
      setPlan(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <DashboardLayout activeLabel="Bottleneck Market Maker">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Crosshair size={18} /> Bottleneck Market Maker
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Finds the single scarcest resource in the business this week, then decides who gets it —
              and lines up booking, pricing, marketing and dispatch behind that one decision.
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

        {loading && !plan ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : !plan ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
            Couldn't build the plan just now. Try again in a moment.
          </div>
        ) : (
          <>
            {/* ---- Bottleneck summary ---- */}
            <div className="mb-3 rounded-2xl border border-border bg-bg-secondary p-4">
              {plan.bottleneck ? (
                <div className="flex items-center gap-4">
                  <div className="text-4xl font-bold text-danger">{plan.bottleneck.utilizationPct}%</div>
                  <div>
                    <p className="text-sm font-medium text-text-primary">
                      {plan.bottleneck.serviceType} is this week's bottleneck
                    </p>
                    <p className="text-xs text-text-secondary">
                      {plan.bottleneck.techniciansSkilled} technician{plan.bottleneck.techniciansSkilled === 1 ? '' : 's'} ·{' '}
                      {plan.bottleneck.demandUnits} slot{plan.bottleneck.demandUnits === 1 ? '' : 's'} of demand against{' '}
                      {plan.bottleneck.capacityUnits} available over the next {MARKET_MAKER_ASSUMPTIONS.windowDays} days.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <ShieldCheck size={22} className="shrink-0 text-success" />
                  <p className="text-sm text-text-secondary">
                    No category is currently scarce — capacity is healthy across the board this week.
                  </p>
                </div>
              )}

              {plan.allBuckets.length > 1 && (
                <div className="mt-4 space-y-1.5">
                  {plan.allBuckets.map((b) => (
                    <div key={b.serviceType} className="flex items-center gap-2">
                      <p className="w-40 shrink-0 truncate text-[11px] text-text-secondary">{b.serviceType}</p>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                        <div
                          className={`h-full rounded-full ${b.utilizationPct >= MARKET_MAKER_ASSUMPTIONS.scarceUtilizationPct ? 'bg-danger' : 'bg-text-secondary'}`}
                          style={{ width: `${Math.min(b.utilizationPct, 100)}%` }}
                        />
                      </div>
                      <p className="w-10 shrink-0 text-right text-[11px] font-medium text-text-secondary">{b.utilizationPct}%</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ---- Assumptions (disclosed logic) ---- */}
            <button
              type="button"
              onClick={() => setShowAssumptions((v) => !v)}
              className="focus-ring mb-3 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary"
            >
              How the bottleneck and rankings are calculated
              <ChevronDown size={14} className={`transition-transform ${showAssumptions ? 'rotate-180' : ''}`} />
            </button>
            {showAssumptions && (
              <div className="mb-3 space-y-1 rounded-xl border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
                <p>Capacity window: next {MARKET_MAKER_ASSUMPTIONS.windowDays} days of technician availability.</p>
                <p>A category is "the bottleneck" once demand reaches {MARKET_MAKER_ASSUMPTIONS.scarceUtilizationPct}% of capacity.</p>
                <p>Value score = job/quote value + {Math.round(MARKET_MAKER_ASSUMPTIONS.ltvWeight * 100)}% of the customer's paid history + a VIP/active bonus.</p>
                <p>VIP bonus: {formatCents(MARKET_MAKER_ASSUMPTIONS.vipBonusCents)} · Active bonus: {formatCents(MARKET_MAKER_ASSUMPTIONS.activeBonusCents)}.</p>
                <p>Suggested surge pricing while scarce: {MARKET_MAKER_ASSUMPTIONS.surgePricingPct}%.</p>
                <p className="pt-1">Edit MARKET_MAKER_ASSUMPTIONS in src/lib/bottleneckMarketMaker.ts to match your real numbers.</p>
              </div>
            )}

            {/* ---- Recommendations across the 4 levers ---- */}
            {plan.bottleneck && (
              <div className="mb-3 space-y-2">
                {RECOMMENDATION_SECTIONS.map(({ key, label, icon: Icon }) => {
                  const lines = plan.recommendations[key];
                  if (lines.length === 0) return null;
                  return (
                    <div key={key} className="rounded-2xl border border-border bg-bg-secondary p-4">
                      <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                        <Icon size={13} /> {label}
                      </p>
                      <ul className="space-y-1.5">
                        {lines.map((line, i) => (
                          <li key={i} className="text-xs text-text-primary">{line}</li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ---- Candidate allocation ---- */}
            {plan.bottleneck && plan.candidates.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  Who's competing for {plan.bottleneck.serviceType}
                </p>
                {plan.candidates.map((c, i) => (
                  <motion.div
                    key={c.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i, 8) * 0.02 }}
                    className="rounded-2xl border border-border bg-bg-secondary p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">{c.customerName}</p>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          {c.source === 'waitlist' ? 'On waitlist' : 'Open lead'}
                          {c.zone ? ` · ${c.zone}` : ''}
                          {c.lifecycleStage ? ` · ${c.lifecycleStage}` : ''}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium ${DECISION_COLORS[c.decision]}`}>
                        {DECISION_LABELS[c.decision]}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-text-secondary">{c.reason}</p>
                    <p className="mt-1 text-[11px] text-text-secondary">
                      Value score: {formatCents(c.valueScoreCents)}
                      {c.customerLtvCents > 0 ? ` (incl. ${formatCents(c.customerLtvCents)} lifetime paid)` : ''}
                    </p>
                  </motion.div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
