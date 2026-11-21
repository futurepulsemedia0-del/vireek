import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { getPlanStateCached, type PlanOnboardingState } from '@/lib/planOnboarding/api';
import { showResumeBanner } from '@/lib/planOnboarding/gate';
import { PLAN_STEP_PATH } from '@/lib/planOnboarding/intent';
import { usePlanStepT } from '@/i18n/planStepNamespace';

const DISMISS_KEY = 'vireek_plan_banner_dismissed_v1';

/** Dashboard banner: left the plan step half-way, or chose "skip for now" (limited access). Dismissible for this tab. */
export function PlanResumeBanner() {
  const { t } = usePlanStepT();
  const { user, profile } = useAuth();
  const { pathname } = useLocation();
  const [state, setState] = useState<PlanOnboardingState | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const userId = user?.id ?? null;
  const owner = profile?.role === 'owner';

  useEffect(() => {
    if (!userId || !owner) return;
    let cancelled = false;
    void getPlanStateCached(userId).then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, owner, pathname]);

  if (!state || dismissed || !showResumeBanner(state, pathname)) return null;
  const key = state.step === 'checkout' ? 'checkout' : state.step === 'skipped' ? 'skipped' : 'plan';

  return (
    <section aria-label={t('banner.label')} className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3">
      <div>
        <p className="text-sm font-semibold text-text-primary">{t(`banner.${key}.title`)}</p>
        <p className="text-sm text-text-secondary">{t(`banner.${key}.body`)}</p>
      </div>
      <div className="flex items-center gap-2">
        <Link to={PLAN_STEP_PATH} className="focus-ring inline-flex min-h-[44px] items-center rounded-control bg-accent px-4 text-sm font-medium text-white">{t(`banner.${key}.cta`)}</Link>
        <button
          type="button"
          className="focus-ring min-h-[44px] rounded-control px-3 text-sm text-text-secondary"
          onClick={() => {
            setDismissed(true);
            try {
              window.sessionStorage.setItem(DISMISS_KEY, '1');
            } catch {
              /* non-fatal */
            }
          }}
        >
          {t('banner.dismiss')}
        </button>
      </div>
    </section>
  );
}
