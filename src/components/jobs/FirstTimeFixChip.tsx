import type { FtfChip } from '@/hooks/useFirstTimeFixGate';

const TONE = {
  go: 'bg-success-500/10 text-success-500',
  review: 'bg-warning-500/10 text-warning-500',
  hold: 'bg-danger/10 text-danger',
} as const;

/** Small "87% FTF" pill shown next to a suggested technician on the dispatch board. */
export function FirstTimeFixChip({ chip }: { chip: FtfChip | null }) {
  if (!chip) return null;
  return (
    <span
      className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${TONE[chip.verdict]}`}
      title="Predicted first-time-fix probability"
    >
      {chip.probability}% FTF
    </span>
  );
}
