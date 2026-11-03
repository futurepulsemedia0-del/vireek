// src/lib/native/surfaces.ts — bridge to the native "VireekSurfaces" plugin (widgets snapshot, Live Activity tokens,
// pending deep links from Siri / App Intents). Everything is a safe no-op on the web and when the plugin is missing.

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { supabase } from '@/lib/supabase';
import { isNative } from './platform';
import { deviceTimeZone, parseSnapshot } from './surfacesCore';
import { loadMobileSurfacePrefs } from './mobileSurfacesApi';
import { syncNativePushToken } from './push';

interface VireekSurfacesPlugin {
  setSnapshot(opts: { json: string }): Promise<void>;
  clearSnapshot(): Promise<void>;
  consumePendingLink(): Promise<{ url?: string }>;
  addListener(
    event: 'liveActivityToken',
    cb: (e: { kind: 'start' | 'update'; target: string; token: string }) => void,
  ): Promise<PluginListenerHandle>;
}

const Surfaces = registerPlugin<VireekSurfacesPlugin>('VireekSurfaces');

export async function refreshSurfaceSnapshot(): Promise<void> {
  if (!isNative()) return;
  try {
    const prefs = await loadMobileSurfacePrefs();
    if (!prefs.widgets_enabled) return void (await Surfaces.clearSnapshot());
    const { data, error } = await supabase.rpc('mobile_surface_snapshot', { p_tz: deviceTimeZone() });
    const snap = error ? null : parseSnapshot(data);
    if (snap) await Surfaces.setSnapshot({ json: JSON.stringify(snap) });
  } catch {
    /* widgets keep their last snapshot and show it as "updated Xh ago" */
  }
}

export async function clearSurfaceSnapshot(): Promise<void> {
  if (!isNative()) return;
  await Surfaces.clearSnapshot().catch(() => undefined);
}

/**
 * Call while a person is signed in. Refreshes the snapshot on start and every resume, forwards Live Activity push
 * tokens to the backend, and opens links queued by Siri shortcuts. Returns a cleanup function.
 */
export async function startSurfaceBridge(open: (url: string) => void): Promise<() => void> {
  if (!isNative()) return () => undefined;
  const cleanups: Array<() => void> = [];
  try {
    const { App } = await import('@capacitor/app');
    const consume = async () => {
      const { url } = await Surfaces.consumePendingLink().catch(() => ({ url: undefined }));
      if (url) open(url);
    };
    const resume = await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        void syncNativePushToken(); // re-attach the token after Android rotates it (the plugin's token listener is replaced)
        void refreshSurfaceSnapshot();
        void consume();
      }
    });
    cleanups.push(() => void resume.remove().catch(() => undefined));

    const tokens = await Surfaces.addListener('liveActivityToken', ({ kind, target, token }) => {
      void supabase.rpc('register_live_activity_token', { p_kind: kind, p_target: target, p_token: token });
    });
    cleanups.push(() => void tokens.remove().catch(() => undefined));

    void refreshSurfaceSnapshot();
    void consume();
  } catch {
    /* plugin not present in this build */
  }
  return () => cleanups.forEach((c) => c());
}
