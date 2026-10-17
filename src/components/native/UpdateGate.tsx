// src/components/native/UpdateGate.tsx
// "Update required" full-screen block (below the minimum version) and a dismissible
// "update available" banner. Fails open: no network / no policy never blocks the technician.
// Web / PWA: renders nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { dismissVersion, evaluatePolicy, loadPolicy, readCachedPolicy, readDismissedVersion, type UpdateState } from '@/lib/native/appUpdate';
import { isNative, nativePlatform } from '@/lib/native/platform';

const REFRESH_EVERY_MS = 10 * 60_000;
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.vireek.field';

export function UpdateGate() {
  const [state, setState] = useState<UpdateState>({ kind: 'none' });
  const version = useRef<string | null>(null);
  const lastCheck = useRef(0);

  const refresh = useCallback(async (useNetwork: boolean) => {
    const platform = nativePlatform();
    if (!isNative() || !platform) return;
    if (!version.current) {
      try {
        version.current = (await (await import('@capacitor/app')).App.getInfo()).version;
      } catch {
        return;
      }
    }
    if (useNetwork) lastCheck.current = Date.now();
    const policy = useNetwork ? await loadPolicy(platform) : readCachedPolicy();
    setState(evaluatePolicy(version.current, policy, readDismissedVersion()));
  }, []);

  useEffect(() => {
    if (!isNative()) return undefined;
    void refresh(false); // cached policy first: a required update holds even offline
    void refresh(true);
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | null = null;
    void import('@capacitor/app')
      .then(async ({ App }) => {
        const h = await App.addListener('appStateChange', ({ isActive }) => {
          if (isActive && Date.now() - lastCheck.current > REFRESH_EVERY_MS) void refresh(true);
        });
        if (cancelled) void h.remove();
        else handle = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void handle?.remove().catch(() => undefined);
    };
  }, [refresh]);

  if (state.kind === 'none') return null;

  const url = state.storeUrl ?? (nativePlatform() === 'android' ? PLAY_URL : null);
  // The Capacitor WebView hands external https links to the OS, which opens the store app.
  const openStore = () => {
    if (url) window.open(url, '_blank');
  };

  if (state.kind === 'force') {
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="update-required-title"
        className="fixed inset-0 z-[310] flex flex-col items-center justify-center gap-5 bg-bg-primary p-8 text-center"
      >
        <Download className="h-10 w-10 text-accent" aria-hidden="true" />
        <div>
          <h1 id="update-required-title" className="text-lg font-semibold text-text-primary">
            Update required
          </h1>
          <p className="mt-1 max-w-xs text-sm text-text-secondary">
            {state.message ?? `This version of Vireek is no longer supported. Please update to version ${state.latest} to continue.`}
          </p>
        </div>
        {url && <Button onClick={openStore}>Update now</Button>}
      </div>
    );
  }

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-[90] flex items-center gap-3 rounded-2xl border border-border bg-bg-secondary p-4 shadow-card-hover"
    >
      <Download className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-text-primary">{state.message ?? `Vireek ${state.latest} is available.`}</p>
      {url && (
        <Button size="sm" onClick={openStore}>
          Update
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          dismissVersion(state.latest);
          setState({ kind: 'none' });
        }}
      >
        Later
      </Button>
    </div>
  );
}
