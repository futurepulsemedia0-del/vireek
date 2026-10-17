// src/components/native/AppLockCard.tsx — security-settings switch for the app lock.
// Renders nothing on the web or on phones without biometrics / a passcode.

import { useEffect, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/contexts/ToastContext';
import { isAppLockEnabled, isAppLockSupported, setAppLockEnabled } from '@/lib/native/appLock';

export function AppLockCard() {
  const { toast } = useToast();
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await isAppLockSupported();
      const on = ok ? await isAppLockEnabled() : false;
      if (!cancelled) {
        setSupported(ok);
        setEnabled(on);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!supported) return null;

  async function toggle() {
    setBusy(true);
    const next = !enabled;
    const ok = await setAppLockEnabled(next);
    setBusy(false);
    if (ok) setEnabled(next);
    else toast('We could not verify it is you, so app lock was not changed.', 'error');
  }

  return (
    <Card className="mt-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Fingerprint className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text-primary">App lock</h2>
          <p className="text-xs text-text-secondary">
            Ask for Face ID, fingerprint or your device passcode when you open Vireek or come back after a short break.
          </p>
        </div>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void toggle()}>
          {enabled ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </Card>
  );
}
