// src/components/native/AppLockGate.tsx
// Covers the app with a lock screen on cold start and after 30 s in the background when the
// technician turned on app lock, and hides the content in the OS app switcher.
// Web / PWA: renders the children untouched.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { authenticateUser, isAppLockEnabled, shouldRelock } from '@/lib/native/appLock';
import { isNative } from '@/lib/native/platform';

export function AppLockGate({ children }: { children: ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const [locked, setLocked] = useState(isNative());
  const [covered, setCovered] = useState(false);
  const backgroundedAt = useRef<number | null>(null);
  const busy = useRef(false);
  const decided = useRef(false);
  const signedIn = useRef(false);
  signedIn.current = Boolean(user);

  const tryUnlock = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (await authenticateUser('Unlock Vireek')) setLocked(false);
    } finally {
      busy.current = false;
    }
  }, []);

  // Cold start: decide once the session is known.
  useEffect(() => {
    if (!isNative() || loading || decided.current) return;
    decided.current = true;
    void (async () => {
      if (user && (await isAppLockEnabled())) void tryUnlock();
      else setLocked(false);
    })();
  }, [loading, user, tryUnlock]);

  // Background / resume.
  useEffect(() => {
    if (!isNative()) return undefined;
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | null = null;
    void import('@capacitor/app')
      .then(async ({ App }) => {
        const h = await App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) {
            backgroundedAt.current = Date.now();
            setCovered(true);
            return;
          }
          const since = backgroundedAt.current;
          backgroundedAt.current = null;
          setCovered(false);
          if (!shouldRelock(since, Date.now()) || !signedIn.current) return;
          void isAppLockEnabled().then((on) => {
            if (!on) return;
            setLocked(true);
            void tryUnlock();
          });
        });
        if (cancelled) void h.remove();
        else handle = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void handle?.remove().catch(() => undefined);
    };
  }, [tryUnlock]);

  return (
    <>
      {children}
      {(locked || covered) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Vireek is locked"
          className="fixed inset-0 z-[300] flex flex-col items-center justify-center gap-5 bg-bg-primary p-8 text-center"
        >
          <Lock className="h-10 w-10 text-accent" aria-hidden="true" />
          {locked && (
            <>
              <div>
                <h1 className="text-lg font-semibold text-text-primary">Vireek is locked</h1>
                <p className="mt-1 text-sm text-text-secondary">Unlock with biometrics or your device passcode.</p>
              </div>
              <div className="flex w-full max-w-xs flex-col gap-3">
                <Button onClick={() => void tryUnlock()}>Unlock</Button>
                <Button variant="ghost" onClick={() => void signOut()}>
                  Sign out
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
