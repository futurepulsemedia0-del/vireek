import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { bootstrap, fetchOverview, HomeownerApiError, signOutHomeowner } from '@/lib/homeowner/api';
import type { HomeOverview } from '@/lib/homeowner/types';

type Status = 'loading' | 'signed_out' | 'ready' | 'error' | 'blocked';

interface HomeownerContextValue {
  status: Status;
  userId: string | null;
  overview: HomeOverview | null;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const HomeownerContext = createContext<HomeownerContextValue | undefined>(undefined);

export function HomeownerAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [userId, setUserId] = useState<string | null>(null);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const userIdRef = useRef<string | null>(null);

  // Only the most recently started load may apply its result (same guard as AuthContext).
  const load = useCallback(async (uid: string, runBootstrap: boolean) => {
    const id = ++requestId.current;
    try {
      if (runBootstrap) await bootstrap();
      const data = await fetchOverview();
      if (id !== requestId.current) return;
      userIdRef.current = uid;
      setUserId(uid);
      setOverview(data);
      setError(null);
      setStatus('ready');
    } catch (err) {
      if (id !== requestId.current) return;
      if (err instanceof HomeownerApiError && err.code === 'forbidden') {
        setStatus('blocked');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load your home.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // Never await Supabase calls inside this callback (deadlocks the auth lock).
      if (event === 'SIGNED_OUT' || !session) {
        requestId.current++;
        userIdRef.current = null;
        setUserId(null);
        setOverview(null);
        setError(null);
        setStatus('signed_out');
        return;
      }
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
        const uid = session.user.id;
        setTimeout(() => void load(uid, true), 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [load]);

  const refresh = useCallback(async () => {
    if (userIdRef.current) await load(userIdRef.current, false);
  }, [load]);

  const signOut = useCallback(async () => {
    await signOutHomeowner();
  }, []);

  const value = useMemo(
    () => ({ status, userId, overview, error, refresh, signOut }),
    [status, userId, overview, error, refresh, signOut],
  );
  return <HomeownerContext.Provider value={value}>{children}</HomeownerContext.Provider>;
}

export function useHomeowner(): HomeownerContextValue {
  const ctx = useContext(HomeownerContext);
  if (!ctx) throw new Error('useHomeowner must be used inside <HomeownerAuthProvider>');
  return ctx;
}
