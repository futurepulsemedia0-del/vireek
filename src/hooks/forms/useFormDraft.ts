import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';
import { createDraftStore, defaultBackend, type DraftStore, type LoadedDraft } from '@/lib/forms/draftStore';

let sharedStore: DraftStore | null = null;
export function getDraftStore(): DraftStore {
  sharedStore ??= createDraftStore(defaultBackend());
  return sharedStore;
}

export interface FormDraftOptions {
  /** Signed-in user id. Drafts are per user; without one they are off unless allowAnonymous. */
  userId: string | null;
  formId: string;
  /** Bump when the field set changes; older drafts are discarded. */
  version: number;
  /** Extra field paths (dot notation) to keep out of the draft, on top of the built-in sensitive-key filter. */
  exclude?: readonly string[];
  debounceMs?: number;
  enabled?: boolean;
  allowAnonymous?: boolean;
  store?: DraftStore;
}

export function useFormDraft<TIn extends FieldValues, TOut>(form: UseFormReturn<TIn, unknown, TOut>, opts: FormDraftOptions) {
  const { userId, formId, version, debounceMs = 800, enabled = true, allowAnonymous = false } = opts;
  const store = opts.store ?? getDraftStore();
  const owner = userId ?? (allowAnonymous ? 'anonymous' : null);
  const active = enabled && owner !== null;
  const key = useMemo(() => (owner ? { userId: owner, formId } : null), [owner, formId]);
  const excludeRef = useRef<readonly string[]>(opts.exclude ?? []);
  excludeRef.current = opts.exclude ?? [];

  const [draft, setDraft] = useState<LoadedDraft<Partial<TIn>> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef(false);

  useEffect(() => {
    if (!active || !key) return;
    let cancelled = false;
    store
      .load<Partial<TIn>>(key, version)
      .then((d) => {
        if (!cancelled && d) setDraft(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, key, version, store]);

  useEffect(() => {
    if (!active || !key) return;
    const flush = () => {
      clearTimeout(timer.current);
      if (!pending.current) return;
      pending.current = false;
      void store.save(key, version, form.getValues(), excludeRef.current).catch(() => undefined);
    };
    const sub = form.watch((_values, info) => {
      if (info.type !== 'change') return; // ignore programmatic reset()/setValue()
      pending.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, debounceMs);
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      sub.unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      clearTimeout(timer.current);
    };
  }, [active, key, version, debounceMs, form, store]);

  const clear = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = false;
    setDraft(null);
    if (key) void store.clear(key).catch(() => undefined);
  }, [key, store]);

  const restore = useCallback(() => {
    if (!draft) return;
    form.reset({ ...form.getValues(), ...draft.data } as TIn, { keepDefaultValues: true });
    setDraft(null);
  }, [draft, form]);

  return { draft: draft ? { savedAt: draft.savedAt } : null, restore, discard: clear, clear };
}
