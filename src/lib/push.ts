// src/lib/push.ts — real Web Push (PWA-friendly, no native app needed).
import { supabase } from '@/lib/supabase';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export type PushSupportState = 'unsupported' | 'denied' | 'not-subscribed' | 'subscribed';

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    Boolean(VAPID_PUBLIC_KEY)
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/sw.js');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js');
}

export async function getPushState(): Promise<PushSupportState> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';

  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    return subscription ? 'subscribed' : 'not-subscribed';
  } catch {
    return 'not-subscribed';
  }
}

async function subscribeBrowser(registration: ServiceWorkerRegistration): Promise<PushSubscription> {
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY as string),
  });
}

function subscriptionPayload(subscription: PushSubscription): {
  endpoint: string;
  p256dh: string;
  auth_key: string;
  user_agent: string;
} | null {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const authKey = json.keys?.auth;
  if (!endpoint || !p256dh || !authKey) return null;
  return { endpoint, p256dh, auth_key: authKey, user_agent: navigator.userAgent };
}

// Saves a subscription row for the CURRENTLY signed-in account.
//
// `endpoint` is globally unique in `push_subscriptions`, but a browser's
// push subscription is scoped to this device + origin, not to whichever
// Vireek account happens to be logged in right now — so the exact same
// subscription can be "inherited" from a previous account on a shared
// device (e.g. a shop's front-desk computer). There is also no UPDATE
// policy on this table (only SELECT/INSERT/DELETE), so a naive
// `upsert(..., { onConflict: 'endpoint' })` either gets rejected by RLS
// outright, or — if it were ever allowed — would silently leave the row
// owned by whichever account created it first, since `user_id` isn't
// part of the update payload. Either way the second account could never
// reliably subscribe.
//
// Fix: never rely on an UPDATE path. Try a plain insert; if the endpoint
// is already taken, first see if it's already ours to reclaim (RLS only
// lets us delete our own account's rows, so this is a no-op otherwise);
// if it's still taken after that, the subscription truly belongs to a
// different account on this device — retire it and mint a fresh one,
// which the push service will hand a brand new, unclaimed endpoint.
async function saveSubscription(
  subscription: PushSubscription,
  registration: ServiceWorkerRegistration,
): Promise<{ success: boolean; error?: string }> {
  const payload = subscriptionPayload(subscription);
  if (!payload) {
    return { success: false, error: 'Subscription is missing required keys.' };
  }

  let { error } = await supabase.from('push_subscriptions').insert(payload);
  if (!error) return { success: true };
  if (error.code !== '23505') {
    return { success: false, error: 'Could not save your subscription. Please try again.' };
  }

  // Unique violation on `endpoint` — maybe it's already our own row
  // (e.g. a retry after a previous save whose response got lost).
  await supabase.from('push_subscriptions').delete().eq('endpoint', payload.endpoint);
  ({ error } = await supabase.from('push_subscriptions').insert(payload));
  if (!error) return { success: true };
  if (error.code !== '23505') {
    return { success: false, error: 'Could not save your subscription. Please try again.' };
  }

  // Still conflicting: this browser subscription belongs to a different
  // Vireek account on this device. Retire it and get a fresh one.
  try {
    await subscription.unsubscribe();
  } catch {
    // Best-effort — even if the browser refuses to drop it, subscribing
    // again below still gives us a usable (likely new) subscription.
  }

  let fresh: PushSubscription;
  try {
    fresh = await subscribeBrowser(registration);
  } catch {
    return { success: false, error: 'Could not enable push notifications. Please try again.' };
  }

  const freshPayload = subscriptionPayload(fresh);
  if (!freshPayload) {
    return { success: false, error: 'Subscription is missing required keys.' };
  }

  ({ error } = await supabase.from('push_subscriptions').insert(freshPayload));
  if (!error) return { success: true };
  return { success: false, error: 'Could not save your subscription. Please try again.' };
}

export async function subscribeToPush(): Promise<{ success: boolean; error?: string }> {
  if (!isPushSupported()) {
    return { success: false, error: 'Push notifications are not supported in this browser.' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { success: false, error: 'Notification permission was not granted.' };
  }

  try {
    const registration = await getServiceWorkerRegistration();
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await subscribeBrowser(registration);
    }

    return await saveSubscription(subscription, registration);
  } catch {
    return { success: false, error: 'Could not enable push notifications. Please try again.' };
  }
}

export async function unsubscribeFromPush(): Promise<{ success: boolean; error?: string }> {
  if (!isPushSupported()) return { success: true };

  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return { success: true };

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();

    const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) {
      // The device itself is already unsubscribed (the part the user can
      // see and verify), so this still counts as success — but leaving
      // this unlogged meant a failed cleanup left an orphaned row with
      // no trace anywhere.
      console.warn('[push] Failed to remove push_subscriptions row:', error.message);
    }
    return { success: true };
  } catch {
    return { success: false, error: 'Could not disable push notifications. Please try again.' };
  }
}
