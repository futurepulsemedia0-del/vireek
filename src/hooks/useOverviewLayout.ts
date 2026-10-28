import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyPresetLayout,
  buildPresetLayout,
  moveWidget,
  moveWidgetBy,
  resizeWidget,
  sanitizeLayout,
  setWidgetHidden,
  type OverviewLayout,
  type OverviewPresetId,
  type OverviewWidgetId,
  type PermissionKey,
} from '@/lib/overviewLayout';
import { deleteOverviewLayout, fetchOverviewLayout, saveOverviewLayout } from '@/lib/overviewLayoutApi';
import { fetchRoleLayout } from '@/lib/dashboardRoleLayoutsApi';
import { resolveBaseLayout } from '@/lib/dashboardRoleLayouts';

export type LayoutSaveState = 'idle' | 'saving' | 'saved' | 'error';

const SAVE_DEBOUNCE_MS = 700;

interface Options {
  userId: string | undefined;
  defaultPreset: OverviewPresetId;
  /** Account owner's id. Lets people who never customized inherit the layout their account published for their role. */
  accountOwnerId?: string | null;
  can: (p: PermissionKey) => boolean;
}

/**
 * Loads, edits and persists the user's Overview layout in Supabase.
 * Edits are optimistic and saved with a debounce; `flush()` forces the pending
 * save (called when leaving edit mode and on unmount).
 */
export function useOverviewLayout({ userId, defaultPreset, accountOwnerId, can }: Options) {
  const [layout, setLayout] = useState<OverviewLayout>(() => buildPresetLayout(defaultPreset));
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<LayoutSaveState>('idle');
  const [loadFailed, setLoadFailed] = useState(false);

  const layoutRef = useRef(layout);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const baseRef = useRef<OverviewLayout>(buildPresetLayout(defaultPreset));
  const canRef = useRef(can);
  canRef.current = can;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setReady(false);
    setLoadFailed(false);
    // Layout the account published for this role (Dashboard Builder). Not fatal when it
    // cannot be read: the built-in preset applies instead.
    const roleLayout: Promise<unknown> = accountOwnerId
      ? fetchRoleLayout(accountOwnerId, defaultPreset).catch(() => null)
      : Promise.resolve(null);
    const ownLayout = fetchOverviewLayout(userId).then(
      (raw) => ({ raw, failed: false }),
      () => ({ raw: null as unknown, failed: true }),
    );
    Promise.all([ownLayout, roleLayout])
      .then(([own, roleRaw]) => {
        if (cancelled) return;
        const base = resolveBaseLayout(roleRaw, defaultPreset);
        baseRef.current = base;
        setLoadFailed(own.failed);
        const next = own.raw ? sanitizeLayout(own.raw, defaultPreset) : base;
        layoutRef.current = next;
        setLayout(next);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        const fallback = buildPresetLayout(defaultPreset);
        baseRef.current = fallback;
        layoutRef.current = fallback;
        setLayout(fallback);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, defaultPreset, accountOwnerId]);

  const persist = useCallback(async () => {
    if (!userId || !dirtyRef.current) return;
    const seq = ++seqRef.current;
    dirtyRef.current = false;
    setSaveState('saving');
    try {
      await saveOverviewLayout(userId, layoutRef.current);
      if (seq === seqRef.current) setSaveState('saved');
    } catch {
      dirtyRef.current = true; // retry on the next edit / flush
      if (seq === seqRef.current) setSaveState('error');
    }
  }, [userId]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await persist();
  }, [persist]);

  const commit = useCallback(
    (next: OverviewLayout) => {
      if (next === layoutRef.current) return;
      layoutRef.current = next;
      dirtyRef.current = true;
      setLayout(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void persist();
      }, SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  // Save anything still pending when the page unmounts.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void persist();
    },
    [persist],
  );

  const reset = useCallback(async () => {
    if (!userId) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    dirtyRef.current = false;
    const seq = ++seqRef.current;
    const next = baseRef.current;
    layoutRef.current = next;
    setLayout(next);
    setSaveState('saving');
    try {
      await deleteOverviewLayout(userId);
      if (seq === seqRef.current) setSaveState('saved');
    } catch {
      if (seq === seqRef.current) setSaveState('error');
      throw new Error('reset-failed');
    }
  }, [userId, defaultPreset]);

  const actions = useMemo(
    () => ({
      move: (id: OverviewWidgetId, targetId: OverviewWidgetId) => commit(moveWidget(layoutRef.current, id, targetId)),
      moveBy: (id: OverviewWidgetId, delta: -1 | 1) => commit(moveWidgetBy(layoutRef.current, id, delta, canRef.current)),
      resize: (id: OverviewWidgetId, size: { w?: number; h?: number }) => commit(resizeWidget(layoutRef.current, id, size)),
      hide: (id: OverviewWidgetId) => commit(setWidgetHidden(layoutRef.current, id, true)),
      show: (id: OverviewWidgetId) => commit(setWidgetHidden(layoutRef.current, id, false)),
      applyPreset: (preset: OverviewPresetId) => commit(applyPresetLayout(preset)),
    }),
    [commit],
  );

  return { layout, ready, saveState, loadFailed, flush, reset, ...actions };
}
