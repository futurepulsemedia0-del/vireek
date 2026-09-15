import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { TriangleAlert as AlertTriangle, ArrowRight, Ban } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

// ============================================================
// PaymentFailedBanner
// ============================================================
//
// Site-wide dashboard banner for the dunning flow — mirrors the
// self-contained, DashboardLayout-mounted pattern of UpgradeBanner /
// SurgeModeBanner (see DashboardNav.tsx), reading the dunning columns
// added to `profiles` by the 20260915000000_dunning_management.sql
// migration and kept in sync by the `stripe-webhook` edge function.
//
// Deliberately NOT dismissible, unlike UpgradeBanner: this is a "your
// service is about to stop working" warning, not a marketing nudge, so it
// stays visible on every dashboard page for as long as the account is
// past_due or suspended. That's a standard, expected pattern for billing
// issues (Stripe, Notion, Slack, etc. all do the same) — smuggling in a
// dismiss button here would just mean customers get suspended without
// ever having gotten a clear signal why.
const ROUTE = '/dashboard/billing/update-payment';

export function PaymentFailedBanner() {
  const { profile, profileLoading } = useAuth();
  const navigate = useNavigate();

  const daysLeft = useMemo(() => {
    if (!profile?.payment_grace_period_ends_at) return null;
    const ms = new Date(profile.payment_grace_period_ends_at).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }, [profile?.payment_grace_period_ends_at]);

  if (profileLoading || !profile) return null;

  const isSuspended = profile.subscription_status === 'suspended';
  const isPastDue = profile.subscription_status === 'past_due';
  if (!isSuspended && !isPastDue) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        role="alert"
        aria-live="polite"
        className={`relative mb-6 flex flex-col gap-4 overflow-hidden rounded-2xl border p-5 shadow-card dark:shadow-card-dark sm:flex-row sm:items-center sm:justify-between sm:p-6 ${
          isSuspended ? 'border-danger/30 bg-danger/10' : 'border-warning-500/30 bg-warning-500/10'
        }`}
      >
        <div className="flex items-start gap-4">
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white ${
              isSuspended ? 'bg-danger' : 'bg-warning-500'
            }`}
          >
            {isSuspended ? <Ban size={22} strokeWidth={2.25} /> : <AlertTriangle size={22} strokeWidth={2.25} />}
          </span>

          <div className="min-w-0">
            <p
              className={`text-xs font-semibold uppercase tracking-wider ${
                isSuspended ? 'text-danger' : 'text-warning-500'
              }`}
            >
              {isSuspended ? 'Account suspended' : 'Payment failed'}
            </p>
            <h3 className="mt-1 text-base font-bold leading-snug text-text-primary sm:text-lg">
              {isSuspended
                ? "Sarah has stopped answering calls for your business"
                : `Update your card${daysLeft !== null ? ` — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : ''}`}
            </h3>
            <p className="mt-1 text-sm text-text-secondary">
              {isSuspended
                ? 'Add a new payment method to restore service immediately.'
                : profile.last_payment_error ||
                  "We couldn't charge your card on file. Update it to avoid any interruption."}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => navigate(ROUTE)}
          className={`focus-ring flex shrink-0 items-center justify-center gap-2 self-end whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-semibold text-white shadow-glow-cta transition-all duration-150 ease-out hover:brightness-110 active:brightness-95 sm:self-center ${
            isSuspended ? 'bg-danger' : 'bg-cta'
          }`}
        >
          Update payment method
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </motion.div>
    </AnimatePresence>
  );
}
