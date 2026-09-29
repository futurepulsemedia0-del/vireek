import { useMemo } from 'react';
import { Wallet, TrendingDown, Info, Lightbulb, PiggyBank } from 'lucide-react';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { computeHomeBudget, formatBudgetUsd, type BudgetConfidence } from '@/lib/homeBudget';

const CONFIDENCE_COPY: Record<BudgetConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence — add install dates, service history or missing systems to sharpen it',
  low: 'Low confidence — few systems or install dates on record',
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

function Stat({ label, value, range, hint }: { label: string; value: string; range: string; hint: string }) {
  return (
    <div className="flex-1 rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-3xl font-semibold leading-none tabular-nums text-text-primary">{value}</p>
      <p className="mt-2 text-[11px] tabular-nums text-text-secondary">Likely range {range}</p>
      <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>
    </div>
  );
}

export function HomeOperatingBudgetCard({ twin }: { twin: PropertyTwin }) {
  const budget = useMemo(() => computeHomeBudget(twin), [twin]);

  if (!budget) {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <div className="mb-2 flex items-center gap-2">
          <Wallet size={16} className="text-cta" />
          <p className="text-sm font-semibold text-text-primary">Home Operating Budget</p>
        </div>
        <p className="text-sm text-text-secondary">
          Add the HVAC, plumbing, electrical, water heater, roof or safety equipment installed at this property to forecast its annual and 5-year maintenance cost.
        </p>
      </div>
    );
  }

  const peak = Math.max(...budget.years.map((y) => y.total), 1);
  const categoryPeak = Math.max(...budget.categories.map((c) => c.fiveYear), 1);
  const planSaving = budget.fiveYear - budget.withPlan.fiveYear;
  const topRecommendation = budget.recommendations[0];

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-4 flex items-center gap-2">
        <Wallet size={16} className="text-cta" />
        <p className="text-sm font-semibold text-text-primary">Home Operating Budget</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Stat
          label="Expected annual maintenance cost"
          value={formatBudgetUsd(budget.annual)}
          range={`${formatBudgetUsd(budget.annualLow)}–${formatBudgetUsd(budget.annualHigh)}`}
          hint="Scheduled service plus expected repairs and replacements, next 12 months"
        />
        <Stat
          label="Expected 5-year maintenance exposure"
          value={formatBudgetUsd(budget.fiveYear)}
          range={`${formatBudgetUsd(budget.fiveYearLow)}–${formatBudgetUsd(budget.fiveYearHigh)}`}
          hint="Rises as equipment ages toward end of life"
        />
      </div>

      <p className="mt-3 flex items-start gap-1 text-[11px] text-text-secondary">
        <Info size={11} className="mt-0.5 shrink-0" />
        <span>
          {CONFIDENCE_COPY[budget.confidence]} · {budget.scoredEquipmentCount} unit{budget.scoredEquipmentCount === 1 ? '' : 's'} modelled
        </span>
      </p>

      {topRecommendation && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-success-500/30 bg-success-500/10 p-4">
          <TrendingDown size={18} className="mt-0.5 shrink-0 text-success-500" />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-text-primary">
              {topRecommendation.categoryLabel} maintenance this year lowers your expected 5-year cost by about {formatBudgetUsd(topRecommendation.netSaving5y)}.
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">
              Chance of a failure in the next 12 months drops from {percent(topRecommendation.riskBefore)} to {percent(topRecommendation.riskAfter)}, net of the {formatBudgetUsd(topRecommendation.year1Outlay)} service spend.
            </p>
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-xs font-semibold text-text-primary">Projected cost by year</p>
          <ul className="flex h-32 items-end gap-2" aria-label="Projected maintenance cost for each of the next five years">
            {budget.years.map((y) => (
              <li key={y.year} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                <span className="text-[10px] tabular-nums text-text-secondary">{formatBudgetUsd(y.total)}</span>
                <div className="flex w-full flex-1 flex-col justify-end overflow-hidden rounded-md bg-border/40">
                  <div className="w-full bg-warning-500/70" style={{ height: `${(y.expectedFailure / peak) * 100}%` }} title={`Expected repairs & replacements: ${formatBudgetUsd(y.expectedFailure)}`} />
                  <div className="w-full bg-accent/70" style={{ height: `${(y.maintenance / peak) * 100}%` }} title={`Scheduled maintenance: ${formatBudgetUsd(y.maintenance)}`} />
                </div>
                <span className="text-[10px] text-text-secondary">Yr {y.year}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex items-center gap-3 text-[10px] text-text-secondary">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-accent/70" aria-hidden />Maintenance</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-warning-500/70" aria-hidden />Repairs &amp; replacements</span>
          </p>
        </div>

        <div>
          <p className="mb-3 text-xs font-semibold text-text-primary">5-year exposure by system</p>
          <ul className="space-y-2.5">
            {budget.categories.map((c) => (
              <li key={c.key}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium text-text-primary">{c.label}</span>
                  <span className="tabular-nums text-text-secondary">{formatBudgetUsd(c.fiveYear)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={`${c.label} share of 5-year exposure`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((c.fiveYear / categoryPeak) * 100)}>
                  <div className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${(c.fiveYear / categoryPeak) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {budget.drivers.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-3 text-sm font-semibold text-text-primary">What drives this budget</p>
          <ul className="space-y-2">
            {budget.drivers.map((d) => (
              <li key={d.key} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-text-primary">{d.label}</p>
                  <p className="text-xs text-text-secondary">{d.detail}</p>
                </div>
                <span className={`shrink-0 text-xs font-semibold tabular-nums ${d.fiveYearImpact > 0 ? 'text-danger-500' : 'text-success-500'}`}>
                  {d.fiveYearImpact > 0 ? '+' : '−'}{formatBudgetUsd(Math.abs(d.fiveYearImpact))} / 5 yr
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {budget.recommendations.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <div className="mb-3 flex items-center gap-2">
            <Lightbulb size={15} className="text-cta" />
            <p className="text-sm font-semibold text-text-primary">Ways to lower expected cost</p>
          </div>
          <ol className="space-y-2">
            {budget.recommendations.map((r) => (
              <li key={r.categoryKey} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-text-primary">{r.title}</p>
                  <span className="shrink-0 rounded-full bg-success-500/10 px-2.5 py-0.5 text-xs font-medium tabular-nums text-success-500">
                    Saves ~{formatBudgetUsd(r.netSaving5y)} over 5 yr
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {formatBudgetUsd(r.year1Outlay)} service spend avoids about {formatBudgetUsd(r.failureCostAvoided5y)} of expected repairs · failure risk {percent(r.riskBefore)} → {percent(r.riskAfter)} · {r.equipmentIds.length} unit{r.equipmentIds.length === 1 ? '' : 's'}
                </p>
              </li>
            ))}
          </ol>
          {planSaving >= 50 && (
            <p className="mt-3 text-xs text-text-secondary">
              Doing all of the above brings the 5-year exposure from {formatBudgetUsd(budget.fiveYear)} to {formatBudgetUsd(budget.withPlan.fiveYear)}.
            </p>
          )}
        </div>
      )}

      <div className="mt-6 flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-4">
        <PiggyBank size={18} className="mt-0.5 shrink-0 text-cta" />
        <p className="text-sm text-text-secondary">
          Setting aside about <span className="font-semibold tabular-nums text-text-primary">{formatBudgetUsd(budget.suggestedMonthlyReserve)}</span> a month would cover the expected repairs and replacements over the next five years.
        </p>
      </div>

      <details className="mt-4 text-[11px] text-text-secondary">
        <summary className="cursor-pointer font-medium text-text-primary">How this is estimated</summary>
        <div className="mt-2 space-y-1">
          <p>
            Each system is modelled from its age against expected lifespan, then adjusted for climate, property type, repair history, overdue service, open predictive alerts and any active manufacturer warranty. Figures are estimates shown with a likely range, not quotes.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {budget.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
