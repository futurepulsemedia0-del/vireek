import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { CHANGELOG_RELEASES } from '@/lib/changelog';
import { buildReleases, unreadReleaseIds, type Release } from '@/lib/whatsNew';
import { fetchReadReleaseIds, markReleasesRead } from '@/lib/whatsNewApi';

// Static data: built once. A new release ships with a deploy, so a page reload picks it up.
const RELEASES = buildReleases(CHANGELOG_RELEASES);

type Status = 'loading' | 'ready' | 'error';

interface WhatsNewValue {
  status: Status;
  releases: Release[];
  unreadIds: string[];
  unreadCount: number;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  reload: () => void;
}

const WhatsNewContext = createContext<WhatsNewValue | undefined>(undefined);

/**
 * One provider shared by every consumer — DashboardNav mounts two header buttons at once
 * (desktop sidebar + mobile header), and they must stay in sync off a single fetch.
 */
export function WhatsNewProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const userId = user?.id ?? null;
  const accountCreatedAt = user?.created_at ?? null;

  const [status, setStatus] = useState<Status>('loading');
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  const readIdsRef = useRef(readIds);
  readIdsRef.current = readIds;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setStatus('loading');
    fetchReadReleaseIds()
      .then((ids) => {
        if (cancelled) return;
        setReadIds(ids);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

  const unreadIds = useMemo(
    () => (status === 'ready' ? unreadReleaseIds(RELEASES, readIds, { accountCreatedAt }) : []),
    [status, readIds, accountCreatedAt],
  );

  const markRead = useCallback(
    async (ids: string[]) => {
      if (!userId) return;
      const fresh = ids.filter((id) => !readIdsRef.current.has(id));
      if (fresh.length === 0) return;
      // Optimistic: the badge clears immediately; roll back only these ids if saving fails.
      setReadIds((cur) => new Set([...Array.from(cur), ...fresh]));
      try {
        await markReleasesRead(userId, fresh);
      } catch {
        setReadIds((cur) => {
          const next = new Set(cur);
          fresh.forEach((id) => next.delete(id));
          return next;
        });
        toast('Could not save your read status — try again', 'error');
      }
    },
    [userId, toast],
  );

  const markAllRead = useCallback(() => markRead(unreadIds), [markRead, unreadIds]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const value = useMemo<WhatsNewValue>(
    () => ({ status, releases: RELEASES, unreadIds, unreadCount: unreadIds.length, markRead, markAllRead, reload }),
    [status, unreadIds, markRead, markAllRead, reload],
  );

  return <WhatsNewContext.Provider value={value}>{children}</WhatsNewContext.Provider>;
}

export function useWhatsNew() {
  const ctx = useContext(WhatsNewContext);
  if (!ctx) throw new Error('useWhatsNew must be used inside <WhatsNewProvider>');
  return ctx;
}
