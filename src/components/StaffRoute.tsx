import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { RouteFallback } from '@/components/loading/RouteFallback';

export function StaffRoute({ children }: { children: ReactNode }) {
  const { session, user, loading: authLoading } = useAuth();
  const location = useLocation();
  const [isStaff, setIsStaff] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) {
      setIsStaff(false);
      return;
    }
    let cancelled = false;
    supabase
      .from('profiles')
      .select('is_staff')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setIsStaff(Boolean(data?.is_staff));
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (authLoading || (session && isStaff === null)) {
    return <RouteFallback variant="app" fullScreen />;
  }

  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!isStaff) return <Navigate to="/dashboard" replace />;

  return <>{children}</>;
}
