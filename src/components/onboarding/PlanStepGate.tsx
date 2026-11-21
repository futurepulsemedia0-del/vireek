import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { getPlanStateCached } from '@/lib/planOnboarding/api';
import { isLikelyNewAccount, shouldRedirectToPlanStep } from '@/lib/planOnboarding/gate';
import { PLAN_STEP_PATH } from '@/lib/planOnboarding/intent';

/**
 * Wraps /dashboard (outside QualificationGate). Sends brand-new account OWNERS without a subscription to /onboarding/plan.
 * One place covers every way in: OTP, email link, Google/Apple, a later login, another device.
 * Team members, existing subscribers and accounts older than the gate never see it. Fails OPEN: any error shows the dashboard.
 */
export function PlanStepGate({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const userId = user?.id ?? null;

  const eligible = useMemo(
    () => !!userId && !!profile && profile.role === 'owner' && isLikelyNewAccount(profile.created_at, Date.now()),
    [userId, profile],
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!eligible || !userId) {
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    void getPlanStateCached(userId).then((state) => {
      if (cancelled) return;
      if (shouldRedirectToPlanStep(state, pathname)) navigate(PLAN_STEP_PATH, { replace: true });
      else setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [eligible, userId, pathname, navigate]);

  if (eligible && !ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary" role="status" aria-live="polite">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }
  return <>{children}</>;
}
