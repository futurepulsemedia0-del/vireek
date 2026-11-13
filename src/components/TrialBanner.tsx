import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Hourglass, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

// ============================================================
// TrialBanner
// ============================================================
//
// Dashboard banner (same slot as UpgradeBanner / UsageLimitBanner) that tells a
// tenant on a free trial how long is left, and tells them when the trial has
// ended. Driven only by profile.trial_state / profile.trial_ends_at.
// Dismissible per user per day (stored on this device only); it comes back
// the next day so the end of a trial is never silently missed.

const UPGRADE_ROUTE = '/dashboard/billing/plans';
const DISMISS_STORAGE_PREFIX = 'vireek-trial-banner-dismissed-v1';
const DAY_MS = 86_400_000;
const URGENT_DAYS = 3;

const dayKey = (): string => new Date().toISOString().slice(0, 10);

function readDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISS_STORAGE_PREFIX}:${userId}`) === dayKey();
  } catch {
    return false;
  }
}

function persistDismissed(userId: string): void {
  try {
    window.localStorage.setItem(`${DISMISS_STORAGE_PREFIX}:${userId}`, dayKey());
  } catch {
    // Non-fatal: the banner just won't remember the dismissal on this device.
  }
}

function daysLeftUntil(endIso: string | null | undefined, nowMs: number): number | null {
  if (!endIso) return null;
  const end = Date.parse(endIso);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - nowMs) / DAY_MS));
}

export function TrialBanner() {
  const { user, profile, profileLoading } = useAuth();
  const navigate = useNavigate();
  const [hydrated, setHydrated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [nowMs] = useState(() => Date.now());

  useEffect(() => {
    setDismissed(user ? readDismissed(user.id) : false);
    setHydrated(true);
  }, [user]);

  const dismiss = useCallback(() => {
    if (!user) return;
    persistDismissed(user.id);
    setDismissed(true);
  }, [user]);

  const state = profile?.trial_state;
  const daysLeft = state === 'trialing' ? daysLeftUntil(profile?.trial_ends_at, nowMs) : null;
  const trialing = state === 'trialing' && daysLeft !== null;
  const ended = state === 'ended';
  const visible = hydrated && !profileLoading && !dismissed && (trialing || ended);
  const urgent = ended || (daysLeft !== null && daysLeft <= URGENT_DAYS);

  let headline = '';
  if (ended) headline = 'Your free trial has ended';
  else if (daysLeft === 0) headline = 'Your free trial ends today';
  else if (daysLeft === 1) headline = '1 day left in your free trial';
  else if (daysLeft !== null) headline = `${daysLeft} days left in your free trial`;

  const detail = ended
    ? 'Choose a plan to keep your phone numbers, AI agent and call history active.'
    : 'Pick a plan before it ends so nothing is interrupted.';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8, transition: { duration: 0.2 } }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          role="region"
          aria-label="Free trial status"
          className={`relative mb-6 flex flex-col gap-3 rounded-2xl border p-4 shadow-card sm:flex-row sm:items-center sm:justify-between ${
            urgent ? 'border-warning-500/30 bg-warning-500/10' : 'border-accent/20 bg-accent/10'
          }`}
        >
          <div className="flex items-start gap-3">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                urgent ? 'bg-warning-500/15 text-warning-500' : 'bg-accent/15 text-accent'
              }`}
            >
              <Hourglass size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{headline}</p>
              <p className="mt-0.5 text-xs text-text-secondary">{detail}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
            <button
              type="button"
              onClick={() => navigate(UPGRADE_ROUTE)}
              className="focus-ring flex items-center gap-2 whitespace-nowrap rounded-xl bg-cta px-4 py-2 text-sm font-semibold text-white shadow-glow-cta transition-all duration-150 ease-out hover:brightness-110 active:brightness-95"
            >
              Choose a plan
              <ArrowRight size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss trial banner"
              className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-secondary/70 transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
