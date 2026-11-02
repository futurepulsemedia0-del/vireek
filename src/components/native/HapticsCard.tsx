// src/components/native/HapticsCard.tsx — settings switch for tactile feedback (installed app only).

import { useState } from 'react';
import { Vibrate } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { haptic, isHapticsEnabled, setHapticsEnabled } from '@/lib/native/haptics';
import { isNative } from '@/lib/native/platform';

export function HapticsCard() {
  const [enabled, setEnabled] = useState(() => isHapticsEnabled());
  if (!isNative()) return null;

  function toggle() {
    const next = !enabled;
    setHapticsEnabled(next);
    setEnabled(next);
    if (next) void haptic('success');
  }

  return (
    <Card className="mt-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Vibrate className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-primary">Haptic feedback</h2>
          <p className="text-xs text-text-secondary">Subtle vibrations for swipes, confirmations and alerts. Turned off automatically when Reduce Motion is on.</p>
        </div>
        <Button variant="secondary" size="sm" aria-pressed={enabled} onClick={toggle}>
          {enabled ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </Card>
  );
}
