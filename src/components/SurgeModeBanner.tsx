import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { CloudLightning, X, ArrowRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';

/**
 * Site-wide dashboard banner for Surge/Storm Mode — mirrors the
 * self-contained fetch + localStorage-dismissal pattern of
 * `UpgradeBanner.tsx`, but reads `business_profile` (not `profiles`,
 * where UpgradeBanner's plan data lives) since surge state is a
 * business-profile setting configured on BusinessProfilePage.
 *
 * Dismissal is keyed by `surge_mode_activated_at`, not just the user id
 * — unlike the upgrade banner, a *new* surge event should always show
 * again even if a previous one was dismissed, so the key changes every
 * time the owner flips surge mode on.
 *
 * Mounted once in DashboardLayout (see DashboardNav.tsx), right under
 * <UpgradeBanner />.
 */

const DISMISS_STORAGE_PREFIX = 'vireek-surge-banner-dismissed-v1';

function dismissKey(userId: string, activatedAt: string): string {
  return `${DISMISS_STORAGE_PREFIX}:${userId}:${activatedAt}`;
}

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(key: string) {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Non-fatal — banner just won't remember the dismissal this session.
  }
}

interface SurgeState {
  active: boolean;
  note: string | null;
  activatedAt: string | null;
}

export function SurgeModeBanner() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [surge, setSurge] = useState<SurgeState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setSurge(null);
      return;
    }

    supabase
      .from('business_profile')
      .select('surge_mode_active, surge_mode_note, surge_mode_activated_at')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const active = !!data?.surge_mode_active;
        const activatedAt = data?.surge_mode_activated_at ?? null;
        setSurge({ active, note: data?.surge_mode_note ?? null, activatedAt });
        setDismissed(active && activatedAt ? readDismissed(dismissKey(user.id, activatedAt)) : false);
      })
      .catch(() => {
        if (!cancelled) setSurge(null);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const dismiss = useCallback(() => {
    if (!user || !surge?.activatedAt) return;
    persistDismissed(dismissKey(user.id, surge.activatedAt));
    setDismissed(true);
  }, [user, surge]);

  const visible = !!surge?.active && !dismissed;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25 }}
          className="mb-6 overflow-hidden rounded-2xl border border-cta/30 bg-cta/[0.07] shadow-card dark:shadow-card-dark"
        >
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cta/15 text-cta">
                <CloudLightning size={18} />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">Surge Mode is active</p>
                <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-text-secondary">
                  {surge?.note?.trim()
                    ? surge.note
                    : 'Sarah is prioritizing triage and keeping calls brief while volume is high.'}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              <button
                type="button"
                onClick={() => navigate('/dashboard/business-profile')}
                className="focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-cta transition-colors hover:bg-cta/10"
              >
                Manage <ArrowRight size={13} />
              </button>
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss"
                className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
