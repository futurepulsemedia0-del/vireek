// Re-auth gate: a tiny external store + promise bridge. Concurrent callers
// (e.g. five requests failing with an expired JWT) share ONE pending prompt.

export type ReauthReason = 'expired' | 'refresh_failed' | 'revoked';

export interface ReauthState {
  open: boolean;
  reason: ReauthReason;
  email: string | null;
}

type Listener = () => void;

let state: ReauthState = { open: false, reason: 'expired', email: null };
let pending: Promise<boolean> | null = null;
let settle: ((ok: boolean) => void) | null = null;
let lastEmail: string | null = null;
let lastUserId: string | null = null;
let enabled = false; // only true while an authenticated session exists (set by SessionGuard)
const listeners = new Set<Listener>();

const emit = () => listeners.forEach((l) => l());

export const reauthGate = {
  getState: (): ReauthState => state,
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  rememberEmail(email: string | null | undefined) {
    if (email) lastEmail = email;
  },
  rememberUser(id: string | null | undefined) {
    if (id) lastUserId = id;
  },
  /** The account whose page is on screen. Re-auth as anyone else must reload the app. */
  expectedUserId: (): string | null => lastUserId,
  setEnabled(v: boolean) {
    enabled = v;
  },
  /** Open the prompt (idempotent). Resolves true after a successful sign-in, false if dismissed. */
  request(reason: ReauthReason = 'expired'): Promise<boolean> {
    if (!enabled) return Promise.resolve(false); // anonymous visitors never see a re-auth prompt
    if (pending) return pending;
    pending = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    state = { open: true, reason, email: lastEmail };
    emit();
    return pending;
  },
  resolve(ok: boolean) {
    const done = settle;
    pending = null;
    settle = null;
    state = { ...state, open: false };
    emit();
    done?.(ok);
  },
  isOpen: () => state.open,
};

/** Run `fn`; if it fails with an auth-expired error, prompt once and retry once. */
export async function withReauth<T>(fn: () => Promise<T>, isExpired: (e: unknown) => boolean): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isExpired(err)) throw err;
    const ok = await reauthGate.request('expired');
    if (!ok) throw err;
    return fn();
  }
}
