// src/lib/native/nativeActions.ts — tap-to-call, navigate-to-job and the native share sheet.
// URL building is pure and unit tested; the only side effects are window.location / Share plugin.

import { isNative, nativePlatform } from './platform';

/** Digits and a leading + only; anything else (letters, "javascript:", spaces) is rejected. */
export function buildTelUrl(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d{6,15}$/.test(cleaned)) return null;
  return `tel:${cleaned}`;
}

export function buildSmsUrl(phone: string | null | undefined): string | null {
  const tel = buildTelUrl(phone);
  return tel ? tel.replace(/^tel:/, 'sms:') : null;
}

/** iOS → Apple Maps, Android → geo: intent (opens the user's default maps app), web → Google Maps. */
export function buildMapsUrl(address: string | null | undefined, platform: 'ios' | 'android' | null): string | null {
  const q = address?.trim();
  if (!q || q.length > 300) return null;
  const enc = encodeURIComponent(q);
  if (platform === 'ios') return `https://maps.apple.com/?daddr=${enc}&dirflg=d`;
  if (platform === 'android') return `geo:0,0?q=${enc}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${enc}`;
}

function open(url: string): void {
  window.location.href = url;
}

export function callNumber(phone: string | null | undefined): boolean {
  const url = buildTelUrl(phone);
  if (!url) return false;
  open(url);
  return true;
}

export function navigateToAddress(address: string | null | undefined): boolean {
  const url = buildMapsUrl(address, isNative() ? nativePlatform() : null);
  if (!url) return false;
  open(url);
  return true;
}

/** Native share sheet in the app, Web Share API in capable browsers. Resolves false if unavailable or cancelled. */
export async function shareContent(input: { title: string; text?: string; url?: string }): Promise<boolean> {
  try {
    if (isNative()) {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: input.title, text: input.text, url: input.url, dialogTitle: input.title });
      return true;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share(input);
      return true;
    }
  } catch {
    /* user dismissed the sheet */
  }
  return false;
}
