// src/lib/native/secureStorage.ts
// Supabase session storage for the installed app: iOS Keychain / Android Keystore instead of
// WebView localStorage (which other code on the page, backups or a storage purge can reach).
// Only used when isNative(); the website keeps Supabase's default localStorage.

import type { SupportedStorage } from '@supabase/supabase-js';

type Store = (typeof import('@aparajita/capacitor-secure-storage'))['SecureStorage'];

let ready: Promise<Store> | null = null;

function store(): Promise<Store> {
  ready ??= import('@aparajita/capacitor-secure-storage').then(async ({ SecureStorage }) => {
    // Never mirror auth tokens to iCloud Keychain.
    await SecureStorage.setSynchronize(false).catch(() => undefined);
    return SecureStorage;
  });
  return ready;
}

/** Failures degrade to "signed out", never to a crash or a plaintext fallback. */
export const nativeAuthStorage: SupportedStorage = {
  async getItem(key) {
    try {
      return await (await store()).getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      await (await store()).setItem(key, value);
    } catch {
      /* keystore unavailable — the session simply will not persist */
    }
  },
  async removeItem(key) {
    try {
      await (await store()).removeItem(key);
    } catch {
      /* nothing to remove */
    }
  },
};
