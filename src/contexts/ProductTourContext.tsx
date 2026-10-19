import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { trackEvent } from '@/lib/analytics';
import { loadProgress } from '@/lib/gettingStartedApi';
import {
  TIP_PREFIX, TOURS, beginRecord, clampStep, decideAutoStart, describeStatus, finishRecord, moveRecord,
  reconcileLegacy, resolveTourRole, tipRecord, visibleSteps,
  type RecordMap, type TourDef, type TourRecord, type TourRole, type TourStatusLabel, type TourStep,
} from '@/lib/productTours';
import { deleteTipRecords, loadTourRecords, saveTourRecord } from '@/lib/productToursApi';
import { TourOverlay } from '@/components/tour/TourOverlay';
import { TourResumePrompt } from '@/components/tour/TourResumePrompt';

export interface ProductTourContextValue {
  role: TourRole | null;
  tour: TourDef | null;
  status: TourStatusLabel;
  stepIndex: number;
  stepCount: number;
  completedAt: string | null;
  isActive: boolean;
  /** Smart entry point: resumes a paused tour, otherwise starts/replays. */
  startTour: () => void;
  /** Always restarts from step 1 (counted as a replay). */
  replayTour: () => void;
  tipsEnabled: boolean;
  dismissedTipCount: number;
  isTipDismissed: (id: string) => boolean;
  dismissTip: (id: string) => void;
  resetTips: () => void;
}

const noop = () => undefined;
const DEFAULT_VALUE: ProductTourContextValue = {
  role: null, tour: null, status: 'not_started', stepIndex: 0, stepCount: 0, completedAt: null, isActive: false,
  startTour: noop, replayTour: noop, tipsEnabled: false, dismissedTipCount: 0,
  isTipDismissed: () => false, dismissTip: noop, resetTips: noop,
};

const ProductTourContext = createContext<ProductTourContextValue>(DEFAULT_VALUE);

/** Safe outside the provider (public pages, isolated tests): returns an inert value. */
export function useProductTour(): ProductTourContextValue {
  return useContext(ProductTourContext);
}

const now = () => new Date().toISOString();
const AUTO_START_DELAY_MS = 700;

export function ProductTourProvider({ children }: { children: ReactNode }) {
  const { user, profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { pathname } = useLocation();
  const userId = user?.id ?? null;

  const role = useMemo<TourRole | null>(
    () =>
      profile
        ? resolveTourRole({ isOwner, profileRole: profile.role, teamRole: teamMember?.role ?? null })
        : null,
    [profile, isOwner, teamMember?.role],
  );
  const tour = role ? TOURS[role] : null;

  // AuthContext rebuilds `permissions` every render for team members → key off the resulting step ids.
  const stepsKey = tour ? visibleSteps(tour, { isOwner, permissions }).map((s) => s.id).join('|') : '';
  const steps = useMemo<readonly TourStep[]>(() => {
    if (!tour) return [];
    const ids = new Set(stepsKey.split('|'));
    return tour.steps.filter((s) => ids.has(s.id));
  }, [tour, stepsKey]);

  const tourRef = useRef(tour);
  tourRef.current = tour;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  const [records, setRecords] = useState<RecordMap>({});
  const recordsRef = useRef<RecordMap>({});
  const [loaded, setLoaded] = useState(false);
  const [legacyDone, setLegacyDone] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [snoozed, setSnoozed] = useState(false); // "not now" — lasts for this session only

  const replaceRecords = useCallback((next: RecordMap) => {
    recordsRef.current = next;
    setRecords(next);
  }, []);

  const commit = useCallback(
    (rec: TourRecord) => {
      replaceRecords({ ...recordsRef.current, [rec.tourId]: rec });
      if (userId) void saveTourRecord(userId, rec);
    },
    [userId, replaceRecords],
  );

  // Load progress whenever the signed-in person changes.
  useEffect(() => {
    setActiveIndex(null);
    setSnoozed(false);
    setLegacyDone(false);
    if (!userId) {
      replaceRecords({});
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      const [stored, legacy] = await Promise.all([
        loadTourRecords(userId).catch(() => ({}) as RecordMap),
        loadProgress(userId).catch(() => null),
      ]);
      if (cancelled) return;
      replaceRecords(stored);
      setLegacyDone(legacy?.tourCompleted === true);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, replaceRecords]);

  // People who finished the previous single tour are treated as done.
  useEffect(() => {
    if (!loaded || !userId || !tour) return;
    const rec = reconcileLegacy(recordsRef.current, tour, legacyDone, now());
    if (rec) commit(rec);
  }, [loaded, userId, tour, legacyDone, commit]);

  const begin = useCallback(
    (mode: 'auto' | 'resume' | 'replay') => {
      const def = tourRef.current;
      const list = stepsRef.current;
      if (!def || !userId || list.length === 0) return;
      const prev = recordsRef.current[def.id];
      if (mode === 'auto' && prev) return; // state changed while the start timer was pending
      const rec = beginRecord(prev, def, list.length, now(), mode);
      commit(rec);
      setSnoozed(false);
      setActiveIndex(rec.stepIndex);
      trackEvent(mode === 'auto' ? 'tour_started' : mode === 'resume' ? 'tour_resumed' : 'tour_replayed', {
        tour_id: def.id, version: def.version, step_count: list.length, step_index: rec.stepIndex,
      });
    },
    [userId, commit],
  );

  const goTo = useCallback(
    (next: number) => {
      const def = tourRef.current;
      const list = stepsRef.current;
      if (!def || list.length === 0) return;
      const index = clampStep(next, list.length);
      setActiveIndex(index);
      const rec = recordsRef.current[def.id];
      if (rec) commit(moveRecord(rec, index, list.length, now()));
      trackEvent('tour_step_viewed', { tour_id: def.id, step_id: list[index]?.id, step_index: index });
    },
    [commit],
  );

  const finish = useCallback(
    (status: 'completed' | 'skipped') => {
      const def = tourRef.current;
      if (!def) return;
      const count = stepsRef.current.length;
      const rec = recordsRef.current[def.id] ?? beginRecord(undefined, def, count, now(), 'auto');
      commit(finishRecord(rec, status, now()));
      setActiveIndex(null);
      setSnoozed(false);
      trackEvent(status === 'completed' ? 'tour_completed' : 'tour_skipped', {
        tour_id: def.id, version: def.version, step_index: rec.stepIndex, step_count: count,
      });
    },
    [commit],
  );

  const pause = useCallback(() => {
    const def = tourRef.current;
    setActiveIndex(null);
    setSnoozed(true);
    if (def) trackEvent('tour_paused', { tour_id: def.id, step_index: recordsRef.current[def.id]?.stepIndex ?? 0 });
  }, []);

  const record = tour ? records[tour.id] : undefined;
  const isActive = activeIndex !== null && !!tour && steps.length > 0;

  const action = decideAutoStart({
    loaded,
    signedIn: !!userId,
    profileReady: !profileLoading && !!profile,
    onboardingCompleted: profile?.onboarding_completed === true,
    tour,
    record,
    pathname,
    isActive,
    snoozed,
  });

  useEffect(() => {
    if (action !== 'start') return;
    const timer = window.setTimeout(() => begin('auto'), AUTO_START_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [action, begin]);

  // Tips
  const dismissedTips = useMemo(
    () =>
      new Set(
        Object.keys(records).filter((k) => k.startsWith(TIP_PREFIX)).map((k) => k.slice(TIP_PREFIX.length)),
      ),
    [records],
  );
  const dismissTip = useCallback(
    (id: string) => {
      commit(tipRecord(id, now()));
      trackEvent('tip_dismissed', { tip_id: id });
    },
    [commit],
  );
  const resetTips = useCallback(() => {
    if (!userId) return;
    replaceRecords(Object.fromEntries(Object.entries(recordsRef.current).filter(([k]) => !k.startsWith(TIP_PREFIX))));
    void deleteTipRecords(userId);
    trackEvent('tips_reset');
  }, [userId, replaceRecords]);

  const status = describeStatus(record);
  const startTour = useCallback(() => {
    const current = describeStatus(tourRef.current ? recordsRef.current[tourRef.current.id] : undefined);
    begin(current === 'in_progress' ? 'resume' : current === 'not_started' ? 'auto' : 'replay');
  }, [begin]);
  const replayTour = useCallback(() => begin('replay'), [begin]);

  const value = useMemo<ProductTourContextValue>(
    () => ({
      role,
      tour,
      status,
      stepIndex: record?.stepIndex ?? 0,
      stepCount: steps.length,
      completedAt: record?.completedAt ?? null,
      isActive,
      startTour,
      replayTour,
      // Tips wait until the person has met the tour (done, skipped or paused) and it's not on screen.
      tipsEnabled: loaded && !!tour && !isActive && status !== 'not_started',
      dismissedTipCount: dismissedTips.size,
      isTipDismissed: (id: string) => dismissedTips.has(id),
      dismissTip,
      resetTips,
    }),
    [role, tour, status, record, steps.length, isActive, loaded, dismissedTips, startTour, replayTour, dismissTip, resetTips],
  );

  return (
    <ProductTourContext.Provider value={value}>
      {children}
      {activeIndex !== null && tour && steps.length > 0 && (
        <TourOverlay
          tourId={tour.id}
          steps={steps}
          index={clampStep(activeIndex, steps.length)}
          finishCta={tour.finishCta}
          onStep={goTo}
          onPause={pause}
          onSkip={() => finish('skipped')}
          onFinish={() => finish('completed')}
        />
      )}
      {action === 'resume-prompt' && tour && (
        <TourResumePrompt
          stepIndex={record?.stepIndex ?? 0}
          stepCount={steps.length}
          onResume={() => begin('resume')}
          onLater={() => setSnoozed(true)}
          onDismiss={() => finish('skipped')}
        />
      )}
    </ProductTourContext.Provider>
  );
}
