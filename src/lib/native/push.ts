// src/lib/native/push.ts — real mobile push (APNs on iOS, FCM on Android) through Firebase Cloud
// Messaging. One FCM token per device is stored with register_device_push_token (the same
// account scoping as web push); the send-push-notification edge function delivers to it.

import type { PushSupportState } from '@/lib/push';
import { supabase } from '@/lib/supabase';
import { nativePlatform } from './platform';

type Result = { success: boolean; error?: string };

async function messaging() {
  return (await import('@capacitor-firebase/messaging')).FirebaseMessaging;
}

async function currentToken(): Promise<string | null> {
  try {
    const { token } = await (await messaging()).getToken();
    return token || null;
  } catch {
    return null;
  }
}

async function appVersion(): Promise<string | null> {
  try {
    return (await (await import('@capacitor/app')).App.getInfo()).version;
  } catch {
    return null;
  }
}

async function register(token: string): Promise<boolean> {
  const { error } = await supabase.rpc('register_device_push_token', {
    p_token: token,
    p_platform: nativePlatform(),
    p_app_version: await appVersion(),
  });
  return !error;
}

export async function getNativePushState(): Promise<PushSupportState> {
  try {
    const { receive } = await (await messaging()).checkPermissions();
    if (receive === 'denied') return 'denied';
    if (receive !== 'granted') return 'not-subscribed';
    const token = await currentToken();
    if (!token) return 'not-subscribed';
    const { data } = await supabase.from('device_push_tokens').select('id').eq('token', token).maybeSingle();
    return data ? 'subscribed' : 'not-subscribed';
  } catch {
    return 'not-subscribed';
  }
}

export async function subscribeNativePush(): Promise<Result> {
  try {
    const { receive } = await (await messaging()).requestPermissions();
    if (receive !== 'granted') return { success: false, error: 'Notification permission was not granted.' };
    const token = await currentToken();
    if (!token || !(await register(token))) return { success: false, error: 'Could not enable push notifications. Please try again.' };
    return { success: true };
  } catch {
    return { success: false, error: 'Could not enable push notifications. Please try again.' };
  }
}

export async function unsubscribeNativePush(): Promise<Result> {
  try {
    const token = await currentToken();
    if (token) await supabase.rpc('unregister_device_push_token', { p_token: token });
    await (await messaging()).deleteToken().catch(() => undefined);
    return { success: true };
  } catch {
    return { success: false, error: 'Could not disable push notifications. Please try again.' };
  }
}

/** Silent: re-registers the token for the signed-in account (login, account switch, token rotation). Never prompts. */
export async function syncNativePushToken(token?: string): Promise<void> {
  try {
    const { receive } = await (await messaging()).checkPermissions();
    if (receive !== 'granted') return;
    const t = token ?? (await currentToken());
    if (t) await register(t);
  } catch {
    /* best effort */
  }
}

export function extractNotificationUrl(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

export interface NativePushHandlers {
  onOpen: (url: string) => void;
  onForeground: (n: { title?: string; body?: string }) => void;
}

export async function startNativePushListeners(h: NativePushHandlers): Promise<() => void> {
  const m = await messaging();
  const handles = await Promise.all([
    m.addListener('tokenReceived', ({ token }) => void syncNativePushToken(token)),
    m.addListener('notificationReceived', ({ notification }) => h.onForeground({ title: notification.title, body: notification.body })),
    m.addListener('notificationActionPerformed', ({ notification }) => {
      const url = extractNotificationUrl(notification.data);
      if (url) h.onOpen(url);
    }),
  ]);
  return () => handles.forEach((x) => void x.remove().catch(() => undefined));
}
