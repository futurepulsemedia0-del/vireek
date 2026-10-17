// src/lib/native/geolocation.ts — one-shot position via the native OS location service.
// (The background trail lives in tracking.ts.) Used by offline/capture.ts when running in the app.

import type { Fix } from '../offline/capture';

export async function hasNativeLocationPermission(): Promise<boolean> {
  try {
    const { Geolocation } = await import('@capacitor/geolocation');
    const s = await Geolocation.checkPermissions();
    return s.location === 'granted' || s.coarseLocation === 'granted';
  } catch {
    return false;
  }
}

export async function getNativeFix(timeoutMs: number): Promise<Fix | null> {
  try {
    const { Geolocation } = await import('@capacitor/geolocation');
    let s = await Geolocation.checkPermissions();
    if (s.location !== 'granted' && s.coarseLocation !== 'granted') {
      if (s.location === 'denied') return null;
      s = await Geolocation.requestPermissions({ permissions: ['location'] });
      if (s.location !== 'granted' && s.coarseLocation !== 'granted') return null;
    }
    const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 });
    return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null, at: Date.now() };
  } catch {
    return null;
  }
}
