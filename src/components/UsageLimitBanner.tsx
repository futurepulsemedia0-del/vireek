import { useMemo, useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { TriangleAlert as AlertTriangle, ArrowRight, Gauge, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { PRICING_PLANS, parseOverageRate } from '@/lib/pricing';

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
  const [dismissed, setDismissed] = useState(false);

  const currentMonth = useMemo(() => monthKey(new Date()), []);

  useEffect(() => {
    if (!user) return;
    setDismissed(readDismissed(user.id, currentMonth));
  }, [user, currentMonth]);

  const dismiss = useCallback(() => {
    if (!user) return;
    persistDismissed(user.id, currentMonth);
    setDismissed(true);
  }, [user, currentMonth]);

  const handleUpgrade = useCallback(() => navigate(UPGRADE_ROUTE), [navigate]);

  if (profileLoading || !profile) return null;

  const minutesIncluded = profile.minutes_included ?? 0;
  const minutesUsed = profile.minutes_used_this_month ?? 0;
  const unlimited = minutesIncluded <= 0;
  const limitReached = !unlimited && minutesUsed >= minutesIncluded;
  if (!limitReached) return null;

  // Already covered by PaymentFailedBanner's own hard-cutoff message.
  if (profile.subscription_status === 'suspended') return null;

  const currentPlan = PRICING_PLANS.find((p) => p.id === profile.plan);
  const overageRate = parseOverageRate(currentPlan?.overage ?? null);
  const hasOverage = overageRate !== null;
  const overageMinutes = Math.max(0, Math.round(minutesUsed - minutesIncluded));
  const overageCost = hasOverage ? (overageMinutes * (overageRate as number)).toFixed(2) : null;

  if (hasOverage && dismissed) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -12, scale: 0.98, transition: { duration: 0.2 } }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        role="alert"
        aria-live="polite"
        className={`relative mb-6 flex flex-col gap-4 overflow-hidden rounded-2xl border p-5 shadow-card dark:shadow-card-dark sm:flex-row sm:items-center sm:justify-between sm:p-6 ${
          hasOverage ? 'border-warning-500/30 bg-warning-500/10' : 'border-danger/30 bg-danger/10'
        }`}
      >
        <div className="flex items-start gap-4">
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white ${
              hasOverage ? 'bg-warning-500' : 'bg-danger'
            }`}
          >
            {hasOverage ? <Gauge size={22} strokeWidth={2.25} /> : <AlertTriangle size={22} strokeWidth={2.25} />}
          </span>

          <div className="min-w-0">
            <p
              className={`text-xs font-semibold uppercase tracking-wider ${
                hasOverage ? 'text-warning-500' : 'text-danger'
              }`}
            >
              Usage limit reached
            </p>
            <h3 className="mt-1 text-base font-bold leading-snug text-text-primary sm:text-lg">
              {hasOverage
                ? `You've used all ${minutesIncluded.toLocaleString()} included minutes this month`
                : `${ASSISTANT_NAME} has paused answering new calls for your business`}
            </h3>
            <p className="mt-1 text-sm text-text-secondary">
              {hasOverage
                ? `Extra usage is billed at $${(overageRate as number).toFixed(2)}/min — about $${overageCost} in overage so far (${overageMinutes} min over). Upgrade to raise your included minutes and lower your rate.`
                : `You've used all ${minutesIncluded} minutes included in the ${currentPlan?.name ?? 'Free'} plan this month (${Math.round(minutesUsed)} used). Upgrade to a paid plan to resume 24/7 call answering right away.`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
          <button
            type="button"
            onClick={handleUpgrade}
            className={`focus-ring flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-glow-cta transition-all duration-150 ease-out hover:brightness-110 active:brightness-95 ${
              hasOverage ? 'bg-cta' : 'bg-danger'
            }`}
          >
            Upgrade Plan
            <ArrowRight size={15} aria-hidden="true" />
          </button>

          {hasOverage && (
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss usage limit banner"
              className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-secondary/70 transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
