import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchLeakData, type LeakData } from '@/lib/leakReportApi';

export type LeakState =
  | { status: 'forbidden' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: LeakData };

/** Shared by the dashboard card and the full page. pollMs > 0 refreshes quietly while the tab is visible. */
export function useLeakReport(pollMs = 0) {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const canAccess = isOwner || Boolean(permissions?.can_view_billing);
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const [state, setState] = useState<LeakState>({ status: canAccess ? 'loading' : 'forbidden' });
  const requestRef = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!canAccess) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!accountOwnerId) return;
      const id = ++requestRef.current;
      if (!silent) setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
      try {
        const data = await fetchLeakData(accountOwnerId);
        if (id === requestRef.current) setState({ status: 'ready', data });
      } catch (e) {
        if (id !== requestRef.current) return;
        const message = e instanceof Error ? e.message : 'Could not load the Leak Report.';
        setState((s) => (silent && s.status === 'ready' ? s : { status: 'error', message }));
      }
    },
    [accountOwnerId, canAccess],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => {
      if (!document.hidden) void load(true);
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, load]);

  return { state, reload: () => load(), accountOwnerId, canAccess };
}
