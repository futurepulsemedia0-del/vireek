import { BadgeCheck, CalendarDays, Clock, Info } from 'lucide-react';
import { getClaim, type ClaimStatus } from '@/lib/trust/claims';

const META: Record<ClaimStatus, { label: string; cls: string; Icon: typeof Info }> = {
  verified: { label: 'Verified', cls: 'border-success/30 bg-success/10 text-success', Icon: BadgeCheck },
  in_progress: { label: 'In progress', cls: 'border-accent/30 bg-accent/10 text-accent', Icon: Clock },
  planned: { label: 'Planned', cls: 'border-border bg-bg-tertiary text-text-secondary', Icon: CalendarDays },
  not_held: { label: 'Not held', cls: 'border-border bg-bg-tertiary text-text-secondary', Icon: Info },
};

/** Status pill. Meaning is carried by icon + text, never by colour alone. */
export function StatusBadge({ status }: { status: ClaimStatus }) {
  const { label, cls, Icon } = META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${cls}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Renders one registry claim: badge, exact approved wording, evidence link, review date. */
export function ClaimBadge({ id, showStatement = true }: { id: string; showStatement?: boolean }) {
  const claim = getClaim(id);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={claim.status} />
        <span className="text-xs text-text-secondary/70">Last reviewed {formatDate(claim.reviewedOn)}</span>
      </div>
      {showStatement ? <p className="text-sm leading-relaxed text-text-secondary">{claim.statement}</p> : null}
      {claim.evidence ? (
        <a href={claim.evidence.href} className="text-xs font-semibold text-accent hover:underline">
          {claim.evidence.label}
        </a>
      ) : null}
    </div>
  );
}
