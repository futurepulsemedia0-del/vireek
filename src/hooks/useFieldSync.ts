// src/hooks/useFieldSync.ts
// React bindings for the offline field engine.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { subscribeData } from '@/lib/offline/db';
import { clearCachedIdentity, getCachedIdentity, setCachedIdentity, type CachedIdentity } from '@/lib/offline/identity';
import { getSyncState, startFieldEngine, subscribeSync, type SyncState } from '@/lib/offline/sync';

/** Changes every time local field data changes: use it as an effect dependency to re-read the device. */
export function useFieldVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeData(() => setVersion((n) => n + 1)), []);
  return version;
}

/** Live sync state: online, pending / failed / conflict counts, last sync time. */
export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
}

/** Works out (and caches) whether this user is a technician. Offline, the cached answer is used. */
export async function resolveIdentity(userId: string): Promise<CachedIdentity | null> {
  const cached = getCachedIdentity();
  const fallback = cached?.userId === userId ? cached : null;
  try {
    const { data, error } = await supabase.rpc('get_my_team_member_id');
    if (error) return fallback;
    if (!data) {
      clearCachedIdentity();
      return null;
    }
    const identity: CachedIdentity = { userId, teamMemberId: String(data) };
    setCachedIdentity(identity);
    return identity;
  } catch {
    return fallback;
  }
}

/** Starts the background sync engine for a signed-in technician; stops it on sign-out / unmount. */
export function useFieldEngine(): void {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    let stop: (() => void) | null = null;
    void resolveIdentity(userId)
      .then((identity) => {
        if (!cancelled && identity) stop = startFieldEngine();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [userId]);
}
