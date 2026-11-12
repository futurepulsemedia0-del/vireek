import { useMemo, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { TriangleAlert as AlertTriangle, ArrowRight, Gauge, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { getBannerContent, getLimitPolicy, getUsageSnapshot, findPlan, overageRateFor } from '@/lib/usageLimits';

// ============================================================
// UsageLimitBanner
// ============================================================
//
// Site-wide dashboard banner (mounted in DashboardLayout, same slot as
// UpgradeBanner / SurgeModeBanner / PaymentFailedBanner) that fires the
// moment a tenant's included minutes for the billing period are fully
// used up. Previously this state was invisible in the product — the
// Usage Dashboard only ever warned about a *projected* overage, never
// clearly said "you are over your limit right now" — so operators found
// out about a hard cutoff (Free plan) or a surprise overage bill (paid
// plans) only after the fact. This makes that moment explicit everywhere.
//
// Two distinct states, matched to what actually happens to the account:
//   - No overage rate on the plan (Free): calls stop being answered.
//     This is a hard cutoff, so it's styled and treated like
//     PaymentFailedBanner's "suspended" state — danger-colored, not
//     dismissible, stays until the plan is upgraded or the period rolls.
//   - Overage rate present (Starter/Professional/Business): service
//     keeps working, extra minutes are simply billed per-minute. Styled
//     as a warning, and dismissible for the rest of this billing period
//     (the dismissal key is scoped to the current month, so it reappears
//     automatically next cycle if the account is over again).
//
// Never shown for unlimited plans (Enterprise), and suppressed while
// PaymentFailedBanner's "suspended" state is already showing — that
// banner already communicates "service has stopped," and stacking a
// second hard-cutoff banner on top of it would just be confusing.

const UPGRADE_ROUTE = '/dashboard/billing';
const ASSISTANT_NAME = 'Sarah';
const DISMISS_STORAGE_PREFIX = 'vireek-usage-limit-banner-dismissed-v1';

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7); // "2026-09"
}

function readDismissed(userId: string, month: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISS_STORAGE_PREFIX}:${userId}:${month}`) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(userId: string, month: string) {
  try {
    window.localStorage.setItem(`${DISMISS_STORAGE_PREFIX}:${userId}:${month}`, '1');
  } catch {
    // Non-fatal: banner just won't remember the dismissal this session.
  }
}

export function UsageLimitBanner() {
  const { user, profile, profileLoading } = useAuth();
  const navigate = useNavigate();
  // Bumped after a dismissal so the localStorage read below re-runs (no effect => no first-paint flash).
  const [dismissTick, setDismissTick] = useState(0);

  const currentMonth = useMemo(() => monthKey(new Date()), []);

  const snap = useMemo(
    () =>
      getUsageSnapshot({
        minutesUsed: profile?.minutes_used_this_month,
        minutesIncluded: profile?.minutes_included,
        bonusMinutes: profile?.bonus_minutes,
      }),
    [profile?.minutes_used_this_month, profile?.minutes_included, profile?.bonus_minutes],
  );

  // Dismissal is scoped to user + month + level, so reaching 100% resurfaces a banner dismissed at 80%.
  const dismissKey = `${currentMonth}:${snap.level}`;
  const dismissed = useMemo(
    () => (user ? readDismissed(user.id, dismissKey) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dismissTick intentionally re-triggers the read
    [user, dismissKey, dismissTick],
  );

  const dismiss = useCallback(() => {
    if (!user) return;
    persistDismissed(user.id, dismissKey);
    setDismissTick((t) => t + 1);
  }, [user, dismissKey]);

  const handleUpgrade = useCallback(() => navigate(UPGRADE_ROUTE), [navigate]);

  if (profileLoading || !profile) return null;
  if (snap.level === 'ok') return null;

  // Already covered by PaymentFailedBanner's own hard-cutoff message.
  if (profile.subscription_status === 'suspended') return null;

  const plan = findPlan(profile.plan);
  const policy = getLimitPolicy(plan, snap);
  const content = getBannerContent({
    snap,
    policy,
    rate: overageRateFor(plan),
    planName: plan?.name ?? 'Free',
    assistantName: ASSISTANT_NAME,
  });
  if (!content) return null;
  if (content.dismissible && dismissed) return null;

  const warn = content.tone === 'warning';
  const isLimit = snap.level === 'limit';

  // NOTE: no "Buy 100 minutes" top-up button — no top-up function exists in this codebase yet.
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -12, scale: 0.98, transition: { duration: 0.2 } }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        role={isLimit ? 'alert' : 'status'}
        aria-live="polite"
        data-usage-level={snap.level}
        className={`relative mb-6 flex flex-col gap-4 overflow-hidden rounded-2xl border p-5 shadow-card dark:shadow-card-dark sm:flex-row sm:items-center sm:justify-between sm:p-6 ${
          warn ? 'border-warning-500/30 bg-warning-500/10' : 'border-danger/30 bg-danger/10'
        }`}
      >
        <div className="flex min-w-0 items-start gap-4">
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white ${
              warn ? 'bg-warning-500' : 'bg-danger'
            }`}
          >
            {warn ? <Gauge size={22} strokeWidth={2.25} aria-hidden="true" /> : <AlertTriangle size={22} strokeWidth={2.25} aria-hidden="true" />}
          </span>

          <div className="min-w-0">
            <p className={`text-xs font-semibold uppercase tracking-wider ${warn ? 'text-warning-500' : 'text-danger'}`}>
              {content.eyebrow}
            </p>
            <h3 className="mt-1 text-base font-bold leading-snug text-text-primary sm:text-lg">{content.title}</h3>
            <p className="mt-1 text-sm text-text-secondary">{content.body}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
          <button
            type="button"
            onClick={handleUpgrade}
            className={`focus-ring flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-glow-cta transition-all duration-150 ease-out hover:brightness-110 active:brightness-95 ${
              warn ? 'bg-cta' : 'bg-danger'
            }`}
          >
            Upgrade
            <ArrowRight size={15} aria-hidden="true" />
          </button>

          {content.dismissible && (
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss usage limit banner"
              className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-secondary/70 transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
