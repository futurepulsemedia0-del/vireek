// src/lib/native/appLock.ts — optional Face ID / fingerprint / device-passcode lock for the app.
// The on/off flag lives in the Keychain / Keystore. Web / PWA: everything here is a no-op.

import { isNative } from './platform';
import { nativeAuthStorage } from './secureStorage';

const FLAG_KEY = 'vireek.app_lock';

/** Backgrounded for at least this long → ask again on return (quick app switches stay unlocked). */
export const RELOCK_AFTER_MS = 30_000;

export function shouldRelock(backgroundedAt: number | null, now: number, graceMs: number = RELOCK_AFTER_MS): boolean {
  return backgroundedAt !== null && now - backgroundedAt >= graceMs;
}

async function plugin() {
  return (await import('@aparajita/capacitor-biometric-auth')).BiometricAuth;
}

/** True when the phone has biometrics or at least a passcode set up. */
export async function isAppLockSupported(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const r = await (await plugin()).checkBiometry();
    return r.isAvailable || r.deviceIsSecure;
  } catch {
    return false;
  }
}

export async function authenticateUser(reason: string): Promise<boolean> {
  try {
    await (await plugin()).authenticate({
      reason,
      cancelTitle: 'Cancel',
      allowDeviceCredential: true,
      iosFallbackTitle: 'Use passcode',
      androidTitle: 'Unlock Vireek',
      androidSubtitle: reason,
    });
    return true;
  } catch {
    return false;
  }
}

export async function isAppLockEnabled(): Promise<boolean> {
  if (!isNative()) return false;
  return (await nativeAuthStorage.getItem(FLAG_KEY)) === '1';
}

/** Changing the setting requires authenticating first. Resolves false when the user did not pass. */
export async function setAppLockEnabled(on: boolean): Promise<boolean> {
  if (!(await authenticateUser(on ? 'Confirm to turn on app lock' : 'Confirm to turn off app lock'))) return false;
  if (on) await nativeAuthStorage.setItem(FLAG_KEY, '1');
  else await nativeAuthStorage.removeItem(FLAG_KEY);
  return true;
}
