// src/lib/native/platform.ts
// Single source of truth for "are we inside the Vireek Field iOS / Android app?".
// Everything native is gated by isNative() so the website and the PWA keep working unchanged.

import { Capacitor } from '@capacitor/core';

export type NativePlatform = 'ios' | 'android';

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function nativePlatform(): NativePlatform | null {
  const p = Capacitor.getPlatform();
  return p === 'ios' || p === 'android' ? p : null;
}
