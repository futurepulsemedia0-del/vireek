// Recreated: verify against original intent
import { Briefcase } from 'lucide-react';
import { StepShell } from '../StepShell';
import { chipClass, type StepProps } from '../types';
import { getPack, listPacks, normalizeVerticalId } from '@/lib/voicePlatform';

/** Optional "what kind of business is this?" step. A regulated pack also needs an explicit acknowledgement. */
export function VerticalStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  const packs = listPacks();
  const selectedId = normalizeVerticalId(data.verticalId);
  const selected = getPack(selectedId);
  const needsAck = !!selected?.regulated;

  return (
    <StepShell
      stepKey="vertical"
      icon={Briefcase}
      title="What kind of business is this?"
      description="This sets the assistant up for your industry. You can change it later."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      saving={saving}
      nextDisabled={needsAck && !data.verticalComplianceAck}
    >
      <div className="grid gap-4">
        <div role="radiogroup" aria-label="Industry" className="flex flex-wrap gap-2">
          {packs.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selectedId === p.id}
              // Switching pack clears any earlier acknowledgement: it belongs to the pack it was given for.
              onClick={() => update({ verticalId: p.id, verticalComplianceAck: p.id === selectedId ? data.verticalComplianceAck : false })}
              className={chipClass(selectedId === p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {selected && <p className="text-sm text-text-secondary">{selected.description}</p>}

        {needsAck && selected && (
          <label className="flex items-start gap-2 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary">
            <input type="checkbox" className="mt-1" checked={data.verticalComplianceAck} onChange={(e) => update({ verticalComplianceAck: e.target.checked })} />
            <span>
              {selected.complianceNotice ?? 'I understand this industry has additional rules and I am responsible for how the assistant is used.'}
            </span>
          </label>
        )}
      </div>
    </StepShell>
  );
}
