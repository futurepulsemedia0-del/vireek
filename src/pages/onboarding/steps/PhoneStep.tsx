import { useState } from 'react';
import { Loader as Loader2, Phone } from 'lucide-react';
import { StepShell } from '../StepShell';
import { chipClass, inputClass, type StepProps } from '../types';

const SUGGESTED_AREA_CODES = ['205', '212', '305', '404', '512', '602', '702', '713', '818', '917'];

/** Same simulated search used on the Phone Numbers dashboard page — wire
 * both up to your carrier/provider's real number-search API together. */
function generateCandidates(areaCode: string): string[] {
  return Array.from({ length: 6 }, (_, i) => {
    const line = String(1000 + i * 137 + Math.floor(Math.random() * 90)).slice(0, 4);
    return `+1${areaCode}555${line}`;
  });
}

export function PhoneStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  const [areaCode, setAreaCode] = useState('');
  const [candidates, setCandidates] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);

  const search = (code: string) => {
    setAreaCode(code);
    if (code.length !== 3) {
      setCandidates([]);
      return;
    }
    setSearching(true);
    setTimeout(() => {
      setCandidates(generateCandidates(code));
      setSearching(false);
    }, 500);
  };

  const canProceed = data.phoneChoice !== 'new_number' || !!data.newPhoneNumber;

  return (
    <StepShell
      stepKey="phone"
      icon={Phone}
      title="How should calls reach Sarah?"
      description="Forward your existing number, or reserve a dedicated Vireek line."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      nextDisabled={!canProceed}
      saving={saving}
    >
      <div className="grid gap-3">
        <button
          type="button"
          onClick={() => update({ phoneChoice: 'existing_number' })}
          className={`rounded-xl border p-4 text-left transition-all ${data.phoneChoice === 'existing_number' ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/30'}`}
        >
          <p className="text-sm font-semibold text-text-primary">Forward my existing number</p>
          <p className="mt-1 text-xs text-text-secondary">
            Keep {data.forwardingNumber || data.phone || 'the number from step 1'} and route it to Sarah. No new number needed.
          </p>
        </button>

        <button
          type="button"
          onClick={() => update({ phoneChoice: 'new_number' })}
          className={`rounded-xl border p-4 text-left transition-all ${data.phoneChoice === 'new_number' ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/30'}`}
        >
          <p className="text-sm font-semibold text-text-primary">Get a dedicated Vireek number</p>
          <p className="mt-1 text-xs text-text-secondary">Pick a new local number for Sarah to answer directly.</p>
        </button>

        {data.phoneChoice === 'new_number' && (
          <div className="rounded-xl border border-border bg-bg-primary p-4">
            <label className="mb-1.5 block text-sm font-medium text-text-primary">Line label</label>
            <input
              type="text"
              value={data.newPhoneFriendlyName}
              onChange={(e) => update({ newPhoneFriendlyName: e.target.value })}
              placeholder="e.g. Main Line"
              className={`${inputClass} mb-4`}
            />

            <label className="mb-1.5 block text-sm font-medium text-text-primary">Preferred area code</label>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_AREA_CODES.map((code) => (
                <button key={code} type="button" onClick={() => search(code)} className={chipClass(areaCode === code)}>
                  {code}
                </button>
              ))}
            </div>
            <input
              type="text"
              inputMode="numeric"
              maxLength={3}
              placeholder="Or type a 3-digit area code"
              value={areaCode}
              onChange={(e) => search(e.target.value.replace(/\D/g, '').slice(0, 3))}
              className={`${inputClass} mt-2`}
            />

            {searching && (
              <p className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
                <Loader2 size={14} className="animate-spin" /> Searching available numbers…
              </p>
            )}

            {!searching && candidates.length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {candidates.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => update({ newPhoneNumber: n })}
                    className={chipClass(data.newPhoneNumber === n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => update({ phoneChoice: 'skip' })}
          className={`rounded-xl border p-4 text-left transition-all ${data.phoneChoice === 'skip' ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary hover:border-accent/30'}`}
        >
          <p className="text-sm font-semibold text-text-primary">I'll set this up later</p>
          <p className="mt-1 text-xs text-text-secondary">You can add or port a number any time from Phone Numbers.</p>
        </button>
      </div>
    </StepShell>
  );
}
