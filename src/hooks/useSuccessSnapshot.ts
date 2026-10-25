import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NUDGE_SNOOZE_DAYS,
  deriveSuccessView,
  nudgeKey,
  stepKey,
  type ItemState,
  type SuccessSnapshot,
  type SuccessView,
} from '@/lib/successTools';
import { clearItemState, fetchSuccessSnapshot, setItemState } from '@/lib/successToolsApi';

export type SuccessStatus = 'loading' | 'ready' | 'error';

const REFRESH_MIN_MS = 60_000;

/**
 * Loads the account's feature usage + this person's snooze/dismiss state and
 * derives adoption, playbooks and nudges. State changes are optimistic and
 * re-synced from the server if the write fails. Refreshes (at most once a
 * minute) when the tab regains focus so progress made elsewhere shows up.
 */
export function useSuccessSnapshot(opts: { maxNudges?: number } = {}) {
  const [snapshot, setSnapshot] = useState<SuccessSnapshot | null>(null);
  const [status, setStatus] = useState<SuccessStatus>('loading');
  const lastLoad = useRef(0);
  const alive = useRef(true);
  const maxNudges = opts.maxNudges;

  const load = useCallback(async (silent = false) => {
    if (!silent) setStatus('loading');
    try {
      const s = await fetchSuccessSnapshot();
      if (!alive.current) return;
      lastLoad.current = Date.now();
      setSnapshot(s);
      setStatus('ready');
    } catch {
      if (!alive.current) return;
      // A failed silent refresh keeps showing the last good data.
      setStatus((prev) => (silent && prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoad.current > REFRESH_MIN_MS) void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const view: SuccessView | null = useMemo(
    () => (snapshot ? deriveSuccessView(snapshot, new Date(), maxNudges) : null),
    [snapshot, maxNudges],
  );

  const patchState = useCallback((key: string, next: ItemState | null) => {
    setSnapshot((prev) => {
      if (!prev) return prev;
      const states = { ...prev.states };
      if (next) states[key] = next;
      else delete states[key];
      return { ...prev, states };
    });
  }, []);

  const write = useCallback(
    async (key: string, next: ItemState | null, persist: () => Promise<void>) => {
      patchState(key, next);
      try {
        await persist();
      } catch {
        void load(true); // roll back to the server's truth
      }
    },
    [load, patchState],
  );

  const snoozeNudge = useCallback(
    (featureKey: string, days = NUDGE_SNOOZE_DAYS) =>
      write(nudgeKey(featureKey), { status: 'snoozed', snoozedUntil: new Date(Date.now() + days * 86_400_000).toISOString() }, () =>
        setItemState(nudgeKey(featureKey), 'snoozed', days),
      ),
    [write],
  );

  const dismissNudge = useCallback(
    (featureKey: string) =>
      write(nudgeKey(featureKey), { status: 'dismissed', snoozedUntil: null }, () => setItemState(nudgeKey(featureKey), 'dismissed')),
    [write],
  );

  const skipStep = useCallback(
    (playbookId: string, stepId: string) =>
      write(stepKey(playbookId, stepId), { status: 'skipped', snoozedUntil: null }, () => setItemState(stepKey(playbookId, stepId), 'skipped')),
    [write],
  );

  const unskipStep = useCallback(
    (playbookId: string, stepId: string) => write(stepKey(playbookId, stepId), null, () => clearItemState(stepKey(playbookId, stepId))),
    [write],
  );

  return { status, snapshot, view, refresh: () => load(true), reload: () => load(false), snoozeNudge, dismissNudge, skipStep, unskipStep };
}
