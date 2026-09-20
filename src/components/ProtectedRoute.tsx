import { ReactNode, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { trackActivity, getIdleMinutes } from '@/lib/enterpriseSecurity';

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
          await supabase.auth.signOut();
          window.location.href = '/login';
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

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  useSessionPolicyEnforcement(Boolean(session));

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
          <p className="text-sm text-text-secondary">Loading your dashboard…</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}
