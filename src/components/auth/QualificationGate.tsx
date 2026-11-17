import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { fetchQualificationStatus, isQualificationDismissed } from '@/lib/signupQualification';
import { QUALIFICATION_ROUTE, shouldPromptQualification } from '@/lib/signupQualificationCore';

/** Wraps /dashboard. Sends brand-new account owners to the 3-question step once. Fails open. */
export function QualificationGate({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const userId = user?.id ?? null;

  const eligible = useMemo(
    () =>
      !!userId &&
      !!profile &&
      shouldPromptQualification({
        role: profile.role,
        createdAt: profile.created_at,
        onboardingCompleted: profile.onboarding_completed,
        now: Date.now(),
      }) &&
      !isQualificationDismissed(userId),
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
    void fetchQualificationStatus(userId).then((status) => {
      if (cancelled) return;
      if (status === 'pending') navigate(QUALIFICATION_ROUTE, { replace: true });
      else setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [eligible, userId, navigate]);

  if (eligible && !ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    );
  }
  return <>{children}</>;
}
