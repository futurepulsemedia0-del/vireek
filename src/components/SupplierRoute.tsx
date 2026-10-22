import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { fetchMySupplier } from '@/lib/procurementNetworkApi';

type State = 'loading' | 'anonymous' | 'no-supplier' | 'supplier';

/**
 * Guard for the Supplier Portal.
 *  - requireSupplier (default): signed-in user who belongs to a supplier organisation.
 *  - requireSupplier={false}: any signed-in user (used by the application form).
 * Real authorisation is enforced by RLS / RPCs; this only decides where to send the user.
 */
export function SupplierRoute({ children, requireSupplier = true }: { children: React.ReactNode; requireSupplier?: boolean }) {
  const [state, setState] = useState<State>('loading');
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return !cancelled && setState('anonymous');
      if (!requireSupplier) return !cancelled && setState('supplier');
      try {
        const m = await fetchMySupplier();
        if (!cancelled) setState(m ? 'supplier' : 'no-supplier');
      } catch {
        if (!cancelled) setState('no-supplier');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requireSupplier]);

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary" role="status" aria-label="Loading">
        <Loader2 className="animate-spin text-text-secondary" />
      </div>
    );
  }
  if (state === 'anonymous') return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />;
  if (state === 'no-supplier') return <Navigate to="/supplier-portal/apply" replace />;
  return <>{children}</>;
}
