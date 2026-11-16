// src/lib/supportAgent/runtime.ts
//
// The ONLY file in the Support Agent that touches the real browser / Supabase.
// Everything else is pure and unit-tested against fakes.

import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import type { ActionDeps } from './actions';
import type { EvidenceDeps } from './diagnostics';
import { getIssues, summarizeIssues } from './errorBuffer';
import type { ActionId } from './diagnostics';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Must match RESET_PASSWORD_REDIRECT_URL in src/pages/ForgotPasswordPage.tsx. */
const RESET_PASSWORD_REDIRECT_URL = `${import.meta.env.VITE_SITE_URL ?? 'https://vireek.com'}/reset-password`;

export const PENDING_VERIFY_KEY = 'vk_agent_pending_verify';

function storageWorks(): boolean {
  try {
    const k = '__vk_probe__';
    window.localStorage.setItem(k, '1');
    const ok = window.localStorage.getItem(k) === '1';
    window.localStorage.removeItem(k);
    return ok;
  } catch {
    return false;
  }
}

export function createEvidenceDeps(): EvidenceDeps {
  return {
    now: () => Date.now(),
    isOnline: () => navigator.onLine,
    configured: isSupabaseConfigured,
    async ping(timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const t0 = performance.now();
      try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
          headers: { apikey: SUPABASE_ANON_KEY ?? '' },
          cache: 'no-store',
          signal: controller.signal,
        });
        return { ok: res.ok, ms: Math.round(performance.now() - t0), serverDate: res.headers.get('date') };
      } catch {
        return { ok: false, ms: Math.round(performance.now() - t0), serverDate: null };
      } finally {
        clearTimeout(timer);
      }
    },
    async getSession() {
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      return s ? { expiresAtSec: s.expires_at ?? null, emailConfirmed: Boolean(s.user?.email_confirmed_at) } : null;
    },
    storageWorks,
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    async countServiceWorkers() {
      return 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0;
    },
    async countCaches() {
      return 'caches' in window ? (await caches.keys()).length : 0;
    },
    issues: () => summarizeIssues(getIssues()),
  };
}

export function createActionDeps(): ActionDeps {
  return {
    now: () => Date.now(),
    async refreshSession() {
      const { error } = await supabase.auth.refreshSession();
      return error ? { error: error.message } : {};
    },
    async getSessionExpiry() {
      const { data } = await supabase.auth.getSession();
      return data.session?.expires_at ?? null;
    },
    async resendSignup(email) {
      const { error } = await supabase.auth.resend({ type: 'signup', email });
      return error ? { error: error.message } : {};
    },
    async resetPassword(email) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: RESET_PASSWORD_REDIRECT_URL });
      return error ? { error: error.message } : {};
    },
    async clearCaches() {
      let n = 0;
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        n = keys.length;
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update().catch(() => undefined))); // update, NEVER unregister
      }
      return { caches: n };
    },
    reload: () => window.location.reload(),
    openLiveChat: () => window.dispatchEvent(new CustomEvent('vireek:open-live-chat')),
    markPendingVerify(id: ActionId) {
      try { sessionStorage.setItem(PENDING_VERIFY_KEY, id); } catch { /* storage blocked: skip post-reload verification */ }
    },
  };
}
