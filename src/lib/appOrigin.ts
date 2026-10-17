// src/lib/appOrigin.ts
// Origin used when building links that leave the app (booking, tracking, sign, approve...).
// Inside the iOS / Android app `window.location.origin` is a local WebView origin
// (https://localhost or capacitor://localhost), which customers cannot open.

import { isNative } from '@/lib/native/platform';

const PUBLIC_ORIGIN = ((import.meta.env.VITE_PUBLIC_APP_ORIGIN as string | undefined) || 'https://vireek.com').replace(/\/+$/, '');

export function getPublicOrigin(): string {
  if (isNative() || typeof window === 'undefined') return PUBLIC_ORIGIN;
  return window.location.origin;
}
