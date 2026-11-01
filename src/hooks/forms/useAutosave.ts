import { useCallback, useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from './useOnlineStatus';

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';

export interface AutosaveStatusValue {
  state: AutosaveState;
  savedAt: number | null;
}

interface Options<T> {
  value: T;
  save: (value: T, signal: AbortSignal) => Promise<void>;
  enabled?: boolean;
  delayMs?: number;
  /** Defaults to JSON equality, which suits form values. */
  isEqual?: (a: T, b: T) => boolean;
}

const jsonEqual = <T,>(a: T, b: T) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/**
 * Debounced autosave with one request in flight, a trailing save for edits made
 * during a save, offline detection (resumes on reconnect) and manual retry.
 * The value at mount is the saved baseline, so opening an editor never "saves".
 */
export function useAutosave<T>({ value, save, enabled = true, delayMs = 1500, isEqual = jsonEqual }: Options<T>) {
  const online = useOnlineStatus();
  const [status, setStatus] = useState<AutosaveStatusValue>({ state: 'idle', savedAt: null });
  const latest = useRef(value);
  const baseline = useRef(value);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveRef = useRef(save);
  const isEqualRef = useRef(isEqual);
  const onlineRef = useRef(online);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    saveRef.current = save;
    isEqualRef.current = isEqual;
    onlineRef.current = online;
    enabledRef.current = enabled;
  });

  const run = useCallback(async (): Promise<void> => {
    if (inFlight.current || !enabledRef.current) return;
    if (isEqualRef.current(latest.current, baseline.current)) return;
    if (!onlineRef.current) {
      setStatus((s) => ({ ...s, state: 'offline' }));
      return;
    }
    inFlight.current = true;
    const snapshot = latest.current;
    setStatus((s) => ({ ...s, state: 'saving' }));
    let failed = false;
    try {
      await saveRef.current(snapshot, new AbortController().signal);
      baseline.current = snapshot;
      setStatus({ state: 'saved', savedAt: Date.now() });
    } catch {
      failed = true;
      setStatus((s) => ({ ...s, state: onlineRef.current ? 'error' : 'offline' }));
    } finally {
      inFlight.current = false;
    }
    // Edits made while saving: save them too (unless the last attempt failed - wait for retry).
    if (!failed && !isEqualRef.current(latest.current, baseline.current)) void run();
  }, []);

  useEffect(() => {
    latest.current = value;
    if (!enabled || isEqualRef.current(value, baseline.current)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), delayMs);
    return () => clearTimeout(timer.current);
  }, [value, enabled, delayMs, run]);

  useEffect(() => {
    if (online) void run(); // reconnect: flush whatever is pending
    else if (!isEqualRef.current(latest.current, baseline.current)) setStatus((s) => ({ ...s, state: 'offline' }));
  }, [online, run]);

  const retry = useCallback(() => {
    clearTimeout(timer.current);
    void run();
  }, [run]);

  /** True while anything is not yet persisted, including edits still inside the debounce window (for useUnsavedChanges). */
  const hasUnsaved = enabled && !isEqual(value, baseline.current);
  return { status, retry, hasUnsaved };
}
