import { rateBadge } from '@/lib/planMargins';

const TONE = { warn: 'bg-warning/10 text-warning', info: 'bg-bg-tertiary text-text-secondary' } as const;

/** "Rate not verified" / "Assumption" / "Secondary source" tag. Renders nothing for official or human-entered rates. */
export function RateStatusBadge({ status }: { status: string | null | undefined }) {
  const b = rateBadge(status);
  if (!b) return null;
  return <span className={`ml-2 inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${TONE[b.tone]}`}>{b.label}</span>;
}
