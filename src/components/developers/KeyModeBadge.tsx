import type { KeyMode } from '../../../supabase/functions/api-v1/contract';

/** LIVE / TEST badge: distinguished by label AND color (never color alone). */
export function KeyModeBadge({ mode }: { mode: KeyMode }) {
  const live = mode === 'live';
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide ${
        live ? 'bg-danger/10 text-danger' : 'bg-warning-500/10 text-warning-500'
      }`}
      title={live ? 'Reads your real account data' : 'Returns synthetic sandbox data only'}
    >
      {live ? 'Live' : 'Test'}
    </span>
  );
}
