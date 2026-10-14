import { useState, type ReactNode } from 'react';
import { AlertTriangle, BadgeCheck, CalendarClock, Languages, MapPin, Radio, ShieldAlert, Wrench, type LucideIcon } from 'lucide-react';
import {
  credentialAttentionCount,
  locationFreshness,
  type AvailabilityDay,
  type CredentialHealth,
  type CredentialView,
  type SkillEvidence,
} from '@/lib/technicianDetail';
import type { TeamMember } from '@/lib/supabase';

export const sectionCard = 'rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-5 dark:shadow-card-dark';

export function SectionCard({
  title,
  icon: Icon,
  aside,
  error,
  onRetry,
  children,
}: {
  title: string;
  icon: LucideIcon;
  aside?: ReactNode;
  error?: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  const id = `sec-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section className={sectionCard} aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Icon size={16} className="text-text-secondary" /> {title}
        </h2>
        {aside}
      </div>
      <div className="mt-3">
        {error ? (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger-500/10 p-3 text-sm text-danger-500">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              Couldn’t load this section.
              {onRetry && <> <button type="button" onClick={onRetry} className="focus-ring font-semibold underline">Retry</button></>}
            </span>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

// ─── Skills ────────────────────────────────────────────────────────────────
export function SkillsSection({ skills, languages, error, onRetry }: { skills: SkillEvidence[]; languages: string[]; error?: string; onRetry?: () => void }) {
  return (
    <SectionCard title="Skills" icon={Wrench} error={error} onRetry={onRetry}>
      {skills.length === 0 ? (
        <p className="text-sm text-text-secondary">No skills declared and no completed jobs to infer them from. Add skills to this team member from the Team page.</p>
      ) : (
        <ul className="divide-y divide-border">
          {skills.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-text-primary">{s.name}</p>
                <p className="text-xs text-text-secondary">
                  {s.jobs > 0 ? `${s.jobs} completed job${s.jobs === 1 ? '' : 's'}${s.lastJobAt ? ` · last ${fmtDate(s.lastJobAt)}` : ''}` : 'No completed jobs yet'}
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {s.firstTimeFixRate !== null && <span className="tabular-nums text-text-secondary">{s.firstTimeFixRate}% fixed 1st visit</span>}
                {s.csatAvg !== null && <span className="tabular-nums text-text-secondary">★ {s.csatAvg.toFixed(1)}</span>}
                <span className={`rounded-full px-2 py-0.5 font-semibold ${s.declared ? (s.jobs > 0 ? 'bg-success-500/15 text-success-500' : 'bg-warning-500/15 text-warning-500') : 'bg-bg-tertiary text-text-secondary'}`}>
                  {s.declared ? (s.jobs > 0 ? 'Proven' : 'Unproven') : 'Undeclared'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {languages.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          <Languages size={14} /> Speaks {languages.join(', ')}
        </p>
      )}
    </SectionCard>
  );
}

// ─── Credentials ───────────────────────────────────────────────────────────
const HEALTH: Record<CredentialHealth, { label: string; cls: string }> = {
  valid: { label: 'Valid', cls: 'bg-success-500/15 text-success-500' },
  expiring_soon: { label: 'Expiring soon', cls: 'bg-warning-500/15 text-warning-500' },
  expired: { label: 'Expired', cls: 'bg-danger-500/15 text-danger-500' },
  revoked: { label: 'Revoked', cls: 'bg-bg-tertiary text-text-secondary' },
  pending_renewal: { label: 'Pending renewal', cls: 'bg-warning-500/15 text-warning-500' },
};

export function CredentialsSection({ views, error, onRetry }: { views: CredentialView[]; error?: string; onRetry?: () => void }) {
  const attention = credentialAttentionCount(views);
  return (
    <SectionCard
      title="Credentials"
      icon={BadgeCheck}
      error={error}
      onRetry={onRetry}
      aside={attention > 0 ? <span className="flex items-center gap-1 text-xs font-medium text-warning-500"><ShieldAlert size={14} /> {attention} need{attention === 1 ? 's' : ''} attention</span> : undefined}
    >
      {views.length === 0 ? (
        <p className="text-sm text-text-secondary">No licenses or certifications on file for this technician.</p>
      ) : (
        <ul className="divide-y divide-border">
          {views.map(({ credential: c, health, daysLeft }) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-text-primary">{c.credential_name || c.credential_type}</p>
                <p className="break-words text-xs text-text-secondary">
                  {[c.credential_name ? c.credential_type : null, c.issuing_authority, c.credential_number ? `#${c.credential_number}` : null].filter(Boolean).join(' · ') || '—'}
                </p>
                <p className="text-xs text-text-secondary">
                  {c.expires_at
                    ? `Expires ${fmtDate(c.expires_at)}${daysLeft !== null ? (daysLeft < 0 ? ` (${-daysLeft}d ago)` : daysLeft === 0 ? ' (today)' : ` (in ${daysLeft}d)`) : ''}`
                    : 'No expiry date'}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${HEALTH[health].cls}`}>{HEALTH[health].label}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ─── Availability ──────────────────────────────────────────────────────────
const DAY_STYLE: Record<AvailabilityDay['state'], string> = {
  open: 'bg-success-500/15 text-success-500',
  busy: 'bg-warning-500/15 text-warning-500',
  full: 'bg-danger-500/15 text-danger-500',
  off: 'bg-bg-tertiary text-text-secondary',
};
const DAY_LABEL: Record<AvailabilityDay['state'], string> = { open: 'Open', busy: 'Busy', full: 'Full', off: 'Off' };

export function AvailabilitySection({ member, days }: { member: TeamMember; days: AvailabilityDay[] }) {
  const [now] = useState(() => new Date());
  const loc = locationFreshness(member.location_updated_at, now);
  return (
    <SectionCard title="Availability" icon={CalendarClock}>
      <div className="grid grid-cols-7 gap-1.5" role="list" aria-label="Next 7 days">
        {days.map((d) => {
          const date = new Date(`${d.date}T00:00:00`);
          return (
            <div key={d.date} role="listitem" className={`rounded-lg px-1 py-2 text-center ${DAY_STYLE[d.state]}`} title={`${date.toDateString()}: ${d.booked}/${d.capacity} jobs`}>
              <p className="text-[10px] font-medium uppercase">{date.toLocaleDateString(undefined, { weekday: 'short' })}</p>
              <p className="text-sm font-semibold tabular-nums">{d.booked}/{d.capacity}</p>
              <p className="text-[10px]">{DAY_LABEL[d.state]}</p>
            </div>
          );
        })}
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-3"><dt className="text-text-secondary">Dispatch</dt><dd className={member.dispatch_enabled ? 'text-success-500' : 'text-text-secondary'}>{member.dispatch_enabled ? 'Accepting jobs' : 'Paused'}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-text-secondary">Max jobs / day</dt><dd className="tabular-nums text-text-primary">{member.max_jobs_per_day}</dd></div>
        <div className="flex justify-between gap-3"><dt className="flex items-center gap-1 text-text-secondary"><MapPin size={13} /> Service area</dt><dd className="break-words text-right text-text-primary">{member.service_area || '—'}</dd></div>
        <div className="flex justify-between gap-3">
          <dt className="flex items-center gap-1 text-text-secondary"><Radio size={13} /> Location</dt>
          <dd className={loc?.live ? 'text-success-500' : 'text-text-primary'}>
            {!loc ? 'Never reported' : loc.live ? 'Live now' : loc.minutesAgo < 60 ? `${loc.minutesAgo} min ago` : loc.minutesAgo < 1440 ? `${Math.round(loc.minutesAgo / 60)} h ago` : `${Math.round(loc.minutesAgo / 1440)} d ago`}
          </dd>
        </div>
      </dl>
    </SectionCard>
  );
}
