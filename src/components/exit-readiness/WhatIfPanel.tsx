import { RotateCcw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { fmtMoney, type Evaluation, type ExitMetrics, type Scenario } from '@/lib/exitReadiness';
import { EstimateBanner } from './shared';

interface Props {
  base: Evaluation;
  result: Evaluation;
  metrics: ExitMetrics;
  baseDataQuality: number | null;
  baseOwnerHours: number | null;
  scenario: Scenario;
  onChange: (s: Scenario) => void;
}

interface SliderDef {
  key: keyof Scenario;
  label: string;
  min: number;
  max: number;
  step: number;
  current: number | null;
  format: (n: number) => string;
}

function Slider({ def, value, onChange }: { def: SliderDef; value: number | undefined; onChange: (n: number | undefined) => void }) {
  const shown = value ?? def.current ?? def.min;
  const id = `wi-${def.key}`;
  const disabled = def.current === null && def.key !== 'revenueGrowth' && def.key !== 'marginPoints';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-text-primary">{def.label}</label>
        <span className="text-sm text-text-primary">
          {def.format(shown)}
          {value !== undefined && def.current !== null && <span className="ml-1 text-[11px] text-text-secondary">(now {def.format(def.current)})</span>}
        </span>
      </div>
      <input id={id} type="range" className="mt-1 w-full accent-[var(--color-accent,currentColor)]" min={def.min} max={def.max} step={def.step} value={shown} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} />
      {disabled && <p className="text-[11px] text-text-secondary">No data yet for this driver.</p>}
    </div>
  );
}

export function WhatIfPanel({ base, result, metrics, baseDataQuality, baseOwnerHours, scenario, onChange }: Props) {
  const set = (key: keyof Scenario) => (n: number | undefined) => onChange({ ...scenario, [key]: n });
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const defs: SliderDef[] = [
    { key: 'revenueGrowth', label: 'Revenue growth', min: 0, max: 0.5, step: 0.01, current: 0, format: pct },
    { key: 'marginPoints', label: 'Margin improvement (points of revenue)', min: 0, max: 10, step: 0.5, current: 0, format: (n) => `+${n} pts` },
    { key: 'recurringShare', label: 'Recurring revenue share', min: 0, max: 0.6, step: 0.01, current: metrics.recurringShare, format: pct },
    { key: 'top1', label: 'Largest customer share', min: 0, max: 0.6, step: 0.01, current: metrics.concentration.top1, format: pct },
    { key: 'ownerRevenueShare', label: 'Revenue through owner / unassigned', min: 0, max: 1, step: 0.01, current: metrics.ownerDependence.revenueShare, format: pct },
    { key: 'ownerWeeklyHours', label: 'Owner weekly hours in operations', min: 0, max: 80, step: 1, current: baseOwnerHours, format: (n) => `${n} h` },
    { key: 'dso', label: 'Days sales outstanding', min: 10, max: 120, step: 1, current: metrics.dso === null ? null : Math.round(metrics.dso), format: (n) => `${n} days` },
    { key: 'turnoverRate', label: 'Technician turnover', min: 0, max: 0.6, step: 0.01, current: metrics.workforce.turnoverRate, format: pct },
    { key: 'documentsPublished', label: 'Published SOPs', min: 0, max: 30, step: 1, current: metrics.documentation.published, format: (n) => String(n) },
    { key: 'credentialsValidPct', label: 'Licences currently valid', min: 0, max: 1, step: 0.05, current: metrics.compliance.credentialsTotal > 0 ? metrics.compliance.credentialsValid / metrics.compliance.credentialsTotal : null, format: pct },
    { key: 'dataQuality', label: 'Data quality score', min: 0, max: 100, step: 1, current: baseDataQuality === null ? null : Math.round(baseDataQuality), format: (n) => String(n) },
  ];
  const dirty = Object.values(scenario).some((v) => v !== undefined);
  const delta = result.valuation.pointCents - base.valuation.pointCents;
  const scoreDelta = (result.readiness.score ?? 0) - (base.readiness.score ?? 0);
  const noEstimate = base.valuation.reason !== null || result.valuation.reason !== null;

  return (
    <div className="space-y-6">
      <EstimateBanner compact />
      <Card>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div><p className="text-xs text-text-secondary">Estimate today</p><p className="text-xl font-bold text-text-primary">{noEstimate ? '—' : fmtMoney(base.valuation.pointCents)}</p></div>
          <div><p className="text-xs text-text-secondary">Estimate in this scenario</p><p className="text-xl font-bold text-text-primary">{noEstimate ? '—' : fmtMoney(result.valuation.pointCents)}</p></div>
          <div>
            <p className="text-xs text-text-secondary">Change</p>
            <p className={`text-xl font-bold ${delta >= 0 ? 'text-success-500' : 'text-danger'}`} aria-live="polite">{noEstimate ? '—' : `${delta >= 0 ? '+' : '−'}${fmtMoney(Math.abs(delta))}`}</p>
            <p className="text-[11px] text-text-secondary">Readiness {base.readiness.score ?? '—'} → {result.readiness.score ?? '—'} ({scoreDelta >= 0 ? '+' : ''}{Math.round(scoreDelta * 10) / 10} pts) · range {noEstimate ? '—' : `${fmtMoney(result.valuation.lowCents)} to ${fmtMoney(result.valuation.highCents)}`}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-text-secondary">Value moves for two reasons: higher earnings (growth, margin) and a higher sell-readiness score, which places the estimate higher inside your multiple range.</p>
      </Card>
      <Card>
        <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
          {defs.map((d) => <Slider key={d.key} def={d} value={scenario[d.key]} onChange={set(d.key)} />)}
        </div>
        <div className="mt-5">
          <Button variant="secondary" size="sm" disabled={!dirty} onClick={() => onChange({})}><RotateCcw size={14} aria-hidden="true" /> Reset to today</Button>
        </div>
      </Card>
    </div>
  );
}
