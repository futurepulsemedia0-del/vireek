import { Wrench } from 'lucide-react';
import { StepShell } from '../StepShell';
import {
  chipClass,
  inputClass,
  INDUSTRY_OPTIONS,
  TEAM_SIZE_OPTIONS,
  CALL_HANDLING_OPTIONS,
  SCHEDULING_TOOL_OPTIONS,
  EMERGENCY_HANDLING_OPTIONS,
  type StepProps,
} from '../types';

export function OperationsStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  return (
    <StepShell
      stepKey="operations"
      icon={Wrench}
      title="A bit about how you run things"
      description="This tunes Sarah's dispatch logic and sharpens your revenue numbers. All optional."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      saving={saving}
    >
      <div className="grid gap-5">
        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Primary industry</label>
          <div className="flex flex-wrap gap-2">
            {INDUSTRY_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => update({ primaryIndustry: opt.value })} className={chipClass(data.primaryIndustry === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Team size</label>
          <div className="flex flex-wrap gap-2">
            {TEAM_SIZE_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => update({ teamSize: opt.value })} className={chipClass(data.teamSize === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">How are calls handled today?</label>
          <div className="flex flex-wrap gap-2">
            {CALL_HANDLING_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => update({ currentCallHandling: opt.value })} className={chipClass(data.currentCallHandling === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Scheduling / CRM tool you use</label>
          <div className="flex flex-wrap gap-2">
            {SCHEDULING_TOOL_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => update({ schedulingTool: opt.value })} className={chipClass(data.schedulingTool === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-primary">Average job value ($)</label>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            placeholder="e.g. 350"
            value={data.avgJobValue}
            onChange={(e) => update({ avgJobValue: e.target.value })}
            className={inputClass}
          />
          <p className="mt-1.5 text-xs text-text-secondary">Helps us show accurate revenue-recovered numbers on your dashboard from day one.</p>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Do you take emergency / after-hours calls?</label>
          <div className="flex flex-wrap gap-2">
            {EMERGENCY_HANDLING_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => update({ handlesEmergencyCalls: opt.value })} className={chipClass(data.handlesEmergencyCalls === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </StepShell>
  );
}
