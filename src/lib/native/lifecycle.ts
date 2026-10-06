// src/lib/native/lifecycle.ts
// App-level wiring for the installed app: shell styling hooks, the technician start screen,
// and reliable "resume / signal is back" sync triggers (more dependable than DOM events inside WebViews).

import { syncNow } from '../offline/sync';
import { isNative, nativePlatform } from './platform';

/** Call once before React renders. */
export function initNativeRuntime(): void {
  if (!isNative()) return;
  const root = document.documentElement;
  root.classList.add('native-app', `native-${nativePlatform() ?? 'unknown'}`);
  // The installed app is the technician app: open straight on today's jobs.
  if (window.location.pathname === '/') window.history.replaceState(null, '', '/tech/today');
}

/** Registers resume + connectivity listeners while the technician screens are mounted. */
export function startNativeFieldHooks(): () => void {
  if (!isNative()) return () => undefined;

  let cancelled = false;
  const handles: Array<{ remove: () => Promise<void> }> = [];

  void Promise.all([import('@capacitor/app'), import('@capacitor/network')])
    .then(async ([{ App }, { Network }]) => {
      const onState = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void syncNow({ forcePull: true });
      });
      const onNet = await Network.addListener('networkStatusChange', (status) => {
        if (status.connected) void syncNow();
      });
      if (cancelled) {
        void onState.remove();
        void onNet.remove();
        return;
      }
      handles.push(onState, onNet);
    })
    .catch(() => undefined);

  return () => {
    cancelled = true;
    handles.splice(0).forEach((h) => void h.remove().catch(() => undefined));
  };
}
