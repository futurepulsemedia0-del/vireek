// src/components/native/DataSaverCard.tsx — low-data mode switch (Auto / On / Off).

import { useState } from 'react';
import { Gauge } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { getDataSaverPref, setDataSaverPref, type DataSaverPref } from '@/lib/native/dataSaver';
import { isNative } from '@/lib/native/platform';

const OPTIONS: Array<{ value: DataSaverPref; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

export function DataSaverCard() {
  const [pref, setPref] = useState<DataSaverPref>(() => getDataSaverPref());
  if (!isNative()) return null;

  return (
    <Card className="mt-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Gauge className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-primary">Low-data mode</h2>
          <p className="text-xs text-text-secondary">Skips background pre-loading on slow or limited connections. Your jobs and queued work still sync.</p>
        </div>
      </div>
      <div role="radiogroup" aria-label="Low-data mode" className="mt-3 grid grid-cols-3 gap-2">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={pref === o.value}
            onClick={() => {
              setDataSaverPref(o.value);
              setPref(o.value);
            }}
            className={`min-h-[44px] rounded-lg border text-sm font-medium ${pref === o.value ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Card>
  );
}
