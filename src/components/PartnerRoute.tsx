import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';

/**
 * Gates every /partner-portal/* route (except /partner-portal/apply, which
 * is reachable with no partner row yet — see App.tsx). Anyone signed in
 * with SOME partners row (pending, approved, rejected or suspended) is let
 * through; each page decides what to render for its own status, the same
 * way AcademyCertificatePage decides based on lesson-completion state
 * rather than the route guard doing it.
 */
export function PartnerRoute({ children }: { children: ReactNode }) {
  const { session, user, loading: authLoading } = useAuth();
  const location = useLocation();
  const [hasApplication, setHasApplication] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) {
      setHasApplication(false);
      return;
    }
    let cancelled = false;
    supabase
      .from('partners')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setHasApplication(Boolean(data?.id));
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (authLoading || (session && hasApplication === null)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!hasApplication) return <Navigate to="/partner-portal/apply" replace />;

  return <>{children}</>;
}
