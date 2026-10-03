/**
 * Verified Service — /dashboard/service-guarantee
 *
 * Post-completion Service Outcome Guarantee: every completed job is verified at
 * 48 hours, 7 days and 30 days. When a failure is reported or detected, Vireek
 * checks warranty + parts, attaches the recorded root cause, ranks the best
 * technician with the Outcome Assurance model, and the owner approves a
 * recovery visit. See src/lib/serviceGuarantee.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, Link2, RefreshCw, Settings2, ShieldCheck, Wrench } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { fetchAssuranceSettings, gatherAssuranceContext, formatDuration, type AssuranceContext } from '@/lib/outcomeAssurance';
import {
  CLAIM_SOURCE_LABELS,
  COVERAGE_LIMITS,
  DEFAULT_GUARANTEE_SETTINGS,
  EVENT_LABELS,
  EVIDENCE_LABELS,
  STAGES,
  STAGE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  claimAgeHours,
  clampCoverageDays,
  createRedispatch,
  fetchGuaranteeBundle,
  fetchGuaranteeEvents,
  fetchGuaranteeSettings,
  fetchJobDuration,
  fetchJobToken,
  fetchTeamNames,
  getPublicGuaranteeLink,
  nextStepLabel,
  openStaffClaim,
  rankRecoveryTechnicians,
  resolveClaim,
  saveGuaranteeSettings,
  summarizeGuarantees,
  verificationProgress,
  voidGuarantee,
  type CheckpointRow,
  type ClaimRow,
  type GuaranteeBundle,
  type GuaranteeEventRow,
  type GuaranteeRow,
  type GuaranteeSettings,
  type RecoveryCandidate,
} from '@/lib/serviceGuarantee';

type Filter = 'action' | 'active' | 'closed' | 'all';

const REFRESH_MS = 60_000;
const CLOSED: ReadonlySet<string> = new Set(['recovered', 'expired', 'voided']);

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return 'Something went wrong';
}

function defaultRecoveryTime(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatCard({ label, value, valueClass = 'text-text-primary', hint }: { label: string; value: string | number; valueClass?: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${valueClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-text-secondary">{hint}</p>}
    </div>
  );
}

// ============================================================
// STEPPER
// ============================================================

function Stepper({ checkpoints }: { checkpoints: CheckpointRow[] }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Verification checkpoints">
      {STAGES.map((stage) => {
        const c = checkpoints.find((x) => x.stage === stage);
        const status = c?.status ?? 'pending';
        const tone =
          status === 'passed'
            ? 'bg-success-500/15 text-success-500'
            : status === 'failed'
              ? 'bg-danger/15 text-danger'
              : status === 'voided'
                ? 'bg-bg-tertiary text-text-secondary/50'
                : 'bg-bg-tertiary text-text-secondary';
        return (
          <li key={stage} className={`flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${tone}`}>
            {status === 'passed' ? <Check size={11} aria-hidden /> : status === 'failed' ? <AlertTriangle size={11} aria-hidden /> : null}
            {STAGE_LABELS[stage]}
            <span className="sr-only"> {status}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ============================================================
// SETTINGS
// ============================================================

function SettingsPanel({ settings, isOwner, onSaved }: { settings: GuaranteeSettings; isOwner: boolean; onSaved: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const save = async () => {
    setSaving(true);
    try {
      await saveGuaranteeSettings({ ...draft, coverage_days: clampCoverageDays(draft.coverage_days) });
      toast(draft.enabled ? 'Verified Service is on' : 'Verified Service is off');
      onSaved();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setSaving(false);
  };

  const check = (id: string, label: string, hint: string, key: 'enabled' | 'notify_customer' | 'notify_owner_on_failure') => (
    <label htmlFor={id} className="flex items-start gap-3 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4"
        checked={draft[key]}
        disabled={!isOwner}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
      />
      <span>
        <span className="font-medium text-text-primary">{label}</span>
        <span className="block text-xs text-text-secondary">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className="mb-5 space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
      {check('sg-enabled', 'Offer the Vireek Verified Service guarantee', 'Every job you complete from now on is verified at 48 hours, 7 days and 30 days. Existing completed jobs are not backfilled.', 'enabled')}
      <div className="flex items-center gap-3 text-sm">
        <label htmlFor="sg-days" className="font-medium text-text-primary">
          Coverage period (days)
        </label>
        <input
          id="sg-days"
          type="number"
          min={COVERAGE_LIMITS.min}
          max={COVERAGE_LIMITS.max}
          value={draft.coverage_days}
          disabled={!isOwner}
          onChange={(e) => setDraft({ ...draft, coverage_days: Number(e.target.value) })}
          className="focus-ring w-24 rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary disabled:opacity-60"
        />
        <span className="text-xs text-text-secondary">
          {COVERAGE_LIMITS.min}–{COVERAGE_LIMITS.max}. Customers can report an issue until it ends.
        </span>
      </div>
      {check('sg-cust', 'Text customers at each checkpoint', 'Uses your compliant SMS channel (A2P + STOP). Without it, checkpoints pass as "No issue reported" instead of "Customer-confirmed".', 'notify_customer')}
      {check('sg-owner', 'Alert me when a guarantee claim opens', 'In-app notification with a link to this page.', 'notify_owner_on_failure')}
      {isOwner ? (
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      ) : (
        <p className="text-xs text-text-secondary">Only the account owner can change these settings.</p>
      )}
    </div>
  );
}

// ============================================================
// CLAIM PANEL (warranty + parts + root cause + recovery planner)
// ============================================================

function ClaimPanel({
  claim,
  guarantee,
  techNames,
  isOwner,
  onChanged,
}: {
  claim: ClaimRow;
  guarantee: GuaranteeRow;
  techNames: Map<string, string>;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<RecoveryCandidate[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [when, setWhen] = useState(defaultRecoveryTime);
  const [pick, setPick] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<null | 'rejected' | 'resolved'>(null);
  const [closeNote, setCloseNote] = useState('');
  const ctxRef = useRef<AssuranceContext | null>(null);
  const durationRef = useRef<number | null>(null);

  const w = claim.warranty_check ?? {};
  const equipment = Array.isArray(w.equipment) ? w.equipment : [];
  const parts = Array.isArray(claim.parts_check?.parts_used) ? (claim.parts_check.parts_used as string[]) : [];
  const age = claimAgeHours(claim.created_at, Date.now());

  const whenIso = (): string | null => {
    const t = new Date(when);
    return Number.isFinite(t.getTime()) ? t.toISOString() : null;
  };

  const plan = async () => {
    const iso = whenIso();
    if (!iso) {
      toast('Pick a valid recovery time', 'error');
      return;
    }
    setPlanning(true);
    try {
      if (!ctxRef.current) {
        const [ctx, dur] = await Promise.all([gatherAssuranceContext(), fetchJobDuration(guarantee.job_id)]);
        ctxRef.current = ctx;
        durationRef.current = dur;
      }
      const settings = await fetchAssuranceSettings();
      const ranked = rankRecoveryTechnicians(
        ctxRef.current,
        { customer_name: guarantee.customer_name, service_type: guarantee.service_type, duration_minutes: durationRef.current, technician_id: guarantee.technician_id },
        iso,
        settings,
        4,
      );
      setCandidates(ranked);
      setPick(ranked[0]?.technicianId ?? '');
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setPlanning(false);
  };

  const approve = async () => {
    const iso = whenIso();
    if (!pick || !iso) return;
    setBusy(true);
    try {
      await createRedispatch({ claimId: claim.id, technicianId: pick, scheduledAt: iso, note });
      toast('Recovery visit scheduled');
      onChanged();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  const close = async () => {
    if (!closing) return;
    setBusy(true);
    try {
      await resolveClaim(claim.id, closing, closeNote.trim());
      toast(closing === 'rejected' ? 'Claim closed as not covered' : 'Claim resolved');
      setClosing(null);
      setCloseNote('');
      onChanged();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  const input = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary';

  return (
    <div className="space-y-3 rounded-xl border border-danger/30 bg-danger/5 p-3">
      <div>
        <p className="text-xs font-semibold text-danger">
          {CLAIM_SOURCE_LABELS[claim.source]} · {age < 1 ? 'just now' : `${age} h ago`}
          {claim.escalated_at && ' · escalated'}
        </p>
        {claim.description && <p className="mt-1 text-sm text-text-primary">“{claim.description}”</p>}
      </div>

      <div className="grid gap-2 text-xs text-text-secondary sm:grid-cols-2">
        <div className="rounded-lg bg-bg-primary p-2">
          <p className="mb-1 font-semibold text-text-primary">Warranty check</p>
          <p>Our workmanship: {w.workmanship_days_left ?? 0} day{w.workmanship_days_left === 1 ? '' : 's'} of cover left.</p>
          {equipment.length === 0 ? (
            <p>No equipment on file for this customer.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {equipment.map((e) => (
                <li key={e.id}>
                  {[e.make, e.model, e.type].filter(Boolean).join(' ')} ·{' '}
                  <span className={e.in_warranty ? 'text-success-500' : 'text-text-secondary'}>{e.in_warranty ? 'in manufacturer warranty' : 'out of warranty'}</span>
                </li>
              ))}
            </ul>
          )}
          {(w.manufacturer_claims ?? 0) > 0 && <p className="mt-1">{w.manufacturer_claims} manufacturer claim(s) already exist for this job.</p>}
          {equipment.some((e) => e.in_warranty) && (
            <Link to="/dashboard/warranty-claims" className="mt-1 inline-block text-accent hover:underline">
              Open Warranty Claim Recovery →
            </Link>
          )}
        </div>
        <div className="rounded-lg bg-bg-primary p-2">
          <p className="mb-1 font-semibold text-text-primary">Parts &amp; root cause</p>
          <p>Parts used: {parts.length ? parts.join(', ') : 'none recorded'}</p>
          <p>Recorded root cause: {claim.root_cause_key ? claim.root_cause_key.replace(/_/g, ' ') : 'not recorded'}</p>
          <Link to="/dashboard/callback-root-cause" className="mt-1 inline-block text-accent hover:underline">
            Analyse the callback cause →
          </Link>
        </div>
      </div>

      {claim.status === 'redispatched' && (
        <p className="text-xs text-text-secondary">
          Recovery visit scheduled{claim.proposed_technician_id ? ` with ${techNames.get(claim.proposed_technician_id) ?? 'a technician'}` : ''}.{' '}
          <Link to="/dashboard/jobs" className="text-accent hover:underline">
            View on the Jobs board →
          </Link>
        </p>
      )}

      {claim.status === 'open' && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-text-primary">Plan the recovery visit</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-text-secondary">
              When
              <input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setCandidates(null); }} className={`${input} mt-1`} />
            </label>
            <Button size="sm" variant="secondary" onClick={() => void plan()} disabled={planning}>
              <Wrench size={14} /> {planning ? 'Ranking…' : 'Find best technician'}
            </Button>
          </div>

          {candidates && candidates.length === 0 && <p className="text-xs text-warning-500">No dispatchable technician is available without a compliance gap. Resolve credentials first.</p>}
          {candidates && candidates.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="sr-only">Technician</legend>
              {candidates.map((c) => (
                <label key={c.technicianId} className="flex cursor-pointer items-start gap-2 rounded-lg bg-bg-primary p-2 text-xs">
                  <input type="radio" name={`tech-${claim.id}`} className="mt-0.5" checked={pick === c.technicianId} onChange={() => setPick(c.technicianId)} />
                  <span className="min-w-0">
                    <span className="font-medium text-text-primary">
                      {c.technicianName} · {Math.round(c.probability)}% estimated fix probability
                      {c.isOriginal && <span className="ml-1 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">original technician</span>}
                    </span>
                    {c.concerns.length > 0 && <span className="block text-text-secondary">{c.concerns.join('; ')}</span>}
                  </span>
                </label>
              ))}
              <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Note for the technician (optional)" className={input} aria-label="Note for the technician" />
              <Button size="sm" onClick={() => void approve()} disabled={busy || !pick}>
                Approve recovery visit
              </Button>
            </fieldset>
          )}
        </div>
      )}

      {closing ? (
        <div className="space-y-2">
          <input value={closeNote} maxLength={300} onChange={(e) => setCloseNote(e.target.value)} placeholder={closing === 'rejected' ? 'Why is this not covered? (audit trail)' : 'How was it fixed?'} className={input} aria-label="Closing note" />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void close()} disabled={busy || closeNote.trim().length < 3}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {claim.status === 'open' && (
            <Button size="sm" variant="ghost" onClick={() => setClosing('rejected')}>
              Not covered
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setClosing('resolved')}>
            Resolved without a visit
          </Button>
        </div>
      )}
      {!isOwner && claim.status === 'open' && <p className="text-[11px] text-text-secondary">Recovery visits can be approved by any dispatcher; voiding is owner-only.</p>}
    </div>
  );
}

// ============================================================
// CARD
// ============================================================

function GuaranteeCard({
  guarantee,
  checkpoints,
  claim,
  techNames,
  isOwner,
  open,
  onToggle,
  onChanged,
}: {
  guarantee: GuaranteeRow;
  checkpoints: CheckpointRow[];
  claim: ClaimRow | undefined;
  techNames: Map<string, string>;
  isOwner: boolean;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [events, setEvents] = useState<GuaranteeEventRow[] | null>(null);
  const [staffNote, setStaffNote] = useState('');
  const [showStaff, setShowStaff] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [showVoid, setShowVoid] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const live = !CLOSED.has(guarantee.status);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchGuaranteeEvents(guarantee.id).then((e) => {
      if (!cancelled) setEvents(e);
    });
    return () => {
      cancelled = true;
    };
  }, [open, guarantee.id, guarantee.status]);

  const copyLink = async () => {
    const token = await fetchJobToken(guarantee.job_id);
    if (!token) {
      toast('Could not build the customer link', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(getPublicGuaranteeLink(token));
      toast('Customer link copied');
    } catch {
      toast(getPublicGuaranteeLink(token));
    }
  };

  const submitStaff = async () => {
    setBusy(true);
    try {
      await openStaffClaim(guarantee.id, staffNote.trim());
      toast('Claim opened');
      setShowStaff(false);
      setStaffNote('');
      onChanged();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  const submitVoid = async () => {
    setBusy(true);
    try {
      await voidGuarantee(guarantee.id, voidReason.trim());
      toast('Guarantee voided');
      setShowVoid(false);
      onChanged();
    } catch (e) {
      toast(errMessage(e), 'error');
    }
    setBusy(false);
  };

  const input = 'focus-ring w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary';
  const tech = guarantee.technician_id ? techNames.get(guarantee.technician_id) : undefined;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary">
      <button type="button" onClick={onToggle} aria-expanded={open} className="focus-ring flex w-full items-start justify-between gap-3 rounded-2xl p-4 text-left">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">{guarantee.customer_name || 'Customer'}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[guarantee.status]}`}>{STATUS_LABELS[guarantee.status]}</span>
            {(guarantee.status === 'verified' || guarantee.status === 'expired' || guarantee.status === 'verifying') && guarantee.evidence_level !== 'none' && (
              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">{EVIDENCE_LABELS[guarantee.evidence_level]}</span>
            )}
          </div>
          <p className="text-xs text-text-secondary">
            {guarantee.service_type ?? 'Service'}
            {tech ? ` · ${tech}` : ''} · completed {new Date(guarantee.started_at).toLocaleDateString()}
          </p>
          <Stepper checkpoints={checkpoints} />
          <p className="text-xs text-text-secondary">{nextStepLabel(guarantee, checkpoints, now)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="text-lg font-semibold text-text-primary">{verificationProgress(checkpoints)}%</span>
          <ChevronDown size={16} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </div>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          {claim && (claim.status === 'open' || claim.status === 'redispatched') && (
            <ClaimPanel claim={claim} guarantee={guarantee} techNames={techNames} isOwner={isOwner} onChanged={onChanged} />
          )}

          <div>
            <p className="mb-2 text-xs font-semibold text-text-primary">Evidence trail</p>
            {events === null ? (
              <p className="text-xs text-text-secondary">Loading…</p>
            ) : events.length === 0 ? (
              <p className="text-xs text-text-secondary">No events yet.</p>
            ) : (
              <ul className="space-y-1">
                {events.map((e) => (
                  <li key={e.id} className="flex items-start justify-between gap-3 rounded-lg bg-bg-primary px-3 py-1.5 text-xs">
                    <span className="min-w-0 text-text-primary">
                      {EVENT_LABELS[e.event_type] ?? e.event_type}
                      {e.detail && <span className="block text-text-secondary">{e.detail}</span>}
                    </span>
                    <span className="shrink-0 text-text-secondary">
                      {e.actor_type} · {new Date(e.created_at).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copyLink()}>
              <Link2 size={14} /> Copy customer link
            </Button>
            {(guarantee.status === 'verifying' || guarantee.status === 'verified') && (
              <Button size="sm" variant="secondary" onClick={() => setShowStaff((v) => !v)}>
                <AlertTriangle size={14} /> Report a failure
              </Button>
            )}
            {isOwner && live && (
              <Button size="sm" variant="ghost" onClick={() => setShowVoid((v) => !v)}>
                Void guarantee
              </Button>
            )}
          </div>

          {showStaff && (
            <div className="space-y-2">
              <input value={staffNote} maxLength={500} onChange={(e) => setStaffNote(e.target.value)} placeholder="What went wrong?" className={input} aria-label="What went wrong" />
              <Button size="sm" onClick={() => void submitStaff()} disabled={busy || staffNote.trim().length < 3}>
                Open claim
              </Button>
            </div>
          )}
          {showVoid && (
            <div className="space-y-2">
              <input value={voidReason} maxLength={300} onChange={(e) => setVoidReason(e.target.value)} placeholder="Reason (for example: damage caused by the customer)" className={input} aria-label="Void reason" />
              <Button size="sm" onClick={() => void submitVoid()} disabled={busy || voidReason.trim().length < 3}>
                Confirm void
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ServiceGuaranteePage() {
  const { isOwner } = useAuth();
  const { toast } = useToast();
  const [bundle, setBundle] = useState<GuaranteeBundle>({ guarantees: [], checkpoints: [], claims: [] });
  const [settings, setSettings] = useState<GuaranteeSettings>(DEFAULT_GUARANTEE_SETTINGS);
  const [techNames, setTechNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [filter, setFilter] = useState<Filter>('action');
  const [openId, setOpenId] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const [b, s, names] = await Promise.all([fetchGuaranteeBundle(), fetchGuaranteeSettings(), fetchTeamNames()]);
      if (!mounted.current) return;
      setBundle(b);
      setSettings(s);
      setTechNames(names);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
    if (mounted.current) {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load().then(() => toast('Updated'));
  };

  const summary = useMemo(() => summarizeGuarantees(bundle.guarantees, bundle.claims), [bundle]);

  const cpByG = useMemo(() => {
    const m = new Map<string, CheckpointRow[]>();
    for (const c of bundle.checkpoints) m.set(c.guarantee_id, [...(m.get(c.guarantee_id) ?? []), c]);
    return m;
  }, [bundle.checkpoints]);

  const claimByG = useMemo(() => {
    const m = new Map<string, ClaimRow>();
    // claims are newest-first: keep the live one, else the newest
    for (const c of bundle.claims) {
      const cur = m.get(c.guarantee_id);
      const live = c.status === 'open' || c.status === 'redispatched';
      if (!cur || (live && !(cur.status === 'open' || cur.status === 'redispatched'))) m.set(c.guarantee_id, c);
    }
    return m;
  }, [bundle.claims]);

  const visible = useMemo(() => {
    const rows = bundle.guarantees.filter((g) => {
      if (filter === 'all') return true;
      if (filter === 'action') return g.status === 'claim_open';
      if (filter === 'closed') return CLOSED.has(g.status);
      return !CLOSED.has(g.status);
    });
    return rows;
  }, [bundle.guarantees, filter]);

  const counts = useMemo(
    () => ({
      action: bundle.guarantees.filter((g) => g.status === 'claim_open').length,
      active: bundle.guarantees.filter((g) => !CLOSED.has(g.status)).length,
      closed: bundle.guarantees.filter((g) => CLOSED.has(g.status)).length,
      all: bundle.guarantees.length,
    }),
    [bundle.guarantees],
  );

  // First visit with open claims should land on "Needs action"; otherwise show everything live.
  const didInitFilter = useRef(false);
  useEffect(() => {
    if (loading || didInitFilter.current) return;
    didInitFilter.current = true;
    if (counts.action === 0) setFilter('active');
  }, [loading, counts.action]);

  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`);

  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'action', label: 'Needs action', count: counts.action },
    { key: 'active', label: 'In progress', count: counts.active },
    { key: 'closed', label: 'Closed', count: counts.closed },
    { key: 'all', label: 'All', count: counts.all },
  ];

  return (
    <DashboardLayout activeLabel="Verified Service">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <ShieldCheck size={18} /> Verified Service
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Not “technician completed the job” but “was the problem actually solved?” Every job is verified at 48 hours, 7 days and 30 days, and Vireek responds when a fix fails.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
              <Settings2 size={14} /> Settings
            </Button>
            <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing || loading}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </div>

        {!loading && !failed && !settings.enabled && (
          <div className="mb-5 rounded-2xl border border-accent/30 bg-accent/5 p-4 text-sm">
            <p className="font-semibold text-text-primary">Verified Service is off</p>
            <p className="mt-1 text-xs text-text-secondary">Turn it on in Settings to start verifying every completed job and to respond automatically when a fix fails.</p>
          </div>
        )}

        {showSettings && <SettingsPanel settings={settings} isOwner={isOwner} onSaved={() => void load()} />}

        {loading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : failed ? (
          <EmptyState
            icon={ShieldCheck}
            title="Verified Service unavailable"
            description="Guarantee data could not be loaded. The database migration may not be applied yet, or your connection dropped."
            action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
          />
        ) : bundle.guarantees.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No guaranteed jobs yet"
            description={settings.enabled ? 'The next job you mark as completed starts its 48-hour, 7-day and 30-day verification automatically.' : 'Turn on Verified Service in Settings, then complete a job to start your first guarantee.'}
          />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="Held without recovery" value={pct(summary.holdRate)} valueClass="text-success-500" hint="of decided guarantees" />
              <StatCard label="Open claims" value={summary.openClaims} valueClass={summary.openClaims > 0 ? 'text-danger' : 'text-text-primary'} />
              <StatCard label="Verifying now" value={summary.verifying} />
              <StatCard label="Median recovery" value={summary.medianRecoveryHours === null ? '—' : formatDuration(summary.medianRecoveryHours * 60)} hint="claim to fixed" />
            </div>
            {summary.confirmedShare !== null && (
              <p className="mb-4 text-xs text-text-secondary">
                {pct(summary.confirmedShare)} of verified jobs were confirmed by the customer. The rest passed because nothing was reported, and are labelled that way to the customer.
              </p>
            )}

            <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Filter guarantees">
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                >
                  {f.label} ({f.count})
                </button>
              ))}
            </div>

            <div className="space-y-3">
              {visible.map((g) => (
                <GuaranteeCard
                  key={g.id}
                  guarantee={g}
                  checkpoints={cpByG.get(g.id) ?? []}
                  claim={claimByG.get(g.id)}
                  techNames={techNames}
                  isOwner={isOwner}
                  open={openId === g.id}
                  onToggle={() => setOpenId(openId === g.id ? null : g.id)}
                  onChanged={() => void load()}
                />
              ))}
              {visible.length === 0 && <p className="py-6 text-center text-sm text-text-secondary">Nothing in this view.</p>}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
