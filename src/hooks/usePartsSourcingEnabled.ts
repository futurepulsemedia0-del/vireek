// Recreated: verify against original intent
// Whether the Parts Sourcing module is on for the signed-in account. `ready` is false until the first answer.
// The answer is cached per signed-in user (so switching accounts never reuses another account's answer) and
// concurrent callers (nav + page) share one request. Fails closed: any error means "not enabled".
import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { isPartsSourcingEnabled } from '@/lib/partsSourcingApi';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: boolean }>();
const inflight = new Map<string, Promise<boolean>>();

function lookup(userId: string): Promise<boolean> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value);
  const pending = inflight.get(userId);
  if (pending) return pending;
  const p = isPartsSourcingEnabled()
    .catch(() => false)
    .then((value) => {
      cache.set(userId, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

export function usePartsSourcingEnabled(): { enabled: boolean; ready: boolean } {
  const { user } = useAuth();
  const userId: string | null = user?.id ?? null;
  const [state, setState] = useState<{ userId: string | null; enabled: boolean; ready: boolean }>({ userId, enabled: false, ready: false });

  useEffect(() => {
    if (!userId) {
      setState({ userId: null, enabled: false, ready: true });
      return;
    }
    let alive = true;
    setState((s) => (s.userId === userId ? s : { userId, enabled: false, ready: false }));
    void lookup(userId).then((enabled) => {
      if (alive) setState({ userId, enabled, ready: true });
    });
    return () => {
      alive = false;
    };
  }, [userId]);

  // Never expose a previous user's answer while the new user's lookup is still running.
  return state.userId === userId ? { enabled: state.enabled, ready: state.ready } : { enabled: false, ready: false };
}
