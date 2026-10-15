import { useMemo } from 'react';
import { Archive, ArchiveRestore, Clock, MapPin, Pause, Pencil, Phone, Play, Star, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatAddress, formatHoursSummary, isOpenNow, STATUS_LABELS, type BusinessLocation } from '@/lib/locations';

const STATUS_STYLE: Record<BusinessLocation['status'], string> = {
  active: 'bg-success-500/10 text-success-500',
  paused: 'bg-warning-500/10 text-warning-500',
  archived: 'bg-bg-tertiary text-text-secondary',
};

export type LocationAction = 'edit' | 'select' | 'primary' | 'pause' | 'resume' | 'archive' | 'restore' | 'delete';

export function LocationCard({
  location: l,
  isActive,
  busy,
  onAction,
}: {
  location: BusinessLocation;
  isActive: boolean;
  busy: boolean;
  onAction: (action: LocationAction, location: BusinessLocation) => void;
}) {
  const address = formatAddress(l);
  const archived = l.status === 'archived';
  const openNow = useMemo(() => (archived ? null : isOpenNow(l.business_hours, l.timezone, new Date())), [archived, l.business_hours, l.timezone]);

  return (
    <article
      aria-label={l.name}
      className={`flex flex-col rounded-2xl border bg-bg-secondary p-4 transition-colors sm:p-5 ${
        isActive ? 'border-accent/50 ring-1 ring-accent/20' : 'border-border'
      } ${archived ? 'opacity-75' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-text-primary">
            <span className="truncate">{l.name}</span>
            {l.is_primary && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                <Star size={11} aria-hidden="true" /> Primary
              </span>
            )}
          </h3>
          <p className="mt-0.5 truncate text-xs text-text-secondary">{[l.brand_name, l.code].filter(Boolean).join(' · ') || 'No brand'}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[l.status]}`}>{STATUS_LABELS[l.status]}</span>
          {isActive && <span className="text-[11px] font-medium text-accent">Current</span>}
        </div>
      </div>

      <dl className="mt-4 space-y-2 text-sm text-text-secondary">
        <div className="flex items-start gap-2">
          <MapPin size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <dt className="sr-only">Address</dt>
          <dd className="min-w-0">{address || <span className="italic">No address yet</span>}</dd>
        </div>
        {l.phone && (
          <div className="flex items-start gap-2">
            <Phone size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <dt className="sr-only">Phone</dt>
            <dd>{l.phone}</dd>
          </div>
        )}
        <div className="flex items-start gap-2">
          <Clock size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          <dt className="sr-only">Hours</dt>
          <dd className="min-w-0">
            {formatHoursSummary(l.business_hours)}
            {openNow !== null && (
              <span className={`ml-2 text-xs font-semibold ${openNow ? 'text-success-500' : 'text-text-secondary'}`}>{openNow ? 'Open now' : 'Closed now'}</span>
            )}
            <span className="block text-[11px] text-text-secondary/80">{l.timezone.replace(/_/g, ' ')}</span>
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <Users size={15} className="shrink-0" aria-hidden="true" />
          <dt className="sr-only">Team</dt>
          <dd>{l.member_count === 1 ? '1 team member' : `${l.member_count} team members`}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
        {!archived && !isActive && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction('select', l)}>
            Switch to this
          </Button>
        )}
        {!archived && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction('edit', l)} aria-label={`Edit ${l.name}`}>
            <Pencil size={14} aria-hidden="true" /> Edit
          </Button>
        )}
        {!archived && !l.is_primary && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('primary', l)}>
            <Star size={14} aria-hidden="true" /> Make primary
          </Button>
        )}
        {!archived && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction(l.status === 'paused' ? 'resume' : 'pause', l)}>
            {l.status === 'paused' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {l.status === 'paused' ? 'Resume' : 'Pause'}
          </Button>
        )}
        {!archived ? (
          <Button size="sm" variant="ghost" disabled={busy || l.is_primary} title={l.is_primary ? 'Make another location primary first' : undefined} onClick={() => onAction('archive', l)}>
            <Archive size={14} aria-hidden="true" /> Archive
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('restore', l)}>
              <ArchiveRestore size={14} aria-hidden="true" /> Restore
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('delete', l)} className="text-danger hover:text-danger">
              <Trash2 size={14} aria-hidden="true" /> Delete
            </Button>
          </>
        )}
      </div>
    </article>
  );
}
