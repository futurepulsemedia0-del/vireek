// Distinguishes "the user signed out" from "the session died" (expired/revoked
// refresh token). Both surface as SIGNED_OUT from supabase-js.
import type { SupabaseClient } from '@supabase/supabase-js';

const WINDOW_MS = 10_000;
const CHANNEL = 'vireek-auth';
let intentionalUntil = 0;

export const markIntentionalSignOut = (now = Date.now()): void => {
  intentionalUntil = now + WINDOW_MS;
};
export const isIntentionalSignOut = (now = Date.now()): boolean => now < intentionalUntil;
export const clearIntentionalSignOut = (): void => {
  intentionalUntil = 0;
};

type Msg = { type: 'signed-out' } | { type: 'signed-in' };

export function broadcastAuth(msg: Msg): void {
  try {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch {
    /* best effort */
  }
}

export function listenAuthBroadcast(onMsg: (m: Msg) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent<unknown>) => {
    const d = e.data as { type?: unknown } | null;
    if (d && (d.type === 'signed-out' || d.type === 'signed-in')) onMsg({ type: d.type });
  };
  return () => ch.close();
}

/** Wrap auth.signOut once so EVERY caller (header, policy timeout, settings...) is marked intentional. */
export function installSignOutIntent(auth: SupabaseClient['auth']): void {
  const flag = '__vrkSignOutPatched';
  const target = auth as unknown as Record<string, unknown>;
  if (target[flag]) return;
  const original = auth.signOut.bind(auth);
  auth.signOut = (options) => {
    if (options?.scope !== 'others') {
      markIntentionalSignOut();
      broadcastAuth({ type: 'signed-out' });
    }
    return original(options);
  };
  target[flag] = true;
}
