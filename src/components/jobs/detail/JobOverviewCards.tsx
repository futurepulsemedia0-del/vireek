import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Mail, MapPin, Navigation, Phone, RotateCcw, StickyNote, User as UserIcon, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import type { Job } from '@/lib/supabase';
import {
  STATUS_BADGE,
  STATUS_LABELS,
  buildStatusTimeline,
  formatDuration,
  formatWhen,
  mapsLink,
  nextStatus,
  relativeTime,
  telHref,
} from '@/lib/jobDetail';
import type { JobNotesPatch, JobStatus, JobTechnician } from '@/lib/jobDetail';
import { JobSection, Pill, SectionError, SectionSkeleton } from './JobSection';

// ============================================================
// STATUS TIMELINE + ACTIONS
// ============================================================

export function JobStatusTimeline({
  job,
  canEdit,
  canManage,
  busy,
  blockers,
  onAdvance,
  onTerminate,
}: {
  job: Job;
  canEdit: boolean;
  canManage: boolean;
  busy: boolean;
  /** Why the database refused the last status change (quality gate / evidence chain). */
  blockers: string[];
  onAdvance: (status: JobStatus) => void;
  onTerminate: (status: 'cancelled' | 'no_show') => void;
}) {
  const { steps, terminal } = buildStatusTimeline(job);
  const next = nextStatus(job.job_status);
  const active = job.job_status === 'scheduled' || job.job_status === 'en_route' || job.job_status === 'in_progress';

  return (
    <JobSection
      title="Status"
      action={<Pill className={STATUS_BADGE[job.job_status]}>{STATUS_LABELS[job.job_status]}</Pill>}
    >
      <ol className="grid grid-cols-4 gap-1" aria-label="Job progress">
        {steps.map((s, i) => {
          const done = s.state === 'done';
          const current = s.state === 'current';
          return (
            <li key={s.key} className="relative flex flex-col items-center text-center" aria-current={current ? 'step' : undefined}>
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`absolute left-1/2 top-3.5 h-0.5 w-full ${done && steps[i + 1].state !== 'upcoming' ? 'bg-success-500' : 'bg-border'}`}
                />
              )}
              <span
                className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold ${
                  done
                    ? 'border-success-500 bg-success-500 text-white'
                    : current
                      ? 'border-accent bg-accent text-white'
                      : 'border-border bg-bg-primary text-text-secondary'
                }`}
              >
                {done ? <Check size={14} aria-hidden="true" /> : i + 1}
              </span>
              <span className={`mt-1.5 text-[11px] font-medium leading-tight sm:text-xs ${s.state === 'upcoming' ? 'text-text-secondary' : 'text-text-primary'}`}>
                {s.label}
              </span>
              <span className="mt-0.5 hidden text-[10px] leading-tight text-text-secondary sm:block">{s.at ? formatWhen(s.at) : ''}</span>
            </li>
          );
        })}
      </ol>

      {terminal && (
        <p className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
          This job ended as {STATUS_LABELS[terminal].toLowerCase()}.
        </p>
      )}

      {blockers.length > 0 && (
        <div role="alert" className="mt-4 rounded-xl bg-warning-500/10 px-3 py-2 text-sm text-warning-500">
          <p className="font-semibold">Can&apos;t complete this job yet. Still needed:</p>
          <ul className="mt-1 list-disc pl-5">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {(canEdit && next && active) || (canManage && active) ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {canEdit && next && (
            <Button size="sm" disabled={busy} onClick={() => onAdvance(next)}>
              Move to {STATUS_LABELS[next]}
            </Button>
          )}
          {canManage && active && (
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onTerminate('no_show')}>
                Mark no-show
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onTerminate('cancelled')}>
                Cancel job
              </Button>
            </>
          )}
        </div>
      ) : null}
    </JobSection>
  );
}

// ============================================================
// CUSTOMER
// ============================================================

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-text-primary">{children}</dd>
    </div>
  );
}

export function JobCustomerCard({ job }: { job: Job }) {
  const link = 'focus-ring inline-flex items-center gap-1.5 font-medium text-accent hover:underline';
  return (
    <JobSection title="Customer & visit" icon={UserIcon}>
      <h3 className="text-base font-bold text-text-primary">{job.customer_name}</h3>
      {job.service_type && <p className="text-sm text-text-secondary">{job.service_type}</p>}

      {job.is_rework && (
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-warning-500/10 px-3 py-2 text-xs font-medium text-warning-500">
          <RotateCcw size={13} aria-hidden="true" /> Repeat visit for the same customer and service type
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact label="Scheduled">{formatWhen(job.scheduled_datetime)}</Fact>
        <Fact label="Duration">{formatDuration(job.duration_minutes)}</Fact>
        <Fact label="Phone">
          {job.customer_phone ? (
            <a href={telHref(job.customer_phone)} className={link}>
              <Phone size={13} aria-hidden="true" /> {job.customer_phone}
            </a>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label="Type">{job.customer_type === 'commercial' ? 'Commercial' : 'Residential'}</Fact>
        <div className="col-span-2 min-w-0">
          <dt className="text-xs text-text-secondary">Address</dt>
          <dd className="mt-0.5 text-sm text-text-primary">
            {job.address ? (
              <a href={mapsLink(job.address)} target="_blank" rel="noopener noreferrer" className={link}>
                <MapPin size={13} aria-hidden="true" /> {job.address}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </div>
        {job.sla_response_hours !== null && <Fact label="SLA response">{job.sla_response_hours} h</Fact>}
        {job.contract_reference && <Fact label="Contract">{job.contract_reference}</Fact>}
      </dl>

      {Array.isArray(job.tags) && job.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {job.tags.map((t) => (
            <Pill key={t} className="bg-bg-tertiary text-text-secondary">
              {t}
            </Pill>
          ))}
        </div>
      )}
    </JobSection>
  );
}

// ============================================================
// TECHNICIAN
// ============================================================

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function JobTechnicianCard({
  job,
  technician,
  loading,
  error,
  onRetry,
}: {
  job: Job;
  technician: JobTechnician | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const link = 'focus-ring inline-flex items-center gap-1.5 text-accent hover:underline';
  const travelling = job.job_status === 'en_route' || job.job_status === 'in_progress';
  const hasPosition = travelling && job.technician_lat !== null && job.technician_lng !== null;

  let body: ReactNode;
  if (!job.assigned_technician_id) {
    body = <p className="text-sm text-text-secondary">Unassigned. Assign a technician from the Jobs board.</p>;
  } else if (loading && !technician) {
    body = <SectionSkeleton rows={2} />;
  } else if (error) {
    body = <SectionError onRetry={onRetry} />;
  } else if (!technician) {
    body = <p className="text-sm text-text-secondary">The assigned technician is no longer on your team.</p>;
  } else {
    const name = technician.member_name?.trim() || technician.member_email;
    body = (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent" aria-hidden="true">
            {initials(name) || <Wrench size={16} />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
            <p className="truncate text-xs text-text-secondary">{technician.member_email}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {technician.member_phone && (
            <a href={telHref(technician.member_phone)} className={link}>
              <Phone size={13} aria-hidden="true" /> {technician.member_phone}
            </a>
          )}
          <a href={`mailto:${technician.member_email}`} className={link}>
            <Mail size={13} aria-hidden="true" /> Email
          </a>
        </div>
        {technician.skills.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {technician.skills.map((s) => (
              <Pill key={s} className="bg-bg-tertiary text-text-secondary">
                {s}
              </Pill>
            ))}
          </div>
        )}
        {job.job_status === 'en_route' && job.eta_minutes !== null && (
          <p className="rounded-xl bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-500">
            ETA about {job.eta_minutes} min{job.eta_set_at ? ` (shared ${relativeTime(job.eta_set_at)})` : ''}
          </p>
        )}
        {hasPosition && (
          <a
            href={mapsLink(`${job.technician_lat},${job.technician_lng}`)}
            target="_blank"
            rel="noopener noreferrer"
            className={`${link} text-xs`}
          >
            <Navigation size={12} aria-hidden="true" /> Last seen {job.location_updated_at ? relativeTime(job.location_updated_at) : 'recently'}
          </a>
        )}
      </div>
    );
  }

  return (
    <JobSection title="Technician" icon={Wrench}>
      {body}
    </JobSection>
  );
}

// ============================================================
// NOTES
// ============================================================

const NOTE_FIELDS = [
  { key: 'dispatch_note', label: 'Dispatch note', hint: 'Internal instructions for the technician (gate codes, parking, access).' },
  { key: 'diagnosis_notes', label: 'Diagnosis', hint: 'What was found on site.' },
  { key: 'work_performed_notes', label: 'Work performed', hint: 'What was done — shown to the customer in their job room.' },
] as const;

type NoteKey = (typeof NOTE_FIELDS)[number]['key'];

const serverValue = (job: Job, key: NoteKey): string => (job[key] ?? '') as string;

function initialNoteState(job: Job) {
  const drafts = {} as Record<NoteKey, string>;
  const stale = {} as Record<NoteKey, boolean>;
  for (const f of NOTE_FIELDS) {
    drafts[f.key] = serverValue(job, f.key);
    stale[f.key] = false;
  }
  return { drafts, stale };
}

export function JobNotesCard({
  job,
  canEdit,
  onSave,
}: {
  job: Job;
  canEdit: boolean;
  /** Resolves true when saved; the card keeps the draft otherwise. */
  onSave: (patch: JobNotesPatch) => Promise<boolean>;
}) {
  const [state, setState] = useState(() => initialNoteState(job));
  const [saving, setSaving] = useState(false);
  const synced = useRef<Record<NoteKey, string>>(initialNoteState(job).drafts);

  const sDispatch = serverValue(job, 'dispatch_note');
  const sDiagnosis = serverValue(job, 'diagnosis_notes');
  const sWork = serverValue(job, 'work_performed_notes');

  // Pull in changes made elsewhere, but never clobber a draft being typed.
  useEffect(() => {
    const incoming: Record<NoteKey, string> = { dispatch_note: sDispatch, diagnosis_notes: sDiagnosis, work_performed_notes: sWork };
    setState((prev) => {
      const drafts = { ...prev.drafts };
      const stale = { ...prev.stale };
      for (const f of NOTE_FIELDS) {
        const server = incoming[f.key];
        if (server === synced.current[f.key]) continue;
        const draft = prev.drafts[f.key];
        if (draft === synced.current[f.key] || draft.trim() === server.trim()) {
          // Untouched draft, or the server just caught up with what we saved: follow the server.
          drafts[f.key] = server;
          stale[f.key] = false;
        } else {
          stale[f.key] = true; // being edited: keep the draft, warn instead
        }
        synced.current[f.key] = server;
      }
      return { drafts, stale };
    });
  }, [sDispatch, sDiagnosis, sWork]);

  const incomingNow: Record<NoteKey, string> = { dispatch_note: sDispatch, diagnosis_notes: sDiagnosis, work_performed_notes: sWork };
  const dirtyKeys = NOTE_FIELDS.map((f) => f.key).filter((k) => state.drafts[k].trim() !== incomingNow[k].trim());

  const save = async () => {
    if (saving || dirtyKeys.length === 0) return;
    setSaving(true);
    const patch: JobNotesPatch = {};
    for (const k of dirtyKeys) patch[k] = state.drafts[k];
    const ok = await onSave(patch);
    setSaving(false);
    if (ok) setState((p) => ({ ...p, stale: { dispatch_note: false, diagnosis_notes: false, work_performed_notes: false } }));
  };

  const reset = () =>
    setState({
      drafts: { dispatch_note: sDispatch, diagnosis_notes: sDiagnosis, work_performed_notes: sWork },
      stale: { dispatch_note: false, diagnosis_notes: false, work_performed_notes: false },
    });

  const completionNotes = job.completion_notes?.trim();
  const techDiagnosis = job.technician_diagnosis?.trim();

  return (
    <JobSection title="Notes" icon={StickyNote}>
      <div className="space-y-4">
        {NOTE_FIELDS.map((f) => (
          <div key={f.key}>
            {canEdit ? (
              <>
                <Textarea
                  label={f.label}
                  rows={3}
                  maxLength={4000}
                  value={state.drafts[f.key]}
                  onChange={(e) => {
                    const value = e.target.value;
                    setState((p) => ({ ...p, drafts: { ...p.drafts, [f.key]: value } }));
                  }}
                />
                <p className="mt-1 text-xs text-text-secondary">{f.hint}</p>
                {state.stale[f.key] && (
                  <p role="status" className="mt-1 text-xs font-medium text-warning-500">
                    Someone else changed this note while you were editing. Saving will overwrite their version.
                  </p>
                )}
              </>
            ) : (
              <>
                <h3 className="text-xs font-medium text-text-secondary">{f.label}</h3>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-text-primary">{serverValue(job, f.key) || 'Nothing recorded.'}</p>
              </>
            )}
          </div>
        ))}

        {techDiagnosis && (
          <div>
            <h3 className="text-xs font-medium text-text-secondary">Technician diagnosis (field app)</h3>
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-text-primary">{techDiagnosis}</p>
          </div>
        )}
        {completionNotes && (
          <div>
            <h3 className="text-xs font-medium text-text-secondary">Completion notes</h3>
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-text-primary">{completionNotes}</p>
          </div>
        )}

        {canEdit && (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={saving || dirtyKeys.length === 0} onClick={reset}>
              Discard
            </Button>
            <Button size="sm" disabled={saving || dirtyKeys.length === 0} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save notes'}
            </Button>
          </div>
        )}
      </div>
    </JobSection>
  );
}
