import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Info, Loader2, PiggyBank, Route } from 'lucide-react';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { useToast } from '@/contexts/ToastContext';
import { formatBudgetUsd } from '@/lib/homeBudget';
import {
  BASIS_LABELS,
  PLAN_HORIZON_YEARS,
  RISK_LABELS,
  computeLifetimeServicePlan,
  formatMonths,
  isValidYearBuilt,
  type PlanConfidence,
  type PlanRisk,
} from '@/lib/lifetimeServicePlan';
import { fetchSiteYearBuilt, saveSiteYearBuilt } from '@/lib/lifetimeServicePlanApi';

const RISK_STYLES: Record<PlanRisk, string> = {
  low: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
};

const CONFIDENCE_COPY: Record<PlanConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence — add install dates and the year built to sharpen it',
  low: 'Low confidence — mostly estimated from limited records',
};

const percent = (value: number) => `${Math.round(value * 100)}%`;

const inputClass =
  'focus-ring w-28 rounded-xl border border-border bg-bg-primary px-3 py-1.5 text-sm tabular-nums text-text-primary placeholder:text-text-secondary/60';

type YearStatus = 'loading' | 'ready' | 'unavailable';

export function LifetimeServicePlanCard({ twin }: { twin: PropertyTwin }) {
  const { toast } = useToast();
  const siteId = twin.site?.id ?? null;

  const [yearBuilt, setYearBuilt] = useState<number | null>(null);
  const [status, setStatus] = useState<YearStatus>('loading');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    setStatus('loading');
    fetchSiteYearBuilt(siteId)
      .then((value) => {
        if (cancelled) return;
        setYearBuilt(value);
        setDraft(value === null ? '' : String(value));
        setStatus('ready');
      })
      .catch(() => {
        // Column not migrated yet or a transient error: the plan still works from equipment alone.
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  const plan = useMemo(() => computeLifetimeServicePlan(twin, yearBuilt), [twin, yearBuilt]);

  const trimmed = draft.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  const draftValid = parsed === null || isValidYearBuilt(parsed);
  const dirty = parsed !== yearBuilt && !(parsed === null && yearBuilt === null);

  const save = useCallback(async () => {
    if (!siteId || !draftValid || saving) return;
    setSaving(true);
    try {
      const saved = await saveSiteYearBuilt(siteId, parsed);
      setYearBuilt(saved);
      setDraft(saved === null ? '' : String(saved));
      toast(saved === null ? 'Year built cleared.' : 'Year built saved — plan updated.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the year built.', 'error');
    } finally {
      setSaving(false);
    }
  }, [siteId, draftValid, saving, parsed, toast]);

  const yearBuiltEditor = (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="lsp-year-built" className="mb-1 block text-xs font-medium text-text-secondary">
          Year built
        </label>
        <input
          id="lsp-year-built"
          type="text"
          inputMode="numeric"
          maxLength={4}
          placeholder="e.g. 2008"
          className={inputClass}
          value={draft}
          disabled={status !== 'ready' || saving}
          aria-invalid={!draftValid}
          aria-describedby="lsp-year-built-hint"
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) void save();
          }}
        />
      </div>
      <button
        type="button"
        onClick={() => void save()}
        disabled={!dirty || !draftValid || saving || status !== 'ready'}
        className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving && <Loader2 size={12} className="animate-spin" />}
        Save
      </button>
      <p id="lsp-year-built-hint" className={`basis-full text-[11px] ${draftValid ? 'text-text-secondary' : 'text-danger-500'}`}>
        {draftValid
          ? status === 'unavailable'
            ? 'Year built is not available yet for this workspace — the plan uses equipment records only.'
            : 'Used to estimate systems with no equipment on record.'
          : 'Enter a four-digit year between 1700 and next year.'}
      </p>
    </div>
  );

  const header = (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-2">
        <Route size={16} className="text-cta" />
        <div>
          <p className="text-sm font-semibold text-text-primary">Lifetime Service Plan</p>
          <p className="text-xs text-text-secondary">
            {plan?.homeAgeYears != null
              ? `${plan.homeAgeYears}-year-old property · ${PLAN_HORIZON_YEARS}-year service roadmap`
              : `${PLAN_HORIZON_YEARS}-year service roadmap`}
          </p>
        </div>
      </div>
      {yearBuiltEditor}
    </div>
  );

  if (!plan) {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        {header}
        <p className="text-sm text-text-secondary">
          Add the year this property was built, or record the HVAC, water heater, plumbing, electrical, roof or safety equipment installed here, and Vireek will build its {PLAN_HORIZON_YEARS}-year service roadmap.
        </p>
      </div>
    );
  }

  const peak = Math.max(...plan.roadmap.map((y) => y.total), 1);
  const yearsWithEvents = plan.roadmap.filter((y) => y.events.length > 0);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      {header}

      <p className="mb-4 flex items-start gap-1 text-[11px] text-text-secondary">
        <Info size={11} className="mt-0.5 shrink-0" />
        <span>
          {CONFIDENCE_COPY[plan.confidence]} · {plan.equipmentBackedCount} system{plan.equipmentBackedCount === 1 ? '' : 's'} from equipment records
          {plan.estimatedCount > 0 ? `, ${plan.estimatedCount} estimated from home age` : ''}
        </span>
      </p>

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {plan.systems.map((s) => (
          <li key={s.categoryKey} className="rounded-xl border border-border bg-bg-primary p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-text-primary">{s.label}</p>
              <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${RISK_STYLES[s.risk]}`}>
                {RISK_LABELS[s.risk]} risk
              </span>
            </div>
            <p className="mt-1 text-sm text-text-primary">{s.headline}</p>
            {s.replacement && s.inspectionInMonths !== null && (
              <p className="mt-0.5 text-xs text-text-secondary">
                Unit on record: replacement {s.replacement.fromYears === 0 ? 'due now' : `in ${s.replacement.fromYears}–${s.replacement.toYears} years`}
              </p>
            )}
            <p className="mt-1 text-xs text-text-secondary">{s.rationale}</p>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
              <span className="tabular-nums">{percent(s.risk5y)} chance of a failure within 5 years</span>
              <span className="rounded bg-border/50 px-1.5 py-0.5">{BASIS_LABELS[s.basis]}</span>
              {s.serviceGainYears >= 0.3 && (
                <span className="text-success-500">Staying on schedule adds ~{s.serviceGainYears.toFixed(1)} yr</span>
              )}
            </p>
          </li>
        ))}
      </ul>

      {plan.nextActions.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <div className="mb-3 flex items-center gap-2">
            <CalendarClock size={15} className="text-cta" />
            <p className="text-sm font-semibold text-text-primary">Next 12 months</p>
          </div>
          <ol className="space-y-2">
            {plan.nextActions.map((a) => (
              <li key={a.title} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-text-primary">{a.title}</p>
                  <span className="shrink-0 rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
                    {a.dueInMonths <= 0 ? 'Due now' : `In ${formatMonths(a.dueInMonths)}`}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-text-secondary">{a.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="mt-6 border-t border-border pt-4">
        <p className="mb-3 text-sm font-semibold text-text-primary">{PLAN_HORIZON_YEARS}-Year Home Service Roadmap</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-bg-primary p-4">
            <p className="text-xs font-medium text-text-secondary">Expected {PLAN_HORIZON_YEARS}-year spend</p>
            <p className="mt-1 text-2xl font-semibold leading-none tabular-nums text-text-primary">{formatBudgetUsd(plan.tenYearTotal)}</p>
            <p className="mt-2 text-[11px] text-text-secondary">Replacements, inspections and routine service, in today’s dollars</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-primary p-4">
            <p className="text-xs font-medium text-text-secondary">Service delivered in year 1</p>
            <p className="mt-1 text-2xl font-semibold leading-none tabular-nums text-text-primary">{formatBudgetUsd(plan.year1ServiceValue)}</p>
            <p className="mt-2 text-[11px] text-text-secondary">Inspections and maintenance a plan would cover</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-primary p-4">
            <p className="text-xs font-medium text-text-secondary">Replacements in the roadmap</p>
            <p className="mt-1 text-2xl font-semibold leading-none tabular-nums text-text-primary">{formatBudgetUsd(plan.tenYearReplacements)}</p>
            <p className="mt-2 text-[11px] text-text-secondary">Scheduled at each system’s median expected timing</p>
          </div>
        </div>

        <ul className="mt-5 flex h-36 items-end gap-1.5" aria-label={`Projected service spend for each of the next ${PLAN_HORIZON_YEARS} years`}>
          {plan.roadmap.map((y) => (
            <li key={y.year} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[10px] tabular-nums text-text-secondary">{formatBudgetUsd(y.total)}</span>
              <div className="flex w-full flex-1 flex-col justify-end overflow-hidden rounded-md bg-border/40">
                <div className="w-full bg-warning-500/70" style={{ height: `${(y.replacements / peak) * 100}%` }} title={`Replacements: ${formatBudgetUsd(y.replacements)}`} />
                <div className="w-full bg-accent/70" style={{ height: `${((y.inspections + y.maintenance) / peak) * 100}%` }} title={`Inspections & maintenance: ${formatBudgetUsd(y.inspections + y.maintenance)}`} />
              </div>
              <span className="text-[10px] text-text-secondary">Yr {y.year}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex items-center gap-3 text-[10px] text-text-secondary">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-accent/70" aria-hidden />Inspections &amp; maintenance</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-warning-500/70" aria-hidden />Replacements</span>
        </p>

        {yearsWithEvents.length > 0 && (
          <details className="mt-4" open>
            <summary className="cursor-pointer text-xs font-semibold text-text-primary">Year-by-year milestones</summary>
            <ol className="mt-3 space-y-2">
              {yearsWithEvents.map((y) => (
                <li key={y.year} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <p className="text-xs font-semibold text-text-primary">
                    Year {y.year} <span className="font-normal text-text-secondary">· {y.calendarYear}</span>
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {y.events.map((e, i) => (
                      <li key={`${e.categoryKey}-${e.kind}-${i}`} className="flex items-start justify-between gap-3 text-xs">
                        <span className="min-w-0 text-text-primary">
                          {e.kind === 'replacement' ? `Replace ${e.label}` : e.label}
                          {e.basis === 'home_age' && <span className="text-text-secondary"> · estimated</span>}
                        </span>
                        <span className="shrink-0 tabular-nums text-text-secondary">{formatBudgetUsd(e.cost)}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>

      <div className="mt-6 flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-4">
        <PiggyBank size={18} className="mt-0.5 shrink-0 text-cta" />
        <p className="text-sm text-text-secondary">
          Setting aside about <span className="font-semibold tabular-nums text-text-primary">{formatBudgetUsd(plan.suggestedMonthlyReserve)}</span> a month would fund every scheduled replacement over the next {PLAN_HORIZON_YEARS} years.
        </p>
      </div>

      <details className="mt-4 text-[11px] text-text-secondary">
        <summary className="cursor-pointer font-medium text-text-primary">How this is estimated</summary>
        <div className="mt-2 space-y-1">
          <p>
            Each system is modelled from its age against expected lifespan, adjusted for climate, property type, repair history, overdue service and open predictive alerts. Systems with nothing on record are estimated from the home’s age and shown with wider timing windows. Figures are planning estimates, not quotes.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {plan.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}
