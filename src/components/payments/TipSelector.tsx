import { useState } from 'react';
import { computeTip, dollarsToCents, formatUsd, type TipSelection } from '@/lib/tipping';

interface TipSelectorProps {
  baseCents: number;
  presets: readonly number[];
  value: TipSelection;
  onChange: (value: TipSelection) => void;
  disabled?: boolean;
  technicianName?: string | null;
}

export function TipSelector({ baseCents, presets, value, onChange, disabled, technicianName }: TipSelectorProps) {
  const [customText, setCustomText] = useState('');
  const customInvalid = value.kind === 'custom' && !computeTip(baseCents, value).ok;

  const optionClass = (selected: boolean) =>
    `focus-ring rounded-xl border px-2 py-3 text-center text-sm font-semibold transition disabled:opacity-50 ${
      selected ? 'border-accent bg-accent/10 text-text-primary' : 'border-border-primary bg-bg-primary text-text-secondary hover:border-accent/50'
    }`;

  function choose(next: TipSelection) {
    setCustomText('');
    onChange(next);
  }

  function handleCustom(text: string) {
    setCustomText(text);
    if (text.trim() === '') return onChange({ kind: 'none' });
    const cents = dollarsToCents(text);
    onChange({ kind: 'custom', cents: cents ?? Number.NaN });
  }

  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-text-primary">
        {technicianName ? `Add a tip for ${technicianName}` : 'Add a tip for your technician'}
      </p>
      <div role="radiogroup" aria-label="Tip amount" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        <button type="button" role="radio" aria-checked={value.kind === 'none'} disabled={disabled} onClick={() => choose({ kind: 'none' })} className={optionClass(value.kind === 'none')}>
          No tip
        </button>
        {presets.map((percent) => {
          const selected = value.kind === 'percent' && value.percent === percent;
          const r = computeTip(baseCents, { kind: 'percent', percent });
          return (
            <button key={percent} type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={() => choose({ kind: 'percent', percent })} className={optionClass(selected)}>
              <span className="block">{percent}%</span>
              <span className="block text-xs font-normal opacity-70">{r.ok ? formatUsd(r.tipCents) : ''}</span>
            </button>
          );
        })}
      </div>
      <label className="mt-3 block text-xs text-text-secondary">
        Custom amount
        <div className={`mt-1 flex items-center rounded-xl border px-3 ${customInvalid ? 'border-danger' : 'border-border-primary'} bg-bg-primary`}>
          <span className="text-text-secondary">$</span>
          <input
            aria-label="Custom tip amount in dollars"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            disabled={disabled}
            value={customText}
            onChange={(e) => handleCustom(e.target.value)}
            className="w-full bg-transparent px-2 py-2.5 text-sm text-text-primary outline-none"
          />
        </div>
      </label>
      {customInvalid && <p role="alert" className="mt-1 text-xs text-danger">Enter a valid amount (for example 7.50).</p>}
    </div>
  );
}
