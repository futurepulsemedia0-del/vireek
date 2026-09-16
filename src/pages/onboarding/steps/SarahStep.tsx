import { Sparkles } from 'lucide-react';
import { StepShell } from '../StepShell';
import { chipClass, inputClass, ASSISTANT_VOICE_OPTIONS, ASSISTANT_TONE_OPTIONS, type StepProps } from '../types';

export function SarahStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  const defaultGreeting = `Thanks for calling ${data.companyName || 'us'}, this is ${data.assistantName || 'Sarah'} — how can I help?`;

  return (
    <StepShell
      stepKey="sarah"
      icon={Sparkles}
      title="Meet your AI receptionist"
      description="Name her, pick a voice and tone, and write the first thing callers hear."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      saving={saving}
    >
      <div className="grid gap-5">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-primary">Assistant name</label>
          <input
            type="text"
            value={data.assistantName}
            onChange={(e) => update({ assistantName: e.target.value })}
            placeholder="Sarah"
            className={inputClass}
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Voice</label>
          <div className="flex flex-wrap gap-2">
            {ASSISTANT_VOICE_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => update({ assistantVoice: opt.value })} className={chipClass(data.assistantVoice === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Tone</label>
          <div className="flex flex-wrap gap-2">
            {ASSISTANT_TONE_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => update({ assistantTone: opt.value })} className={chipClass(data.assistantTone === opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-text-primary">Greeting script</label>
          <textarea
            rows={3}
            value={data.greetingScript}
            onChange={(e) => update({ greetingScript: e.target.value })}
            placeholder={defaultGreeting}
            className={`${inputClass} resize-none`}
          />
          <p className="mt-1.5 text-xs text-text-secondary">Leave blank and we'll use: "{defaultGreeting}"</p>
        </div>
      </div>
    </StepShell>
  );
}
