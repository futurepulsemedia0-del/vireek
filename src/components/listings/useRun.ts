import { useCallback, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { syncSummary, type ListingsOverview, type SyncResponse } from '@/lib/listings';

export type RunFn = (key: string, fn: () => Promise<ListingsOverview | SyncResponse | void>, ok?: string) => Promise<void>;

/** Shared busy-state + toast wrapper for every action on the Listings page (one action at a time). */
export function useRun(onChange: (o: ListingsOverview) => void): { busy: string | null; run: RunFn } {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const run: RunFn = useCallback(
    async (key, fn, ok) => {
      setBusy(key);
      try {
        const out = await fn();
        if (out) onChange(out);
        const sync = out && 'sync' in out ? out.sync : undefined;
        if (sync && sync.length > 0) {
          const s = syncSummary(sync);
          toast(s.message, s.type);
        } else if (ok) {
          toast(ok, 'success');
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error');
      } finally {
        setBusy(null);
      }
    },
    [onChange, toast],
  );

  return { busy, run };
}
