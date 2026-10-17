// src/components/native/NativeBridge.tsx
// Mounted once inside the providers. In the installed app it wires: deep / universal links,
// Android back button, notification taps + foreground notifications, push-token sync,
// reliable online / offline events and the status-bar theme. On the web it renders nothing.

import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { resolveDeepLink } from '@/lib/native/deepLinks';
import { isNative } from '@/lib/native/platform';
import { startNativePushListeners, syncNativePushToken } from '@/lib/native/push';
import { syncStatusBarWithTheme } from '@/lib/native/shell';

type Handle = { remove: () => Promise<void> };

export function NativeBridge(): null {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const lastOpen = useRef<{ path: string; at: number } | null>(null);

  const open = useCallback(
    (raw: string) => {
      const link = resolveDeepLink(raw);
      if (!link) return;
      const now = Date.now();
      if (lastOpen.current && lastOpen.current.path === link.path && now - lastOpen.current.at < 1500) return;
      lastOpen.current = { path: link.path, at: now };
      if (link.isAuthLink) window.location.assign(link.path);
      else navigate(link.path);
    },
    [navigate],
  );

  // App-level listeners: links, back button, connectivity, status bar.
  useEffect(() => {
    if (!isNative()) return undefined;
    let cancelled = false;
    const handles: Handle[] = [];
    const stopStatusBar = syncStatusBarWithTheme();

    void Promise.all([import('@capacitor/app'), import('@capacitor/network')])
      .then(async ([{ App }, { Network }]) => {
        const add = async (p: Promise<Handle>) => {
          const h = await p;
          if (cancelled) void h.remove();
          else handles.push(h);
        };
        await add(App.addListener('appUrlOpen', ({ url }) => open(url)));
        await add(
          App.addListener('backButton', ({ canGoBack }) => {
            if (canGoBack) window.history.back();
            else void App.exitApp();
          }),
        );
        await add(
          Network.addListener('networkStatusChange', ({ connected }) => {
            window.dispatchEvent(new Event(connected ? 'online' : 'offline'));
          }),
        );
        const launch = await App.getLaunchUrl();
        if (launch?.url && !cancelled) open(launch.url);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      stopStatusBar();
      handles.splice(0).forEach((h) => void h.remove().catch(() => undefined));
    };
  }, [open]);

  // Push: notification taps open the target screen; foreground pushes show as a toast.
  useEffect(() => {
    if (!isNative()) return undefined;
    let cancelled = false;
    let stop: (() => void) | null = null;
    void startNativePushListeners({
      onOpen: open,
      onForeground: (n) => toast([n.title, n.body].filter(Boolean).join(' — ') || 'New notification', 'info'),
    })
      .then((s) => {
        if (cancelled) s();
        else stop = s;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [open, toast]);

  // Keep this device's token attached to whoever is signed in (never prompts).
  useEffect(() => {
    if (isNative() && userId) void syncNativePushToken();
  }, [userId]);

  return null;
}
