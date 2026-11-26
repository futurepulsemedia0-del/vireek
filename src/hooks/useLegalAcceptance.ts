import { useCallback, useEffect, useState } from 'react';
import { decideLegalGate, type LegalAcceptanceState, type LegalGateDecision } from '@/lib/legalAcceptance';
import { fetchLegalAcceptanceState } from '@/lib/legalAcceptanceApi';

// Every protected route mounts its own ProtectedRoute, so without a cache each navigation would re-run the RPC and
// flash a spinner. Only a clean "ok" is cached, and only for a few minutes: a pending acceptance is always re-checked.
const OK_TTL_MS = 5 * 60 * 1000;
let okCache: { userId: string; at: number } | null = null;

export function clearLegalAcceptanceCache(): void {
  okCache = null;
}

/**
 * Fails OPEN when the state cannot be read (network blip, RPC not deployed yet): the gate is a routing convenience,
 * the acceptance record itself is written server-side. Same trade-off as useMfaEnforcement.
 */
export function useLegalAcceptance(userId: string | null, pathname: string) {
  const cached = userId !== null && okCache !== null && okCache.userId === userId && Date.now() - okCache.at < OK_TTL_MS;
  const [res, setRes] = useState<{ loading: boolean; state: LegalAcceptanceState | null }>({ loading: !cached, state: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!userId) {
      setRes({ loading: false, state: null });
      return;
    }
    if (nonce === 0 && okCache !== null && okCache.userId === userId && Date.now() - okCache.at < OK_TTL_MS) {
      setRes({ loading: false, state: null });
      return;
    }
    let cancelled = false;
    setRes((p) => ({ ...p, loading: true }));
    fetchLegalAcceptanceState().then(
      (state) => {
        if (state && state.decision === 'ok' && state.required.length === 0) okCache = { userId, at: Date.now() };
        else okCache = null;
        if (!cancelled) setRes({ loading: false, state });
      },
      () => { if (!cancelled) setRes({ loading: false, state: null }); },
    );
    return () => { cancelled = true; };
  }, [userId, nonce]);

  const refresh = useCallback(() => { clearLegalAcceptanceCache(); setNonce((n) => n + 1); }, []);
  const decision: LegalGateDecision = decideLegalGate(res.state, pathname);
  return { loading: res.loading, state: res.state, decision, refresh };
}
