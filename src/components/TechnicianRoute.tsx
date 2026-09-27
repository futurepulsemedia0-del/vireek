import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';

export function TechnicianRoute({ children }: { children: ReactNode }) {
  const { session, user, loading: authLoading } = useAuth();
  const location = useLocation();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) {
      setAllowed(false);
      return;
    }
    let cancelled = false;
    Promise.all([
      supabase.rpc('get_my_team_member_id'),
      supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
    ]).then(([tmRes, profileRes]) => {
      if (cancelled) return;
      const isTechnician = Boolean(tmRes.data);
      const isOwnerOrAdmin = profileRes.data?.role === 'owner' || profileRes.data?.role === 'admin';
      setAllowed(isTechnician || isOwnerOrAdmin);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (authLoading || (session && allowed === null)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!allowed) return <Navigate to="/dashboard" replace />;

  return <>{children}</>;
}
