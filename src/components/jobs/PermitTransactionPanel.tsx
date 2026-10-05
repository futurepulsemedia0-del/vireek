import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileCheck2,
  Loader2,
  Plus,
  ExternalLink,
  Sparkles,
  ChevronDown,
  TriangleAlert as AlertTriangle,
} from 'lucide-react';
import { EmptyStateInline } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { fetchComplianceReview, type ComplianceReview } from '@/lib/permitCompliance';
import {
  INACTIVE_STATUSES,
  INSPECTION_KIND_LABELS,
  INSPECTION_STATUS_LABELS,
  MISSING_INPUT_LABELS,
  PERMIT_TYPES,
  PERMIT_TYPE_LABELS,
  PIPELINE_STAGES,
  STATUS_META,
  addPermitInspection,
  createPermitApplication,
  fetchJobPermits,
  fetchPermitAuthorities,
  fetchPermitEvents,
  fetchPermitInspections,
  inferPermitTypes,
  isFollowUpDue,
  nextActions,
  preparePermitPacket,
  recordInspectionResult,
  safeHttpUrl,
  suggestAuthority,
  transitionPermitApplication,
  updatePermitApplication,
  type InspectionKind,
  type PermitApplication,
  type PermitAuthority,
  type PermitEvent,
  type PermitInspection,
  type PermitPatch,
  type PermitType,
} from '@/lib/permitTransactions';

// Dense, in-card field style (the shared <Input> is sized for full forms, not a compact job panel).
const denseField =
  'focus-ring w-full rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary placeholder:text-text-secondary/60 disabled:opacity-50';

/** Minimal job shape so both the dashboard `Job` and the technician brief can use the panel. */
export interface PermitPanelJob {
  id: string;
  job_status: string;
  address?: string | null;
  service_type?: string | null;
  dispatch_note?: string | null;
}

// ---------------------------------------------------------------------------
// Stage tracker
// ---------------------------------------------------------------------------

function StageTracker({ app }: { app: PermitApplication }) {
  const status = app.status === 'corrections_required' ? 'in_review' : app.status;
  const current = PIPELINE_STAGES.findIndex((s) => s.status === status);
  if (current === -1) return null; // rejected / withdrawn / expired: the badge says it
  return (
    <ol className="mt-2 flex gap-1" aria-label="Permit progress">
      {PIPELINE_STAGES.map((s, i) => (
        <li key={s.status} className="min-w-0 flex-1">
          <div
            className={`h-1.5 rounded-full ${
              i < current ? 'bg-success-500' : i === current ? 'bg-accent' : 'bg-bg-tertiary'
            }`}
          />
          <p
            className={`mt-1 truncate text-[10px] ${
              i === current ? 'font-medium text-text-primary' : 'text-text-secondary'
            }`}
          >
            {s.label}
          </p>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

function InspectionsBlock({
  app,
  onChanged,
}: {
  app: PermitApplication;
  onChanged: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const [items, setItems] = useState<PermitInspection[]>([]);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<InspectionKind>('final');
  const [label, setLabel] = useState('');
  const [when, setWhen] = useState('');
  const canAdd = app.status === 'issued' || app.status === 'in_inspection';

  const load = useCallback(async () => {
    try {
      setItems(await fetchPermitInspections(app.id));
    } catch {
      /* background load: stay empty */
    }
  }, [app.id]);

  useEffect(() => {
    void load();
  }, [load, app.updated_at]);

  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : failure, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!canAdd && items.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg border border-border/70 p-2.5">
      <p className="text-xs font-semibold text-text-primary">Inspections</p>
      {items.length === 0 && (
        <p className="mt-1 text-xs text-text-secondary">
          No inspections yet — add the first one below.
        </p>
      )}
      <ul className="mt-1.5 space-y-1.5">
        {items.map((i) => (
          <li key={i.id} className="rounded-md bg-bg-primary p-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-text-primary">
                {INSPECTION_KIND_LABELS[i.kind]}
                {i.label ? ` — ${i.label}` : ''}
              </span>
              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">
                {INSPECTION_STATUS_LABELS[i.status]}
              </span>
              {i.scheduled_for && (
                <span className="text-text-secondary">
                  {new Date(i.scheduled_for).toLocaleString([], {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              )}
            </div>
            {i.result_note && <p className="mt-1 text-text-secondary">{i.result_note}</p>}
            {canAdd &&
              (i.status === 'requested' || i.status === 'scheduled' || i.status === 'failed') && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => recordInspectionResult({ inspectionId: i.id, status: 'passed' }),
                        'Could not save the result.',
                      )
                    }
                    className="focus-ring rounded-md bg-success-500/10 px-2 py-1 text-success-500 disabled:opacity-50"
                  >
                    Passed
                  </button>
                  {i.status !== 'failed' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => recordInspectionResult({ inspectionId: i.id, status: 'failed' }),
                          'Could not save the result.',
                        )
                      }
                      className="focus-ring rounded-md bg-danger/10 px-2 py-1 text-danger disabled:opacity-50"
                    >
                      Failed
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => recordInspectionResult({ inspectionId: i.id, status: 'cancelled' }),
                        'Could not save the result.',
                      )
                    }
                    className="focus-ring rounded-md bg-bg-tertiary px-2 py-1 text-text-secondary disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              )}
          </li>
        ))}
      </ul>
      {canAdd && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Inspection type"
            value={kind}
            onChange={(e) => setKind(e.target.value as InspectionKind)}
            className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-xs text-text-primary"
          >
            {(Object.keys(INSPECTION_KIND_LABELS) as InspectionKind[]).map((k) => (
              <option key={k} value={k}>
                {INSPECTION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={120}
            aria-label="Inspection label"
            placeholder="Label (optional)"
            className={`${denseField} w-32 flex-1`}
          />
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            aria-label="Inspection date and time"
            className={`${denseField} w-auto`}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await addPermitInspection({
                  applicationId: app.id,
                  kind,
                  label,
                  scheduledFor: when ? new Date(when).toISOString() : null,
                });
                setLabel('');
                setWhen('');
              }, 'Could not add the inspection.')
            }
            className="focus-ring inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One application
// ---------------------------------------------------------------------------

function ApplicationCard({
  app,
  authorities,
  jurisdiction,
  onApp,
}: {
  app: PermitApplication;
  authorities: PermitAuthority[];
  jurisdiction: { city?: string | null; state?: string | null } | null;
  onApp: (next: PermitApplication) => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [events, setEvents] = useState<PermitEvent[]>([]);
  const [note, setNote] = useState('');

  const [scope, setScope] = useState(app.scope_description ?? '');
  const [formName, setFormName] = useState(app.form_name ?? '');
  const [ownerName, setOwnerName] = useState(app.application_data.owner_name ?? '');
  const [license, setLicense] = useState(app.application_data.contractor_license ?? '');
  const [valuation, setValuation] = useState(app.application_data.job_valuation ?? '');
  const [reference, setReference] = useState(app.reference_number ?? '');
  const [permitNumber, setPermitNumber] = useState(app.permit_number ?? '');
  const [fee, setFee] = useState(app.fee_amount != null ? String(app.fee_amount) : '');
  const [expires, setExpires] = useState(app.expires_at ?? '');

  // Re-sync drafts after a server-confirmed save (blur-commit means nothing is mid-typing).
  useEffect(() => {
    setScope(app.scope_description ?? '');
    setFormName(app.form_name ?? '');
    setOwnerName(app.application_data.owner_name ?? '');
    setLicense(app.application_data.contractor_license ?? '');
    setValuation(app.application_data.job_valuation ?? '');
    setReference(app.reference_number ?? '');
    setPermitNumber(app.permit_number ?? '');
    setFee(app.fee_amount != null ? String(app.fee_amount) : '');
    setExpires(app.expires_at ?? '');
  }, [app]);

  const authority = authorities.find((a) => a.id === app.authority_id) ?? null;
  const suggested = useMemo(
    () => (app.authority_id ? null : suggestAuthority(authorities, jurisdiction)),
    [app.authority_id, authorities, jurisdiction],
  );
  const portalUrl = safeHttpUrl(authority?.portal_url);
  const locked = app.status === 'closed' || app.status === 'withdrawn';
  const followUp = isFollowUpDue(app, authority?.typical_turnaround_days);
  const meta = STATUS_META[app.status];

  const loadEvents = useCallback(async () => {
    try {
      setEvents(await fetchPermitEvents(app.id));
    } catch {
      /* background */
    }
  }, [app.id]);

  useEffect(() => {
    if (showLog) void loadEvents();
  }, [showLog, loadEvents, app.updated_at]);

  const save = useCallback(
    async (patch: PermitPatch) => {
      setSaving(true);
      try {
        onApp(await updatePermitApplication(app.id, patch));
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not save this update.', 'error');
      } finally {
        setSaving(false);
      }
    },
    [app.id, onApp, toast],
  );

  const commitData = (key: string, value: string) => {
    if ((app.application_data[key] ?? '') === value.trim()) return;
    void save({ application_data: { [key]: value.trim() } });
  };

  const commitFee = () => {
    const n = fee.trim() === '' ? null : Number(fee);
    if (n !== null && (!Number.isFinite(n) || n < 0)) {
      toast('Enter a valid fee amount.', 'error');
      setFee(app.fee_amount != null ? String(app.fee_amount) : '');
      return;
    }
    if (n === app.fee_amount) return;
    void save({ fee_amount: n });
  };

  const transition = async (to: PermitApplication['status']) => {
    setSaving(true);
    try {
      onApp(await transitionPermitApplication(app.id, to, note));
      setNote('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the permit status.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const prepare = async () => {
    setPreparing(true);
    try {
      await preparePermitPacket(app.id);
      // agent_packet is service-role written: refetch the row to show it.
      const [fresh] = (await fetchJobPermits(app.job_id)).filter((a) => a.id === app.id);
      if (fresh) onApp(fresh);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not prepare the packet.', 'error');
    } finally {
      setPreparing(false);
    }
  };

  const packet = app.agent_packet;
  const missing = app.readiness?.missing ?? [];

  return (
    <li className="rounded-lg border border-border/70 bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium text-text-primary">
          {PERMIT_TYPE_LABELS[app.permit_type]} permit
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>
          {meta.label}
        </span>
        {followUp && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] text-warning-500">
            <AlertTriangle size={10} /> Follow up with the AHJ
          </span>
        )}
        {saving && <Loader2 size={13} className="animate-spin text-text-secondary" />}
      </div>
      <StageTracker app={app} />

      {/* Authority + form */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div>
          <label className="text-[11px] text-text-secondary" htmlFor={`auth-${app.id}`}>
            Permitting authority (AHJ)
          </label>
          <select
            id={`auth-${app.id}`}
            value={app.authority_id ?? ''}
            disabled={locked || saving}
            onChange={(e) => void save({ authority_id: e.target.value || null })}
            className={denseField}
          >
            <option value="">Select…</option>
            {authorities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.city ? ` — ${a.city}` : ''}
                {a.verified ? ' ✓' : ''}
              </option>
            ))}
          </select>
          {suggested && !locked && (
            <button
              type="button"
              onClick={() => void save({ authority_id: suggested.id })}
              className="focus-ring mt-1 text-[11px] text-accent hover:underline"
            >
              Use suggested: {suggested.name}
            </button>
          )}
          {authorities.length === 0 && (
            <p className="mt-1 text-[11px] text-text-secondary">
              No authorities saved yet — add yours in the Permit Center.
            </p>
          )}
        </div>
        <div>
          <label className="text-[11px] text-text-secondary" htmlFor={`form-${app.id}`}>
            Form / application name
          </label>
          <input
            id={`form-${app.id}`}
            value={formName}
            disabled={locked}
            maxLength={160}
            onChange={(e) => setFormName(e.target.value)}
            onBlur={() =>
              formName.trim() !== (app.form_name ?? '') &&
              void save({ form_name: formName.trim() || null })
            }
            placeholder="As named on the AHJ's site"
            className={denseField}
          />
        </div>
      </div>
      {authority && (
        <p className="mt-1.5 text-[11px] text-text-secondary">
          {authority.submission_method === 'portal'
            ? 'Files via portal'
            : `Files by ${authority.submission_method.replace('_', ' ')}`}
          {authority.typical_turnaround_days != null &&
            ` · typically ~${authority.typical_turnaround_days} days`}
          {!authority.verified && ' · details not yet verified'}
          {portalUrl && (
            <>
              {' · '}
              <a
                href={portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-ring inline-flex items-center gap-0.5 text-accent hover:underline"
              >
                Open portal <ExternalLink size={10} />
              </a>
            </>
          )}
        </p>
      )}

      {/* Scope + AI packet */}
      <div className="mt-3">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[11px] text-text-secondary" htmlFor={`scope-${app.id}`}>
            Scope of work
          </label>
          {!locked && (
            <button
              type="button"
              onClick={() => void prepare()}
              disabled={preparing}
              className="focus-ring inline-flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-50"
            >
              {preparing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              {packet ? 'Refresh AI draft' : 'Draft with AI'}
            </button>
          )}
        </div>
        <textarea
          id={`scope-${app.id}`}
          value={scope}
          disabled={locked}
          maxLength={2000}
          rows={3}
          onChange={(e) => setScope(e.target.value)}
          onBlur={() =>
            scope.trim() !== (app.scope_description ?? '') &&
            void save({ scope_description: scope.trim() || null })
          }
          placeholder="Describe the work to be performed (20+ characters)"
          className={denseField}
        />
        {packet && (
          <div className="mt-2 rounded-lg border border-accent/20 bg-accent/5 p-2.5 text-xs">
            <p className="inline-flex items-center gap-1 font-medium text-accent">
              <Sparkles size={11} /> Draft — review and verify with the AHJ before filing
            </p>
            {packet.scope_draft && (
              <div className="mt-1.5">
                <p className="leading-relaxed text-text-secondary">{packet.scope_draft}</p>
                {!locked && packet.scope_draft !== scope.trim() && (
                  <button
                    type="button"
                    onClick={() => void save({ scope_description: packet.scope_draft })}
                    className="focus-ring mt-1 text-accent hover:underline"
                  >
                    Use this scope
                  </button>
                )}
              </div>
            )}
            {packet.documents.length > 0 && (
              <div className="mt-2">
                <p className="font-medium text-text-primary">Typical documents to gather</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-text-secondary">
                  {packet.documents.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {packet.verify_questions.length > 0 && (
              <div className="mt-2">
                <p className="font-medium text-text-primary">Confirm with the AHJ</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-text-secondary">
                  {packet.verify_questions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Application details */}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div>
          <label className="text-[11px] text-text-secondary" htmlFor={`own-${app.id}`}>
            Property owner
          </label>
          <input
            id={`own-${app.id}`}
            value={ownerName}
            disabled={locked}
            maxLength={120}
            onChange={(e) => setOwnerName(e.target.value)}
            onBlur={() => commitData('owner_name', ownerName)}
            className={denseField}
          />
        </div>
        <div>
          <label className="text-[11px] text-text-secondary" htmlFor={`lic-${app.id}`}>
            Contractor license #
          </label>
          <input
            id={`lic-${app.id}`}
            value={license}
            disabled={locked}
            maxLength={60}
            onChange={(e) => setLicense(e.target.value)}
            onBlur={() => commitData('contractor_license', license)}
            className={denseField}
          />
        </div>
        <div>
          <label className="text-[11px] text-text-secondary" htmlFor={`val-${app.id}`}>
            Job valuation
          </label>
          <input
            id={`val-${app.id}`}
            value={valuation}
            disabled={locked}
            maxLength={30}
            inputMode="decimal"
            onChange={(e) => setValuation(e.target.value)}
            onBlur={() => commitData('job_valuation', valuation)}
            placeholder="e.g. 8500"
            className={denseField}
          />
        </div>
      </div>

      {/* Readiness */}
      {(app.status === 'draft' || app.status === 'ready_to_file') && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-text-secondary">
            <span>Application readiness</span>
            <span>{app.readiness?.score ?? 0}%</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-bg-tertiary">
            <div
              className="h-1.5 rounded-full bg-accent transition-all"
              style={{ width: `${app.readiness?.score ?? 0}%` }}
            />
          </div>
          {missing.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-text-secondary">
              {missing.map((m) => (
                <li key={m}>{MISSING_INPUT_LABELS[m] ?? m}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Filing / tracking numbers */}
      {app.status !== 'draft' && (
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <div>
            <label className="text-[11px] text-text-secondary" htmlFor={`ref-${app.id}`}>
              Application / tracking #
            </label>
            <input
              id={`ref-${app.id}`}
              value={reference}
              disabled={locked}
              maxLength={80}
              onChange={(e) => setReference(e.target.value)}
              onBlur={() =>
                reference.trim() !== (app.reference_number ?? '') &&
                void save({ reference_number: reference.trim() || null })
              }
              className={denseField}
            />
          </div>
          <div>
            <label className="text-[11px] text-text-secondary" htmlFor={`pn-${app.id}`}>
              Permit #
            </label>
            <input
              id={`pn-${app.id}`}
              value={permitNumber}
              disabled={locked}
              maxLength={80}
              onChange={(e) => setPermitNumber(e.target.value)}
              onBlur={() =>
                permitNumber.trim() !== (app.permit_number ?? '') &&
                void save({ permit_number: permitNumber.trim() || null })
              }
              className={denseField}
            />
          </div>
          <div>
            <label className="text-[11px] text-text-secondary" htmlFor={`fee-${app.id}`}>
              Fee
            </label>
            <input
              id={`fee-${app.id}`}
              value={fee}
              disabled={locked}
              inputMode="decimal"
              maxLength={12}
              onChange={(e) => setFee(e.target.value)}
              onBlur={commitFee}
              className={denseField}
            />
            <label className="mt-1 flex items-center gap-1 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={!!app.fee_paid_at}
                disabled={locked || saving}
                onChange={(e) => void save({ fee_paid: e.target.checked })}
              />{' '}
              Paid
            </label>
          </div>
          <div>
            <label className="text-[11px] text-text-secondary" htmlFor={`exp-${app.id}`}>
              Permit expires
            </label>
            <input
              id={`exp-${app.id}`}
              type="date"
              value={expires}
              disabled={locked}
              onChange={(e) => setExpires(e.target.value)}
              onBlur={() =>
                expires !== (app.expires_at ?? '') && void save({ expires_at: expires || null })
              }
              className={denseField}
            />
          </div>
        </div>
      )}

      <InspectionsBlock
        app={app}
        onChanged={async () => {
          const [fresh] = (await fetchJobPermits(app.job_id)).filter((a) => a.id === app.id);
          if (fresh) onApp(fresh);
        }}
      />

      {/* Actions */}
      {nextActions(app.status).length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            aria-label="Timeline note"
            placeholder="Note for the timeline (optional)"
            className={`${denseField} min-w-[10rem] flex-1`}
          />
          {nextActions(app.status).map((a) => (
            <button
              key={a.to}
              type="button"
              disabled={saving}
              onClick={() => void transition(a.to)}
              className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                a.tone === 'primary'
                  ? 'bg-accent text-white hover:opacity-90'
                  : a.tone === 'danger'
                    ? 'bg-danger/10 text-danger'
                    : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* Timeline */}
      <button
        type="button"
        onClick={() => setShowLog((v) => !v)}
        aria-expanded={showLog}
        className="focus-ring mt-3 inline-flex items-center gap-1 text-[11px] text-text-secondary hover:text-text-primary"
      >
        <ChevronDown size={12} className={showLog ? 'rotate-180' : ''} /> Timeline
      </button>
      {showLog && (
        <ul className="mt-1.5 space-y-1 text-[11px] text-text-secondary">
          {events.length === 0 && (
            <li>
              <EmptyStateInline text="No events yet." />
            </li>
          )}
          {events.map((e) => (
            <li key={e.id}>
              <span className="text-text-primary">
                {new Date(e.created_at).toLocaleString([], {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
              {' — '}
              {e.event_type.replace(/_/g, ' ')}
              {e.note ? `: ${e.note}` : ''}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function PermitTransactionPanel({ job }: { job: PermitPanelJob }) {
  const { toast } = useToast();
  const [apps, setApps] = useState<PermitApplication[]>([]);
  const [authorities, setAuthorities] = useState<PermitAuthority[]>([]);
  const [review, setReview] = useState<ComplianceReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [newType, setNewType] = useState<PermitType>('electrical');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setApps([]);
    setExpanded(false);
    Promise.all([
      fetchJobPermits(job.id),
      fetchPermitAuthorities().catch(() => [] as PermitAuthority[]),
      fetchComplianceReview(job.id).catch(() => null),
    ])
      .then(([a, auth, r]) => {
        if (cancelled) return;
        setApps(a);
        setAuthorities(auth);
        setReview(r);
        setExpanded(a.some((x) => !INACTIVE_STATUSES.has(x.status)));
      })
      .catch(() => {
        /* panel stays empty — not worth a toast on a background load */
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [job.id]);

  const activeTypes = useMemo(
    () => new Set(apps.filter((a) => !INACTIVE_STATUSES.has(a.status)).map((a) => a.permit_type)),
    [apps],
  );
  const suggestedTypes = useMemo(
    () => inferPermitTypes(review, job.service_type).filter((t) => !activeTypes.has(t)),
    [review, job.service_type, activeTypes],
  );
  const jurisdiction = review?.jurisdiction ?? null;

  const start = async (type: PermitType) => {
    setCreating(true);
    try {
      const created = await createPermitApplication({
        jobId: job.id,
        permitType: type,
        authorityId: suggestAuthority(authorities, jurisdiction)?.id ?? null,
        reviewId: review?.id ?? null,
      });
      setApps((prev) => [...prev, created]);
      setExpanded(true);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : 'Could not start the permit application.',
        'error',
      );
    } finally {
      setCreating(false);
    }
  };

  const replaceApp = useCallback((next: PermitApplication) => {
    setApps((prev) => prev.map((a) => (a.id === next.id ? next : a)));
  }, []);

  if (loading) return null;
  // Nothing to show until there is a permit in play or one is plausibly needed.
  if (apps.length === 0 && suggestedTypes.length === 0 && !expanded) {
    return (
      <section className="rounded-lg border border-border bg-bg-secondary p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="inline-flex items-center gap-2 text-sm font-semibold text-text-primary">
            <FileCheck2 size={15} className="text-accent" /> Permit Transaction
          </p>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="focus-ring text-xs text-accent hover:underline"
          >
            Start a permit
          </button>
        </div>
      </section>
    );
  }

  const activeCount = apps.filter((a) => !INACTIVE_STATUSES.has(a.status)).length;

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-text-primary">
          <FileCheck2 size={15} className="text-accent" /> Permit Transaction
          {activeCount > 0 && (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
              {activeCount} active
            </span>
          )}
        </span>
        <ChevronDown size={14} className={`text-text-secondary ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="mt-3">
          {apps.length > 0 && (
            <ul className="space-y-3">
              {apps.map((a) => (
                <ApplicationCard
                  key={a.id}
                  app={a}
                  authorities={authorities}
                  jurisdiction={jurisdiction}
                  onApp={replaceApp}
                />
              ))}
            </ul>
          )}

          <div className={`${apps.length > 0 ? 'mt-3 border-t border-border/70 pt-3' : ''}`}>
            {suggestedTypes.length > 0 && (
              <p className="mb-2 text-xs text-text-secondary">
                The compliance review suggests a permit may be needed for this job.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {suggestedTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={creating}
                  onClick={() => void start(t)}
                  className="focus-ring inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <Plus size={12} /> Start {PERMIT_TYPE_LABELS[t].toLowerCase()} permit
                </button>
              ))}
              <select
                aria-label="Permit type"
                value={newType}
                onChange={(e) => setNewType(e.target.value as PermitType)}
                className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary"
              >
                {PERMIT_TYPES.filter((t) => !activeTypes.has(t)).map((t) => (
                  <option key={t} value={t}>
                    {PERMIT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={creating || activeTypes.has(newType)}
                onClick={() => void start(newType)}
                className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
              >
                {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}{' '}
                Start permit
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
