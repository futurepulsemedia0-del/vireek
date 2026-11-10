import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFeatureFlags } from '@/hooks/useFeatureFlag';
import { fetchPestOpsEnabled } from '@/lib/pestOpsApi';

export interface PestOpsAccess {
  /** False until both the flag list and the server check have answered. */
  ready: boolean;
  /** Flag `pest_pack` AND entitlement `packs:pest`, confirmed server-side. Fails closed. */
  enabled: boolean;
}

/**
 * Cheap client gate (flag) first so a tenant without the flag never even calls the server; the
 * server (pest_ops_enabled) is the real wall — every RPC re-checks it.
 */
export function usePestOpsAccess(): PestOpsAccess {
  const { user } = useAuth();
  const { ready: flagsReady, isEnabled } = useFeatureFlags();
  const flagOn = isEnabled('pest_pack');
  const [server, setServer] = useState<{ uid: string; value: boolean } | null>(null);
  const uid = user?.id ?? null;

  useEffect(() => {
    let live = true;
    if (!uid || !flagsReady || !flagOn) return;
    void fetchPestOpsEnabled().then((value) => {
      if (live) setServer({ uid, value });
    });
    return () => {
      live = false;
    };
  }, [uid, flagsReady, flagOn]);

  if (!uid || !flagsReady) return { ready: false, enabled: false };
  if (!flagOn) return { ready: true, enabled: false };
  if (server?.uid !== uid) return { ready: false, enabled: false };
  return { ready: true, enabled: server.value };
}
