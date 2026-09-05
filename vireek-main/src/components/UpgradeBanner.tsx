import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Rocket,
  Sparkles,
  X,
  Phone,
  CalendarClock,
  RefreshCw,
  ShieldAlert,
  Zap,
  ArrowRight,
  Loader as Loader2,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

// ============================================================
// CONFIG
// ============================================================

/**
 * localStorage key prefix used to persist the "dismissed" choice on this
 * device. Suffixed with the user's id so dismissing the banner on one
 * account never hides it for a different account signing in on the same
 * browser (e.g. testing with email, then with Google).
 */
const DISMISS_STORAGE_PREFIX = 'vireek-upgrade-banner-dismissed-v1';

/** Where the primary CTA sends the user. Reuses the existing billing route. */
const UPGRADE_ROUTE = '/dashboard/billing';

/** Plan id(s) that should see the banner. Everything else is treated as paid. */
const FREE_PLAN_ID: string = 'starter';

interface UpgradeHighlight {
  icon: typeof Phone;
  label: string;
}

const UPGRADE_HIGHLIGHTS: UpgradeHighlight[] = [
  { icon: Phone, label: 'AI Receptionist' },
  { icon: CalendarClock, label: 'Appointment Booking' },
  { icon: RefreshCw, label: 'CRM Sync' },
  { icon: ShieldAlert, label: 'Emergency Dispatch' },
  { icon: Zap, label: 'Advanced Automation' },
];

// ============================================================
// DISMISSAL PERSISTENCE
// ============================================================
//
// Kept as small, isolated functions (rather than inlined in the component)
// so the storage strategy can later be swapped for a Supabase-backed one
// — e.g. a `upgrade_banner_dismissed_at` column on `profiles` — without
// touching any rendering logic below. `refreshProfile()` from AuthContext
// already exists for that future wiring.

function readDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISS_STORAGE_PREFIX}:${userId}`) === '1';
  } catch {
    // Storage may be unavailable (Safari private mode, disabled cookies, etc).
    // Fail open to "not dismissed" — worst case the banner reappears.
    return false;
  }
}

function persistDismissed(userId: string) {
  try {
    window.localStorage.setItem(`${DISMISS_STORAGE_PREFIX}:${userId}`, '1');
  } catch {
    // Non-fatal: the banner simply won't remember the dismissal this session.
  }
}

/**
 * Encapsulates all "should the banner show" logic:
 * - only Free (starter) plan users
 * - not while the profile is still loading (avoids a flash for paid users)
 * - not if this specific user previously dismissed it on this device
 */
function useUpgradeBannerVisibility() {
  const { user, profile, profileLoading } = useAuth();
  const [dismissed, setDismissed] = useState<boolean>(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!user) {
      setHydrated(false);
      return;
    }
    setDismissed(readDismissed(user.id));
    setHydrated(true);
  }, [user]);

  const isFreePlan = profile?.plan === FREE_PLAN_ID;
  const visible = hydrated && !profileLoading && isFreePlan && !dismissed;

  const dismiss = useCallback(() => {
    if (!user) return;
    persistDismissed(user.id);
    setDismissed(true);
  }, [user]);

  return { visible, dismiss };
}

// ============================================================
// COMPONENT
// ============================================================

export function UpgradeBanner() {
  const { visible, dismiss } = useUpgradeBannerVisibility();
  const navigate = useNavigate();
  const [navigating, setNavigating] = useState(false);

  const handleUpgrade = useCallback(() => {
    setNavigating(true);
    navigate(UPGRADE_ROUTE);
  }, [navigate]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.98, transition: { duration: 0.2 } }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          role="region"
          aria-label="Upgrade to the Professional plan"
          className="relative mb-6 overflow-hidden rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/10 via-bg-secondary to-cta/10 p-5 shadow-card backdrop-blur-xl dark:shadow-card-dark sm:p-6"
        >
          {/* Decorative ambient glow — purely visual, hidden from assistive tech */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-cta/20 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-14 -left-10 h-40 w-40 rounded-full bg-accent/20 blur-3xl"
          />

          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent">
                <Rocket size={22} strokeWidth={2.25} />
              </span>

              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
                  <Sparkles size={12} />
                  You&apos;re on the Vireek Free Plan
                </p>
                <h3 className="mt-1 text-base font-bold leading-snug text-text-primary sm:text-lg">
                  Upgrade to Professional and unlock:
                </h3>
                <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
                  {UPGRADE_HIGHLIGHTS.map(({ icon: Icon, label }) => (
                    <span
                      key={label}
                      className="flex items-center gap-1.5 text-xs font-medium text-text-secondary"
                    >
                      <Icon size={13} className="shrink-0 text-accent" />
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
              <button
                type="button"
                onClick={handleUpgrade}
                disabled={navigating}
                className="focus-ring flex items-center gap-2 whitespace-nowrap rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white shadow-glow-cta transition-all duration-150 ease-out hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {navigating ? (
                  <>
                    <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                    <span>Loading…</span>
                  </>
                ) : (
                  <>
                    Upgrade Plan
                    <ArrowRight size={15} aria-hidden="true" />
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss upgrade banner"
                className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-secondary/70 transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
