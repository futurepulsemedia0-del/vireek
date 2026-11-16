import type { RealtimeStatus } from '@/lib/realtime';

/**
 * Small "Live" / "Reconnecting..." badge used next to page titles on
 * Overview and Calls (step 11). Deliberately subtle — a pulsing dot and a
 * label, not a loud banner — so it confirms the data is live without
 * competing with the page's actual content.
 */
export function LiveIndicator({ status }: { status: RealtimeStatus }) {
  if (status === 'connecting') return null;

  const isLive = status === 'live';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        isLive
          ? 'border-success/25 bg-success-subtle text-success'
          : 'border-warning/25 bg-warning-subtle text-warning'
      }`}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-1.5 w-1.5">
        {isLive && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
        )}
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
            isLive ? 'bg-success' : 'bg-warning'
          }`}
        />
      </span>
      {isLive ? 'Live' : 'Reconnecting…'}
    </span>
  );
}
