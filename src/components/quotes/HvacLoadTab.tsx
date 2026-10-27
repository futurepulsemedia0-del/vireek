import { ashrae622Cfm, formatBtuh, type HvacLoadInputs, type LoadFieldErrors, type LoadResult } from '@/lib/hvacSizing';
import { Button } from '@/components/ui/Button';
import { CheckField, FieldGrid, Group, NumField, SelectField, StatTile, WarningList } from '@/components/quotes/HvacFields';

type NumericKey = {
  [K in keyof HvacLoadInputs]: HvacLoadInputs[K] extends number ? K : never;
}[keyof HvacLoadInputs];

interface Props {
  inputs: HvacLoadInputs;
  errors: LoadFieldErrors;
  result: LoadResult | null;
  onChange: (next: HvacLoadInputs) => void;
}

export function HvacLoadTab({ inputs, errors, result, onChange }: Props) {
  const setNum = (key: NumericKey) => (v: number | null) => onChange({ ...inputs, [key]: v ?? Number.NaN });
  const setWin = (key: 'n' | 'e' | 's' | 'w') => (v: number | null) =>
    onChange({ ...inputs, windowAreaSqft: { ...inputs.windowAreaSqft, [key]: v ?? Number.NaN } });
  const err = (key: string) => errors[key];

  return (
    <div className="space-y-6">
      <Group title="Design conditions" hint="Use the local ACCA / ASHRAE design temperatures for the job site (about the 1% cooling and 99% heating values).">
        <FieldGrid>
          <NumField label="Summer outdoor (°F)" value={inputs.outdoorSummerDb} onChange={setNum('outdoorSummerDb')} error={err('outdoorSummerDb')} />
          <NumField label="Summer indoor (°F)" value={inputs.indoorSummerDb} onChange={setNum('indoorSummerDb')} error={err('indoorSummerDb')} />
          <NumField label="Winter outdoor (°F)" value={inputs.outdoorWinterDb} onChange={setNum('outdoorWinterDb')} error={err('outdoorWinterDb')} />
          <NumField label="Winter indoor (°F)" value={inputs.indoorWinterDb} onChange={setNum('indoorWinterDb')} error={err('indoorWinterDb')} />
          <SelectField
            label="Summer humidity"
            value={inputs.humidity}
            onChange={(v) => onChange({ ...inputs, humidity: v })}
            options={[
              { value: 'dry', label: 'Dry (desert, mountain)' },
              { value: 'moderate', label: 'Moderate' },
              { value: 'humid', label: 'Humid (Gulf, Southeast)' },
            ]}
          />
          <NumField label="Elevation (ft)" value={inputs.elevationFt} onChange={setNum('elevationFt')} error={err('elevationFt')} />
        </FieldGrid>
      </Group>

      <Group title="Building">
        <FieldGrid>
          <NumField label="Conditioned area (ft²)" value={inputs.conditionedAreaSqft} onChange={setNum('conditionedAreaSqft')} error={err('conditionedAreaSqft')} />
          <NumField label="Ceiling height (ft)" value={inputs.ceilingHeightFt} onChange={setNum('ceilingHeightFt')} error={err('ceilingHeightFt')} />
          <SelectField
            label="Stories"
            value={String(inputs.stories) as '1' | '2' | '3'}
            onChange={(v) => onChange({ ...inputs, stories: Number(v) as 1 | 2 | 3 })}
            options={[
              { value: '1', label: '1 story' },
              { value: '2', label: '2 stories' },
              { value: '3', label: '3 stories' },
            ]}
          />
          <NumField label="Footprint shape (long ÷ short side)" value={inputs.aspectRatio} onChange={setNum('aspectRatio')} error={err('aspectRatio')} helper="1 = square, 1.5 = typical" />
          <NumField
            label="Exterior wall area, if known (ft²)"
            value={inputs.exteriorWallAreaOverrideSqft}
            nullable
            onChange={(v) => onChange({ ...inputs, exteriorWallAreaOverrideSqft: v })}
            error={err('exteriorWallAreaOverrideSqft')}
            helper="Leave blank to estimate it"
          />
        </FieldGrid>
      </Group>

      <Group title="Insulation and construction">
        <FieldGrid>
          <NumField label="Wall R-value" value={inputs.wallR} onChange={setNum('wallR')} error={err('wallR')} helper="Whole-wall, not just the cavity" />
          <NumField label="Ceiling / roof R-value" value={inputs.ceilingR} onChange={setNum('ceilingR')} error={err('ceilingR')} />
          <NumField label="Floor R-value" value={inputs.floorR} onChange={setNum('floorR')} error={err('floorR')} />
          <SelectField
            label="Ceiling type"
            value={inputs.ceilingType}
            onChange={(v) => onChange({ ...inputs, ceilingType: v })}
            options={[
              { value: 'attic', label: 'Vented attic above' },
              { value: 'cathedral', label: 'Cathedral / vaulted' },
              { value: 'conditioned_above', label: 'Conditioned space above' },
            ]}
          />
          <SelectField
            label="Floor type"
            value={inputs.floorType}
            onChange={(v) => onChange({ ...inputs, floorType: v })}
            options={[
              { value: 'slab', label: 'Slab on grade' },
              { value: 'crawlspace', label: 'Over crawlspace' },
              { value: 'basement', label: 'Over unconditioned basement' },
              { value: 'over_garage', label: 'Over garage' },
              { value: 'conditioned_below', label: 'Conditioned space below' },
            ]}
          />
          <SelectField
            label="Exterior color"
            value={inputs.exteriorColor}
            onChange={(v) => onChange({ ...inputs, exteriorColor: v })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'medium', label: 'Medium' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </FieldGrid>
        {inputs.floorType === 'slab' ? (
          <CheckField label="Slab edge is insulated" checked={inputs.slabEdgeInsulated} onChange={(v) => onChange({ ...inputs, slabEdgeInsulated: v })} />
        ) : null}
      </Group>

      <Group title="Windows and doors">
        <FieldGrid>
          <NumField label="North windows (ft²)" value={inputs.windowAreaSqft.n} onChange={setWin('n')} error={err('windowArea_n')} />
          <NumField label="East windows (ft²)" value={inputs.windowAreaSqft.e} onChange={setWin('e')} error={err('windowArea_e')} />
          <NumField label="South windows (ft²)" value={inputs.windowAreaSqft.s} onChange={setWin('s')} error={err('windowArea_s')} />
          <NumField label="West windows (ft²)" value={inputs.windowAreaSqft.w} onChange={setWin('w')} error={err('windowArea_w')} />
          <NumField label="Window U-factor" value={inputs.windowU} onChange={setNum('windowU')} error={err('windowU')} helper="Single pane about 1.0, low-e double about 0.30" />
          <NumField label="Window SHGC" value={inputs.windowShgc} onChange={setNum('windowShgc')} error={err('windowShgc')} helper="Solar heat gain coefficient" />
          <SelectField
            label="Window shading"
            value={inputs.windowShading}
            onChange={(v) => onChange({ ...inputs, windowShading: v })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'blinds', label: 'Blinds' },
              { value: 'drapes', label: 'Drapes' },
              { value: 'exterior', label: 'Exterior shade / awnings' },
            ]}
          />
          <NumField label="Door area (ft²)" value={inputs.doorAreaSqft} onChange={setNum('doorAreaSqft')} error={err('doorAreaSqft')} />
        </FieldGrid>
      </Group>

      <Group title="Air leakage, ventilation and internal gains">
        <FieldGrid>
          <SelectField
            label="Air tightness"
            value={inputs.airTightness}
            onChange={(v) => onChange({ ...inputs, airTightness: v })}
            options={[
              { value: 'tight', label: 'Tight (new, tested)' },
              { value: 'average', label: 'Average' },
              { value: 'loose', label: 'Loose (older home)' },
            ]}
          />
          <NumField label="Mechanical ventilation (cfm)" value={inputs.ventilationCfm} onChange={setNum('ventilationCfm')} error={err('ventilationCfm')} />
          <SelectField
            label="Ventilation heat recovery"
            value={inputs.ventilationRecovery}
            onChange={(v) => onChange({ ...inputs, ventilationRecovery: v })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'hrv', label: 'HRV' },
              { value: 'erv', label: 'ERV' },
            ]}
          />
          <NumField label="Occupants" value={inputs.occupants} onChange={setNum('occupants')} error={err('occupants')} />
          <NumField label="Appliance gains (Btu/h)" value={inputs.applianceSensibleBtuh} onChange={setNum('applianceSensibleBtuh')} error={err('applianceSensibleBtuh')} helper="1,200 covers a typical kitchen" />
          <SelectField
            label="Duct location"
            value={inputs.ductLocation}
            onChange={(v) => onChange({ ...inputs, ductLocation: v })}
            options={[
              { value: 'conditioned', label: 'Inside conditioned space' },
              { value: 'basement', label: 'Unconditioned basement' },
              { value: 'crawlspace', label: 'Crawlspace' },
              { value: 'attic', label: 'Attic (sealed, R-6)' },
              { value: 'attic_leaky', label: 'Attic (leaky or poorly insulated)' },
            ]}
          />
        </FieldGrid>
        <Button
          size="sm"
          variant="secondary"
          type="button"
          onClick={() => {
            const cfm = ashrae622Cfm(inputs.conditionedAreaSqft, 3);
            if (cfm > 0) onChange({ ...inputs, ventilationCfm: cfm });
          }}
        >
          Fill ventilation from ASHRAE 62.2 (3 bedrooms)
        </Button>
      </Group>

      <LoadResultView result={result} hasErrors={Object.keys(errors).length > 0} />
    </div>
  );
}

function LoadResultView({ result, hasErrors }: { result: LoadResult | null; hasErrors: boolean }) {
  if (!result) {
    return (
      <div role="status" className="rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">
        {hasErrors ? 'Fix the highlighted fields to see the load.' : 'Enter the building details to see the load.'}
      </div>
    );
  }
  return (
    <section aria-label="Load results" className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total cooling load" value={formatBtuh(result.cooling.totalBtuh)} hint={`${result.cooling.tons.toFixed(1)} tons`} />
        <StatTile label="Heating load" value={formatBtuh(result.heating.totalBtuh)} hint={`${result.metrics.heatingBtuhPerSqft} Btu/h per ft²`} />
        <StatTile label="Sensible / latent" value={`${result.cooling.sensibleBtuh.toLocaleString('en-US')} / ${result.cooling.latentBtuh.toLocaleString('en-US')}`} hint={`Sensible heat ratio ${result.cooling.sensibleHeatRatio.toFixed(2)}`} />
        <StatTile label="Area per ton" value={`${result.metrics.coolingSqftPerTon.toLocaleString('en-US')} ft²`} hint="Sanity check only" />
      </div>
      <WarningList items={result.warnings} />
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="sr-only">Load breakdown by component</caption>
          <thead className="bg-bg-tertiary text-left text-xs text-text-secondary">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Component</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Cooling (Btu/h)</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Heating (Btu/h)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {result.rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="px-3 py-2 text-left font-normal text-text-primary">{r.label}</th>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">{r.coolingBtuh.toLocaleString('en-US')}</td>
                <td className="px-3 py-2 text-right tabular-nums text-text-primary">{r.heatingBtuh.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-secondary">
        Estimate based on Manual J heat-transfer methods with simplified solar and infiltration tables. It is not an
        ACCA-approved Manual J report. Where a permit requires one, run approved software and use this for the quote.
      </p>
    </section>
  );
}
