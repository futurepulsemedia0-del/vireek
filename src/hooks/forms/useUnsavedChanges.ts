import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router-dom';

export interface UnsavedChangesOptions {
  /** True while the form has unsaved edits. */
  when: boolean;
  /** Persist the edits. Return true on success; the pending action then continues. */
  onSave?: () => Promise<boolean>;
}

export interface UnsavedChangesDialogState {
  open: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}

/**
 * One guard for all three ways of losing edits:
 *  - in-app route changes (react-router data-router blocker; requires <RouterProvider>)
 *  - tab close / reload (beforeunload)
 *  - closing a modal or sheet (wrap the close handler with guardClose)
 */
export function useUnsavedChanges({ when, onSave }: UnsavedChangesOptions) {
  const bypass = useRef(false);
  const [pendingClose, setPendingClose] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (when) bypass.current = false; // edits after a save are guarded again
  }, [when]);

  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      when &&
      !bypass.current &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
    [when],
  );
  const blocker = useBlocker(shouldBlock);

  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (bypass.current) return;
      e.preventDefault();
      e.returnValue = ''; // required by Chromium to show the native prompt
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [when]);

  // Became clean while a navigation was waiting: let it through.
  useEffect(() => {
    if (blocker.state === 'blocked' && !when) blocker.proceed();
  }, [blocker, when]);

  const proceed = useCallback(() => {
    if (blocker.state === 'blocked') blocker.proceed();
    else if (pendingClose) {
      const run = pendingClose;
      setPendingClose(null);
      run();
    }
  }, [blocker, pendingClose]);

  const onStay = useCallback(() => {
    if (blocker.state === 'blocked') blocker.reset();
    setPendingClose(null);
  }, [blocker]);

  const onDiscard = useCallback(() => {
    bypass.current = true;
    proceed();
  }, [proceed]);

  const onSaveClick = useCallback(async () => {
    if (!onSave || saving) return;
    setSaving(true);
    let ok = false;
    try {
      ok = await onSave();
    } finally {
      setSaving(false);
    }
    if (ok) {
      bypass.current = true;
      proceed();
    }
  }, [onSave, proceed, saving]);

  /** Call right after a successful submit, BEFORE navigating away. */
  const markSaved = useCallback(() => {
    bypass.current = true;
  }, []);

  /** Wrap a modal/sheet close handler: closes immediately when clean, asks first when dirty. */
  const guardClose = useCallback(
    (close: () => void) => () => {
      if (!when || bypass.current) close();
      else setPendingClose(() => close);
    },
    [when],
  );

  const dialog: UnsavedChangesDialogState = {
    open: blocker.state === 'blocked' || pendingClose !== null,
    saving,
    canSave: Boolean(onSave),
    onSave: () => void onSaveClick(),
    onDiscard,
    onStay,
  };
  return { dialog, guardClose, markSaved };
}
