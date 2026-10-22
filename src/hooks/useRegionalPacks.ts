import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchEnabledPacks, setRegionalPack } from '@/lib/regionalPacksApi';
import type { PackCode } from '@/lib/regionalPacks/packTypes';

export type PacksStatus = 'loading' | 'ready' | 'error';

/** Which regional packs the signed-in tenant has enabled. */
export function useRegionalPacks() {
  const [packs, setPacks] = useState<PackCode[]>([]);
  const [status, setStatus] = useState<PacksStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const next = await fetchEnabledPacks();
      if (!alive.current) return;
      setPacks(next);
      setError(null);
      setStatus('ready');
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : 'Could not load regional packs.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; };
  }, [reload]);

  const toggle = useCallback(async (code: PackCode, enabled: boolean) => {
    await setRegionalPack(code, enabled);
    await reload();
  }, [reload]);

  return useMemo(
    () => ({ packs, status, error, reload, toggle, isEnabled: (c: PackCode) => packs.includes(c) }),
    [packs, status, error, reload, toggle],
  );
}
