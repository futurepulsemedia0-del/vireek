import { Input } from '@/components/ui/Input';
import { TagToggleGroup } from '@/components/capacity/TagToggleGroup';
import {
  EQUIPMENT_OPTIONS,
  SKILL_OPTIONS,
  SLA_OPTIONS,
  type JobRequirements,
} from '@/lib/capacityLiquidity';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

/**
 * Optional hard requirements for a smart-matched job. Anything set here is a
 * GATE: members who don't meet it are never offered the job.
 */
export function JobRequirementsFields({
  value,
  onChange,
}: {
  value: JobRequirements;
  onChange: (next: JobRequirements) => void;
}) {
  const set = <K extends keyof JobRequirements>(k: K, v: JobRequirements[K]) => onChange({ ...value, [k]: v });

  return (
    <details className="rounded-xl border border-border p-4">
      <summary className="focus-ring cursor-pointer select-none text-sm font-semibold text-text-primary">
        Matching requirements <span className="font-normal text-text-secondary">— optional, only matching members are offered the job</span>
      </summary>
      <div className="mt-4 space-y-4">
        <TagToggleGroup label="Required skills" options={SKILL_OPTIONS} value={value.skills} onChange={(v) => set('skills', v)} />
        <TagToggleGroup label="Required equipment" options={EQUIPMENT_OPTIONS} value={value.equipment} onChange={(v) => set('equipment', v)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="cx-req-sla" className="mb-1.5 block text-sm font-medium text-text-primary">
              Response SLA (member must respond within)
            </label>
            <select
              id="cx-req-sla"
              value={value.slaMinutes ?? ''}
              onChange={(e) => set('slaMinutes', e.target.value === '' ? null : Number(e.target.value))}
              className={selectClass}
            >
              <option value="">No SLA requirement</option>
              {SLA_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Max hourly rate ($)"
            inputMode="decimal"
            value={value.maxHourlyRate}
            onChange={(e) => set('maxHourlyRate', e.target.value)}
            placeholder="No ceiling"
            helperText="Members who state a higher rate are skipped."
          />
        </div>
        <label className="flex items-center gap-2.5 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={value.requiresInsurance}
            onChange={(e) => set('requiresInsurance', e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          Require valid insurance on file
        </label>
      </div>
    </details>
  );
}
