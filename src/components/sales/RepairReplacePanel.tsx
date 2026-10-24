import { useMemo, useState } from 'react';
import { Info, Scale } from 'lucide-react';
import {
  DEFAULT_HORIZON_YEARS,
  DEFAULT_LIFESPAN_YEARS,
  DEFAULT_REPAIR_EXTENDS_YEARS,
  compareRepairReplace,
  equipmentAgeYears,
  money,
  pickRepairAndReplace,
  type LadderEntry,
  type PresentationEquipment,
} from '@/lib/inHomeSales';

interface Props {
  ladder: LadderEntry[];
  equipment: PresentationEquipment[];
  onChoose: (optionId: string) => void;
}

const VERDICT_COPY = {
  replace: { label: 'Replacing costs less over time', tone: 'bg-success-500/10 text-success-500' },
  repair: { label: 'Repairing costs less over time', tone: 'bg-accent/10 text-accent' },
  close: { label: 'Close call — both make sense', tone: 'bg-warning-500/10 text-warning-500' },
} as const;

/** Repair-vs-replace using only the two quoted prices, the unit's age/lifespan, and one visible assumption. */
export function RepairReplacePanel({ ladder, equipment, onChoose }: Props) {
  const pair = pickRepairAndReplace(ladder);
  const [unitId, setUnitId] = useState(equipment[0]?.id ?? '');
  const unit = equipment.find((e) => e.id === unitId) ?? equipment[0] ?? null;
  const [extendsYears, setExtendsYears] = useState(DEFAULT_REPAIR_EXTENDS_YEARS);
  const [horizon, setHorizon] = useState(DEFAULT_HORIZON_YEARS);
  const [manualAge, setManualAge] = useState('');

  const age = useMemo(() => {
    const known = equipmentAgeYears(unit?.install_date);
    if (known !== null) return known;
    const n = Number(manualAge);
    return manualAge.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  }, [unit?.install_date, manualAge]);
  const lifespan = unit?.expected_lifespan_years ?? DEFAULT_LIFESPAN_YEARS;

  const result = useMemo(
    () =>
      pair
        ? compareRepairReplace({
            repairCents: pair.repair.totalCents,
            replaceCents: pair.replace.totalCents,
            equipmentAgeYears: age,
            expectedLifespanYears: lifespan,
            repairExtendsYears: extendsYears,
            horizonYears: horizon,
          })
        : null,
    [pair, age, lifespan, extendsYears, horizon]
  );

  if (!pair || !result) {
    return (
      <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">
        Add at least two options (a repair and a replacement) to this estimate to compare them.
      </p>
    );
  }
  const verdict = VERDICT_COPY[result.verdict];
  const fieldCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-base text-text-primary';

  return (
    <section aria-label="Repair versus replace" className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Scale size={18} aria-hidden="true" /> Repair vs replace
        </span>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${verdict.tone}`}>{verdict.label}</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {[
          { key: 'repair', title: pair.repair.option.name, entry: pair.repair, perYear: result.repairPerYearCents, life: result.repairLifeYears, horizonCost: result.repairHorizonCents },
          { key: 'replace', title: pair.replace.option.name, entry: pair.replace, perYear: result.replacePerYearCents, life: result.replaceLifeYears, horizonCost: result.replaceHorizonCents },
        ].map((c) => (
          <div key={c.key} className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{c.key === 'repair' ? 'Repair' : 'Replace'}</p>
            <h3 className="mt-1 text-lg font-bold text-text-primary">{c.title}</h3>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-text-secondary">Price today</dt><dd className="font-semibold text-text-primary">{money(c.entry.totalCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-text-secondary">Expected life gained</dt><dd className="font-semibold text-text-primary">{c.life} yrs</dd></div>
              <div className="flex justify-between"><dt className="text-text-secondary">Cost per year of life</dt><dd className="font-semibold text-text-primary">{money(c.perYear)}</dd></div>
              <div className="flex justify-between"><dt className="text-text-secondary">Cost of the next {horizon} yrs of use</dt><dd className="font-semibold text-text-primary">{money(c.horizonCost)}</dd></div>
            </dl>
            <button
              type="button"
              onClick={() => onChoose(c.entry.option.id)}
              className="focus-ring mt-4 w-full rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/50"
            >
              Choose {c.key === 'repair' ? 'repair' : 'replacement'}
            </button>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Info size={16} aria-hidden="true" /> Assumptions (change them live)
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {equipment.length > 1 && (
            <label className="text-sm text-text-secondary">
              Equipment
              <select className={`${fieldCls} mt-1`} value={unit?.id ?? ''} onChange={(e) => setUnitId(e.target.value)}>
                {equipment.map((e) => (
                  <option key={e.id} value={e.id}>{[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type}</option>
                ))}
              </select>
            </label>
          )}
          <label className="text-sm text-text-secondary">
            Equipment age (years){unit?.install_date ? ' — from install date' : ''}
            <input
              className={`${fieldCls} mt-1`}
              inputMode="decimal"
              disabled={Boolean(unit?.install_date)}
              value={unit?.install_date ? String(age ?? '') : manualAge}
              onChange={(e) => setManualAge(e.target.value)}
              placeholder="Unknown"
            />
          </label>
          <label className="text-sm text-text-secondary">
            Repair buys (years)
            <input className={`${fieldCls} mt-1`} type="number" min={0.5} max={10} step={0.5} value={extendsYears} onChange={(e) => setExtendsYears(Number(e.target.value) || DEFAULT_REPAIR_EXTENDS_YEARS)} />
          </label>
          <label className="text-sm text-text-secondary">
            Compare over
            <select className={`${fieldCls} mt-1`} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {[5, 10, 15].map((y) => <option key={y} value={y}>{y} years</option>)}
            </select>
          </label>
        </div>
        <p className="mt-3 text-xs text-text-secondary">
          New equipment is assumed to last {lifespan} years. Costs are the price spread over the years of use, so the
          comparison does not double-count a replacement you would buy either way.
        </p>
      </div>
    </section>
  );
}
