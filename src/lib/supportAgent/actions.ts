// src/lib/supportAgent/actions.ts
//
// LEVEL 2 (Automated Resolution) + LEVEL 3 (Autonomous Self-Healing) action registry.
// One policy gate for every action, whoever triggers it:
//   • origin 'user'        → any registered action, after the UI's explicit confirmation
//   • origin 'autonomous'  → ONLY actions flagged `autonomous` (safe, reversible, no email,
//                            no data change) and only inside a small retry budget
// Every action returns an honest outcome — `verified` means we re-read state and saw the
// fix; `accepted` means the request was sent but cannot be observed from the browser (email).

import type { ActionId } from './diagnostics';

export type { ActionId };
export type Origin = 'user' | 'autonomous';
export type OutcomeStatus = 'verified' | 'accepted' | 'failed' | 'blocked' | 'pending_reload';
export interface ActionOutcome { status: OutcomeStatus; message: string }

export interface ActionDef {
  id: ActionId;
  label: string;
  /** Shown in the confirmation step so the user knows exactly what will happen. */
  confirm: string;
  risk: 'none' | 'low' | 'moderate';
  autonomous: boolean;
  needsEmail: boolean;
}

export const ACTIONS: Record<ActionId, ActionDef> = {
  refresh_session: {
    id: 'refresh_session', label: 'Renew my session', risk: 'none', autonomous: true, needsEmail: false,
    confirm: 'Renews your sign-in token. You stay signed in.',
  },
  clear_app_cache: {
    id: 'clear_app_cache', label: 'Clear app files & reload', risk: 'low', autonomous: false, needsEmail: false,
    confirm: 'Deletes temporary app files stored by this site and reloads the page. You stay signed in; unsaved form input on this page is lost.',
  },
  resend_verification: {
    id: 'resend_verification', label: 'Resend verification email', risk: 'low', autonomous: false, needsEmail: true,
    confirm: 'Sends a new verification email to the address you enter.',
  },
  send_password_reset: {
    id: 'send_password_reset', label: 'Email me a reset link', risk: 'moderate', autonomous: false, needsEmail: true,
    confirm: 'Sends a password-reset link to the address you enter. Your current password keeps working until you use the link.',
  },
  reload_app: {
    id: 'reload_app', label: 'Reload the page', risk: 'low', autonomous: false, needsEmail: false,
    confirm: 'Reloads this page. Unsaved form input on this page is lost.',
  },
  open_live_chat: {
    id: 'open_live_chat', label: 'Talk to our team', risk: 'none', autonomous: false, needsEmail: false,
    confirm: 'Opens a chat with the Vireek team.',
  },
};

export interface ActionDeps {
  now(): number;
  refreshSession(): Promise<{ error?: string }>;
  /** Access-token expiry (epoch seconds) or null when there is no session. */
  getSessionExpiry(): Promise<number | null>;
  resendSignup(email: string): Promise<{ error?: string }>;
  resetPassword(email: string): Promise<{ error?: string }>;
  /** Deletes Cache Storage + asks service workers to update. Never unregisters (that would drop push subscriptions). */
  clearCaches(): Promise<{ caches: number }>;
  reload(): void;
  openLiveChat(): void;
  markPendingVerify(id: ActionId): void;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (s: string): boolean => s.length <= 254 && EMAIL_RE.test(s.trim());

const COOLDOWN_MS = 60_000;
const lastRun = new Map<ActionId, number>();

/** Autonomous retry budget: at most `max` self-heals per action per `windowMs`. Prevents loops. */
export function createHealingBudget(max = 3, windowMs = 10 * 60_000) {
  const hits = new Map<ActionId, number[]>();
  return {
    tryConsume(id: ActionId, now: number): boolean {
      const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) { hits.set(id, recent); return false; }
      hits.set(id, [...recent, now]);
      return true;
    },
  };
}

const friendlyError = (error: string): string =>
  /rate limit|too many|429/i.test(error)
    ? 'Too many requests right now. Please wait about 10 minutes and try again.'
    : 'That did not work. Please try again, or talk to our team.';

export async function runAction(
  id: ActionId,
  deps: ActionDeps,
  opts: { origin: Origin; email?: string } = { origin: 'user' },
): Promise<ActionOutcome> {
  const def = ACTIONS[id];
  if (!def) return { status: 'blocked', message: 'Unknown action.' };
  if (opts.origin === 'autonomous' && !def.autonomous) {
    return { status: 'blocked', message: 'This action needs your confirmation.' };
  }

  const now = deps.now();
  if (def.needsEmail) {
    if (!opts.email || !isValidEmail(opts.email)) return { status: 'blocked', message: 'Enter a valid email address first.' };
    if (now - (lastRun.get(id) ?? 0) < COOLDOWN_MS) {
      return { status: 'blocked', message: 'Please wait a minute before requesting another email.' };
    }
  }

  try {
    switch (id) {
      case 'refresh_session': {
        const before = await deps.getSessionExpiry();
        if (before === null) return { status: 'failed', message: 'No active session to renew. Please sign in.' };
        const { error } = await deps.refreshSession();
        if (error) return { status: 'failed', message: 'Your session could not be renewed. Please sign in again.' };
        const after = await deps.getSessionExpiry(); // VERIFY: re-read, do not trust the call's success alone
        return after !== null && after > deps.now() / 1000 + 60
          ? { status: 'verified', message: 'Session renewed and confirmed.' }
          : { status: 'failed', message: 'Renewal did not take effect. Please sign in again.' };
      }
      case 'clear_app_cache': {
        await deps.clearCaches();
        deps.markPendingVerify(id); // verified after the reload by a fresh diagnostics run
        deps.reload();
        return { status: 'pending_reload', message: 'Reloading — the result is checked right after.' };
      }
      case 'resend_verification': {
        lastRun.set(id, now);
        const { error } = await deps.resendSignup(opts.email!.trim());
        // Deliberately identical wording whether or not an account exists (no account enumeration).
        return error
          ? { status: 'failed', message: friendlyError(error) }
          : { status: 'accepted', message: 'If an account exists for that address, a new email is on its way. Check spam too. (We cannot see your inbox, so delivery cannot be verified automatically.)' };
      }
      case 'send_password_reset': {
        lastRun.set(id, now);
        const { error } = await deps.resetPassword(opts.email!.trim());
        return error
          ? { status: 'failed', message: friendlyError(error) }
          : { status: 'accepted', message: 'If an account exists for that address, a reset link is on its way. Check spam too. (Delivery cannot be verified automatically.)' };
      }
      case 'reload_app':
        deps.markPendingVerify(id);
        deps.reload();
        return { status: 'pending_reload', message: 'Reloading…' };
      case 'open_live_chat':
        deps.openLiveChat();
        return { status: 'verified', message: 'Chat opened.' };
    }
  } catch {
    return { status: 'failed', message: 'Something went wrong. Please try again, or talk to our team.' };
  }
}

/** Test helper. */
export const __resetCooldowns = (): void => lastRun.clear();
