import { WifiOff, RefreshCw } from 'lucide-react';
import { useConnectivity } from '@/contexts/ConnectivityContext';

/**
 * Non-blocking strip. Does not lock the UI — users can still read cached
 * screens; mutations will fail until connectivity returns.
 */
export function OfflineBanner() {
  const { mode, isOnline, refresh } = useConnectivity();

  if (isOnline || mode === 'maintenance') return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-[100] border-b border-warning-500/30 bg-warning-500/10 px-4 py-2.5 backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 text-sm text-text-primary">
          <WifiOff size={16} className="shrink-0 text-warning-500" />
          <span>
            <span className="font-semibold">You&apos;re offline.</span>{' '}
            <span className="text-text-secondary">
              Showing what&apos;s already loaded. Changes won&apos;t save until the connection returns.
            </span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-xs font-semibold text-text-primary transition hover:bg-bg-tertiary"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      </div>
    </div>
  );
}
