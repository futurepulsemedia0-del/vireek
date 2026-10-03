/**
 * Shared, presentational view of one Equipment Passport.
 * Used by the public page (/e/:code) and the dashboard detail page.
 */

import {
  ArrowRightLeft,
  Camera,
  ClipboardCheck,
  Eye,
  Fingerprint,
  Hammer,
  History,
  Lock,
  Package,
  Pencil,
  Power,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  User,
  Wrench,
} from 'lucide-react';
import {
  buildJourney,
  equipmentTitle,
  formatPassportCode,
  journeyCompleteness,
  warrantyState,
  type JourneyKey,
  type PassportData,
  type PassportEvent,
  type PassportEventType,
} from '@/lib/equipmentPassport';
import { formatDate } from '@/lib/technicianIdentity';

const JOURNEY_ICON: Record<JourneyKey, typeof Wrench> = {
  diagnosis: Stethoscope,
  technician: User,
  parts: Package,
  photos: Camera,
  warranty: ShieldCheck,
  repair: Hammer,
  outcome: ClipboardCheck,
};

const EVENT_ICON: Record<PassportEventType, typeof Wrench> = {
  registered: Fingerprint,
  installed: Wrench,
  service_visit: Wrench,
  inspection: Eye,
  repair: Hammer,
  part_replaced: Package,
  outcome: ClipboardCheck,
  warranty_event: ShieldCheck,
  custody_change: ArrowRightLeft,
  identity_corrected: Pencil,
  note: History,
  decommissioned: Power,
};

const WARRANTY_STYLE = {
  active: 'bg-success-500/10 text-success-500',
  expiring: 'bg-warning-500/10 text-warning-500',
  expired: 'bg-bg-tertiary text-text-secondary',
  unknown: 'bg-bg-tertiary text-text-secondary',
} as const;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-lg font-bold text-text-primary">{value}</p>
    </div>
  );
}

function EventCard({ ev, member }: { ev: PassportEvent; member: boolean }) {
  const Icon = EVENT_ICON[ev.event_type] ?? History;
  const isVisit = ev.event_type === 'service_visit';
  const steps = isVisit ? buildJourney(ev.summary) : [];
  const completeness = isVisit ? journeyCompleteness(steps) : 0;

  return (
    <li className="relative pl-12">
      <span className="absolute left-0 top-0 flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">{ev.title}</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {formatDate(ev.occurred_at)}
              {ev.contributor_name ? ` · ${ev.contributor_name}` : ''}
              {ev.is_mine ? ' · you' : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {member && ev.visibility === 'network' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                <Lock size={10} aria-hidden="true" /> Verified servicers only
              </span>
            )}
            {isVisit && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">{completeness}% documented</span>
            )}
          </div>
        </div>

        {ev.detail && <p className="mt-2 whitespace-pre-line text-sm text-text-secondary">{ev.detail}</p>}

        {isVisit && (
          <ol className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Service journey">
            {steps.map((s) => {
              const StepIcon = JOURNEY_ICON[s.key];
              return (
                <li
                  key={s.key}
                  className={`flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs ${s.done ? 'bg-bg-primary text-text-primary' : 'bg-bg-primary/50 text-text-secondary/60'}`}
                >
                  <StepIcon size={13} className={`mt-0.5 shrink-0 ${s.done ? 'text-accent' : ''}`} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block font-semibold">{s.label}</span>
                    <span className="block break-words">{s.done ? s.text : 'Not recorded'}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {isVisit && ev.summary.evidence?.level && (
          <p className="mt-2 text-[11px] text-text-secondary">
            Evidence chain: <span className="font-semibold capitalize text-text-primary">{String(ev.summary.evidence.level).replace(/_/g, ' ')}</span>
            {typeof ev.summary.evidence.score === 'number' ? ` (${ev.summary.evidence.score}/100)` : ''}
          </p>
        )}

        {!isVisit && ev.summary.outcome && (
          <p className="mt-2 text-xs text-text-secondary">
            {buildJourney(ev.summary).find((s) => s.key === 'outcome')?.text}
          </p>
        )}

        <p className="mt-2 truncate font-mono text-[10px] text-text-secondary/60" title={ev.entry_hash}>
          #{ev.seq} · {ev.entry_hash.slice(0, 16)}…
        </p>
      </div>
    </li>
  );
}

export function EquipmentPassportView({ data }: { data: PassportData }) {
  const p = data.passport;
  if (!data.found || !p) return null;
  const member = data.access === 'member';
  const warranty = warrantyState(p.warranty_expires_at);
  const integrity = data.integrity;
  const events = data.events ?? [];
  const stats = data.stats;

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
        <div className="flex items-center justify-between gap-3 bg-accent px-5 py-2.5 text-white">
          <span className="text-[11px] font-bold uppercase tracking-[0.18em]">Vireek Equipment Passport</span>
          <span className="font-mono text-xs">{formatPassportCode(p.code)}</span>
        </div>
        <div className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-text-primary">{equipmentTitle(p)}</h1>
              <p className="text-sm text-text-secondary">{p.equipment_type}</p>
            </div>
            {p.status !== 'active' && (
              <span className="rounded-full bg-danger-500/10 px-3 py-1 text-xs font-semibold uppercase text-danger-500">{p.status}</span>
            )}
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-text-secondary">Model</dt>
              <dd className="font-medium text-text-primary">{p.model || '—'}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-text-secondary">Serial</dt>
              <dd className="font-mono font-medium text-text-primary">{p.serial || '—'}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-text-secondary">Installed</dt>
              <dd className="font-medium text-text-primary">{member ? formatDate(p.install_date) : (p.install_date ?? '—')}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-text-secondary">Warranty</dt>
              <dd>
                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${WARRANTY_STYLE[warranty.state]}`}>
                  {warranty.state === 'unknown'
                    ? 'Not on file'
                    : warranty.state === 'expired'
                      ? `Expired ${formatDate(p.warranty_expires_at)}`
                      : `Until ${formatDate(p.warranty_expires_at)}`}
                </span>
              </dd>
            </div>
          </dl>

          {integrity && (
            <div
              role="status"
              className={`mt-4 flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium ${integrity.valid ? 'bg-success-500/10 text-success-500' : 'bg-danger-500/10 text-danger-500'}`}
            >
              {integrity.valid ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldAlert size={14} aria-hidden="true" />}
              {integrity.valid
                ? `History sealed — ${integrity.checked} entr${integrity.checked === 1 ? 'y' : 'ies'} cryptographically verified. It cannot be edited or deleted.`
                : `Integrity check failed at entry #${integrity.broken_at_seq ?? '?'}. Do not rely on this history.`}
            </div>
          )}
        </div>
      </section>

      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Services" value={String(stats.service_count)} />
          <Stat label="Companies" value={String(stats.contractor_count)} />
          <Stat label="Last service" value={stats.last_service_at ? formatDate(stats.last_service_at) : '—'} />
        </div>
      )}

      <section aria-labelledby="passport-history">
        <h2 id="passport-history" className="mb-3 text-sm font-semibold text-text-primary">Lifetime history</h2>
        {events.length === 0 ? (
          <div className="rounded-2xl border border-border bg-bg-secondary p-6 text-center text-sm text-text-secondary">
            No public service history yet.
          </div>
        ) : (
          <ul className="relative space-y-3 before:absolute before:bottom-4 before:left-[17px] before:top-4 before:w-px before:bg-border">
            {events.map((ev) => (
              <EventCard key={ev.id} ev={ev} member={member} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
