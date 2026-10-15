import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  buildChecklist,
  STEPS,
  summarize,
  isVisibleTo,
  type StepKey,
  type StepView,
  type Summary,
} from '@/lib/gettingStarted';
import { EMPTY_PROGRESS, fetchSignals, loadProgress, saveProgress, type ProgressState } from '@/lib/gettingStartedApi';

export type GettingStartedStatus = 'loading' | 'ready' | 'error';

export interface UseGettingStarted {
  status: GettingStartedStatus;
  steps: StepView[];
  summary: Summary;
  progress: ProgressState;
  refreshing: boolean;
  refresh: () => Promise<void>;
  skipStep: (key: StepKey) => void;
  unskipStep: (key: StepKey) => void;
  setDismissed: (dismissed: boolean) => void;
  setTourCompleted: (completed: boolean) => void;
}

/**
 * Single source of truth for the checklist, shared by the page, the overview
 * card and the first-run tour. Progress is re-detected whenever the tab regains
 * focus, so finishing a step in another page updates the checklist on return.
 */
export function useGettingStarted(): UseGettingStarted {
  const { user, profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const userId = user?.id;
  // Same resolution NotificationsContext uses: team members read the OWNER's data.
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [status, setStatus] = useState<GettingStartedStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [signals, setSignals] = useState<Parameters<typeof buildChecklist>[0] | null>(null);
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const requestRef = useRef(0);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  // AuthContext rebuilds `permissions` on every render for team members, so key
  // off a stable string of visible step keys to avoid refetch loops.
  const wantedKey = STEPS.filter((s) => isVisibleTo(s, { isOwner, permissions }))
    .map((s) => s.key)
    .join(',');
  const wanted = useMemo(() => new Set(wantedKey.split(',').filter(Boolean) as StepKey[]), [wantedKey]);

  const load = useCallback(
    async (initial: boolean) => {
      if (!userId || !ownerId) return;
      const requestId = ++requestRef.current;
      if (initial) setStatus('loading');
      else setRefreshing(true);
      try {
        const [nextSignals, nextProgress] = await Promise.all([
          fetchSignals(ownerId, wanted),
          initial ? loadProgress(userId) : Promise.resolve(progressRef.current),
        ]);
        if (requestId !== requestRef.current) return; // a newer load superseded this one
        // Every visible source failed: show the error state instead of a wall of "unknown".
        const allFailed = [...wanted].every((k) => nextSignals[k] === null);
        if (allFailed && wanted.size > 0) {
          setStatus('error');
        } else {
          setSignals(nextSignals);
          setProgress(nextProgress);
          setStatus('ready');
        }
      } catch {
        if (requestId === requestRef.current) setStatus('error');
      } finally {
        if (requestId === requestRef.current) setRefreshing(false);
      }
    },
    [userId, ownerId, wanted],
  );

  useEffect(() => {
    if (profileLoading) return;
    void load(true);
  }, [load, profileLoading]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const update = useCallback(
    (patch: Partial<ProgressState>) => {
      if (!userId) return;
      const next = { ...progressRef.current, ...patch };
      setProgress(next); // optimistic — saveProgress already persists locally first
      void saveProgress(userId, next);
    },
    [userId],
  );

  const steps = useMemo(
    () => (signals ? buildChecklist(signals, progress.skipped, { isOwner, permissions }) : []),
    [signals, progress.skipped, isOwner, permissions],
  );
  const summary = useMemo(() => summarize(steps), [steps]);

  return {
    status,
    steps,
    summary,
    progress,
    refreshing,
    refresh: () => load(false),
    skipStep: (key) => update({ skipped: [...new Set([...progressRef.current.skipped, key])] }),
    unskipStep: (key) => update({ skipped: progressRef.current.skipped.filter((k) => k !== key) }),
    setDismissed: (checklistDismissed) => update({ checklistDismissed }),
    setTourCompleted: (tourCompleted) => update({ tourCompleted }),
  };
}
