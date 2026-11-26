import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { RouteFallback } from '@/components/loading/RouteFallback';
import { useLoginAlert } from '@/hooks/useLoginAlert';
import { useMfaEnforcement } from '@/hooks/useMfaEnforcement';
import { useLegalAcceptance } from '@/hooks/useLegalAcceptance';
import { MfaGraceBanner } from '@/components/security/MfaGraceBanner';
import { LegalGraceBanner } from '@/components/security/LegalGraceBanner';
import { graceDeadline } from '@/lib/legalAcceptance';
import { SECURITY_SETTINGS_PATH } from '@/lib/mfaChallenge';
import { trackActivity, getIdleMinutes, getSessionAgeHours, clearSessionStart } from '@/lib/enterpriseSecurity';

/** Enforces the account's session policy (idle timeout / max session
 * length) and, when enabled, the IP allowlist — checked once per mount
 * and on a light interval, entirely client-side (see check-ip-policy
 * edge function for the server-side half of the IP check). */
function useSessionPolicyEnforcement(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    trackActivity();

    const activityEvents = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    activityEvents.forEach((ev) => window.addEventListener(ev, trackActivity, { passive: true }));

    const interval = setInterval(async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) return;

        const { data: policy } = await supabase.from('security_policies').select('*').maybeSingle();
        if (!policy) return;

        if (policy.session_idle_minutes > 0 && getIdleMinutes() > policy.session_idle_minutes) {
          clearSessionStart();
          await supabase.auth.signOut();
          window.location.href = '/login?reason=idle_timeout';
          return;
        }

        if (policy.session_max_hours > 0 && getSessionAgeHours() > policy.session_max_hours) {
          clearSessionStart();
          await supabase.auth.signOut();
          window.location.href = '/login?reason=session_expired';
          return;
        }
        if (policy.ip_restriction_enabled) {
          const { data, error } = await supabase.functions.invoke('check-ip-policy', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!error && data && data.enforced && data.allowed === false) {
            await supabase.auth.signOut();
            window.location.href = '/login';
          }
        }
      } catch {
        // Fail open — never lock a legitimate user out due to a network blip.
      }
    }, 60_000);

    return () => {
      activityEvents.forEach((ev) => window.removeEventListener(ev, trackActivity));
      clearInterval(interval);
    };
  }, [enabled]);
}

/** true = signed in at AAL1 but the account has a verified authenticator, so /mfa must run first. null = still checking. */
function useMfaPending(userId: string | null): boolean | null {
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => {
    if (!userId) {
      setPending(null);
      return;
    }
    let cancelled = false;
    supabase.auth.mfa
      .getAuthenticatorAssuranceLevel()
      .then(({ data }) => {
        if (!cancelled) setPending(!!data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2');
      })
      .catch(() => {
        if (!cancelled) setPending(false); // fail open on a network blip, like the policy checks above
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return pending;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  useSessionPolicyEnforcement(Boolean(session));
  const mfaPending = useMfaPending(session?.user?.id ?? null);
  const enforcement = useMfaEnforcement(session?.user?.id ?? null);
  const legal = useLegalAcceptance(session?.user?.id ?? null, location.pathname);
  useLoginAlert(Boolean(session));

  if (loading) {
    return <RouteFallback variant="data" fullScreen />;
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  if (mfaPending === null || enforcement.loading || legal.loading) {
    return <RouteFallback variant="data" fullScreen />;
  }

  if (mfaPending) {
    return <Navigate to="/mfa" state={{ from: location.pathname + location.search }} replace />;
  }
  if (enforcement.decision === 'must_enroll' && !location.pathname.startsWith(SECURITY_SETTINGS_PATH)) {
    return <Navigate to={`${SECURITY_SETTINGS_PATH}?mfa=required`} replace />;
  }
  if (legal.decision === 'must_accept') {
    // after MFA, before any product page: a material legal change must be accepted first
    return <Navigate to="/legal/accept" state={{ from: location.pathname + location.search }} replace />;
  }
  return (
    <>
      {enforcement.decision === 'grace' && <MfaGraceBanner daysLeft={enforcement.state?.days_left ?? null} />}
      {legal.decision !== 'must_accept' && !location.pathname.startsWith('/legal/accept') && <LegalGraceBanner deadline={graceDeadline(legal.state)} />}
      {children}
    </>
  );
}
