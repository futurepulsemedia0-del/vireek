// src/lib/native/capabilities.ts
// One API for the field screens. Inside the iOS / Android app it uses the native plugins;
// in a browser / PWA it falls back to the web implementations in offline/capture.ts.

import {
  getCurrentFix, isBarcodeSupported, isNfcSupported, readNfcTag, scanBarcode, setTrackingEnabled,
  startLocationTracking,
} from '../offline/capture';
import { isNative } from './platform';
import { isNativeNfcSupported, readNativeNfcTag } from './nfc';
import { isNativeScanSupported, scanNativeCode } from './scanner';
import { requestTrackingPermission, startNativeTracking } from './tracking';

export interface FieldCapabilities {
  scan: boolean;
  nfc: boolean;
}

export async function detectCapabilities(): Promise<FieldCapabilities> {
  if (!isNative()) return { scan: isBarcodeSupported(), nfc: isNfcSupported() };
  const [scan, nfc] = await Promise.all([
    isNativeScanSupported().catch(() => false),
    isNativeNfcSupported().catch(() => false),
  ]);
  return { scan, nfc };
}

/** `video` is only used by the web scanner; the native scanner draws its own full-screen camera UI. */
export function scanCode(video: HTMLVideoElement | null, signal: AbortSignal): Promise<{ value: string; format: string }> {
  if (isNative()) return scanNativeCode();
  if (!video) return Promise.reject(new Error('Scanner is not ready.'));
  return scanBarcode(video, signal);
}

export function readTag(signal: AbortSignal): Promise<{ serial: string; records: string[] }> {
  return isNative() ? readNativeNfcTag(signal) : readNfcTag(signal);
}

/** Starts the GPS trail (background-capable in the app). Returns a stop function. */
export function startTrail(getJobId: () => string | null): () => void {
  if (!isNative()) return startLocationTracking(getJobId);
  return startNativeTracking(getJobId, (issue) => {
    // Permission revoked in system settings: switch the toggle off so the UI tells the truth.
    if (issue === 'not_authorized') void setTrackingEnabled(false);
  });
}

export async function ensureTrailPermission(): Promise<boolean> {
  if (isNative()) return requestTrackingPermission().catch(() => false);
  return (await getCurrentFix(10_000)) !== null;
}
