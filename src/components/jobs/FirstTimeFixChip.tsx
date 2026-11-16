import type { FtfChip } from '@/hooks/useFirstTimeFixGate';

const TONE = {
  go: 'bg-success-subtle text-success',
  review: 'bg-warning-subtle text-warning',
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
