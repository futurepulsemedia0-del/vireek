/**
 * Permit Intelligence — /dashboard/permit-intelligence
 * Property permits, inspections, expirations, compliance requirements, issues,
 * history and recommended actions. See src/lib/permitIntelligence.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ClipboardCheck, ExternalLink, FileText, History as HistoryIcon, Landmark,
  Loader2, RefreshCw, Search, ShieldAlert, Sparkles, X,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import {
  CATEGORY_LABELS,
  generateComplianceReview,
  ITEM_STATUS_LABELS,
  PERMIT_LIKELIHOOD_META,
  progressFor,
  SEVERITY_META,
  setComplianceItemProgress,
  type ComplianceItem,
  type ItemStatus,
} from '@/lib/permitCompliance';
import {
  formatHomeDate,
  PERMIT_STATUS_LABELS,
  PERMIT_STATUSES,
  PERMIT_TYPE_LABELS,
  type PermitStatus,
} from '@/lib/homeLifetimeGraph';
import { errorMessage, setPermitStatus } from '@/lib/homeLifetimeGraphApi';
import {
  fetchJobRegulationContext,
  resolveRegulations,
} from '@/lib/temporalRegulationApi';
import { inForce, KIND_LABELS, type JobRegulationContext, type ResolveResult } from '@/lib/temporalRegulation';
import {
  buildActions,
  buildEvents,
  buildPermitRows,
  buildReviewRows,
  computeStats,
  EXPIRING_DAYS,
  fetchPermitIntelligenceData,
  filterPermitRows,
  filterReviewRows,
  jobsNeedingReview,
  matchesQuery,
  safeHttpUrl,
  siteLabel,
  summarizeJurisdictions,
  type PermitFilter,
  type PermitIntelligenceData,
  type PermitRow,
  type PiAction,
  type PiEvent,
  type Priority,
  type ReviewRow,
} from '@/lib/permitIntelligence';

const CARD = 'rounded-2xl border border-border bg-bg-secondary p-4';
const LINK_BTN = 'focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary';
const INPUT = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const ROW_CAP = 200;

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
const TONE: Record<Tone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success-500/15 text-success-500',
  warning: 'bg-warning-500/15 text-warning-500',
  danger: 'bg-danger/15 text-danger',
};
const PRIORITY_TONE: Record<Priority, Tone> = { critical: 'danger', high: 'danger', medium: 'warning', low: 'neutral' };
const PERMIT_TONE: Record<PermitStatus, Tone> = {
  planned: 'neutral', applied: 'accent', issued: 'accent', inspection_pending: 'warning',
  passed: 'success', failed: 'danger', closed: 'success', expired: 'danger', withdrawn: 'neutral',
};

type TabKey = 'overview' | 'permits' | 'reviews' | 'issues' | 'history';
const TABS: { key: TabKey; label: string; icon: typeof FileText }[] = [
  { key: 'overview', label: 'Overview', icon: Sparkles },
  { key: 'permits', label: 'Permits', icon: FileText },
  { key: 'reviews', label: 'Job compliance', icon: ClipboardCheck },
  { key: 'issues', label: 'Issues', icon: ShieldAlert },
  { key: 'history', label: 'History', icon: HistoryIcon },
];
const FILTERS: { key: PermitFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'open', label: 'Open' }, { key: 'attention', label: 'Needs attention' },
  { key: 'expiring', label: `Expiring ≤${EXPIRING_DAYS}d` }, { key: 'inspection', label: 'Inspections' }, { key: 'closed', label: 'Closed' },
];

const fmtDateTime = (s: string): string => new Date(s).toLocaleString();

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${TONE[tone]}`}>{children}</span>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className="text-lg font-semibold text-text-primary">{value}</p>
      {hint && <p className="text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function Expiry({ row }: { row: PermitRow }) {
  const p = row.permit;
  if (!p.expires_on) return <span className="text-text-secondary">—</span>;
  const d = row.daysToExpiry;
  const tone: Tone = row.issue ? 'danger' : row.expiring ? 'warning' : 'neutral';
  return (
    <span className="flex flex-col">
      <span className="text-text-primary">{formatHomeDate(p.expires_on)}</span>
      {row.open && d !== null && (d < 0 ? <Pill tone="danger">Overdue {-d}d</Pill> : d <= EXPIRING_DAYS ? <Pill tone={tone}>{d}d left</Pill> : null)}
    </span>
  );
}

// ------------------------------------------------------------------ drawer shell

function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-labelledby="pi-drawer-title" onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-bg-primary p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="pi-drawer-title" className="text-base font-semibold text-text-primary">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-text-secondary">{subtitle}</p>}
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><X size={16} /></button>
        </div>
        {children}
      </aside>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right font-medium text-text-primary">{children}</span>
    </div>
  );
}

// ------------------------------------------------------------------ Regulation Graph card

function RegulationCard({ jobId }: { jobId: string }) {
  const [state, setState] = useState<{ loading: boolean; failed: boolean; ctx: JobRegulationContext | null; result: ResolveResult | null }>({ loading: true, failed: false, ctx: null, result: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, failed: false, ctx: null, result: null });
    (async () => {
      try {
        const ctx = await fetchJobRegulationContext(jobId);
        const result = ctx.jurisdiction
          ? await resolveRegulations({ jurisdictionId: ctx.jurisdiction.id, asOf: ctx.as_of, workTypes: ctx.work_types })
          : null;
        if (!cancelled) setState({ loading: false, failed: false, ctx, result });
      } catch {
        if (!cancelled) setState({ loading: false, failed: true, ctx: null, result: null });
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  const entries = state.result ? inForce(state.result.entries).filter((e) => e.kind === 'permit' || e.kind === 'inspection' || e.kind === 'license') : [];
  return (
    <section className={`${CARD} mt-4`} aria-label="Regulation Graph">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Landmark size={14} /> Regulation Graph</h3>
        <Link to="/dashboard/regulation-graph" className="text-xs font-semibold text-accent hover:underline">Open</Link>
      </div>
      {state.loading && <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary"><Loader2 size={13} className="animate-spin" /> Loading…</p>}
      {state.failed && <p className="mt-2 text-xs text-text-secondary">Regulation Graph is unavailable right now.</p>}
      {!state.loading && !state.failed && !state.result && (
        <p className="mt-2 text-xs text-text-secondary">No jurisdiction in the Regulation Graph matches this job's location yet.</p>
      )}
      {state.result && (
        <>
          <p className="mt-2 text-xs text-text-secondary">
            {state.result.jurisdiction.name} · {state.result.counts.in_force} rules in force as of {formatHomeDate(state.result.as_of)}
            {state.result.counts.unverified > 0 && ` · ${state.result.counts.unverified} unverified`}
          </p>
          {entries.length === 0 ? (
            <p className="mt-2 text-xs text-text-secondary">No permit, inspection or license rules recorded for this work type.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {entries.slice(0, 6).map((e) => (
                <li key={e.node_id} className="flex items-start justify-between gap-2 text-sm">
                  <span className="text-text-primary">{e.title}</span>
                  <span className="flex shrink-0 gap-1.5">
                    <Pill tone="neutral">{KIND_LABELS[e.kind]}</Pill>
                    {e.verification_status === 'unverified' && <Pill tone="warning">Unverified</Pill>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ permit drawer

function PermitDrawer({ row, reviewRow, events, onClose, onChanged, onOpenReview }: {
  row: PermitRow; reviewRow: ReviewRow | null; events: PiEvent[]; onClose: () => void; onChanged: () => void; onOpenReview: (jobId: string) => void;
}) {
  const { toast } = useToast();
  const p = row.permit;
  const [status, setStatus] = useState<PermitStatus>(p.status);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setStatus(p.status); }, [p.status]);
  const docUrl = safeHttpUrl(p.document_url);

  const saveStatus = async () => {
    setSaving(true);
    try { await setPermitStatus(p.id, status); toast('Permit status updated.', 'success'); onChanged(); }
    catch (e) { toast(errorMessage(e), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Drawer title={row.label} subtitle={siteLabel(row.site)} onClose={onClose}>
      <div className="mt-3 flex flex-wrap gap-2">
        <Pill tone={PERMIT_TONE[p.status]}>{PERMIT_STATUS_LABELS[p.status]}</Pill>
        {row.expiring && <Pill tone="warning">Expires in {row.daysToExpiry}d</Pill>}
      </div>
      {row.issue && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-danger/10 p-3 text-sm text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <div><p className="font-semibold">{row.issue.title}</p><p className="text-xs">{row.issue.detail}</p></div>
        </div>
      )}

      <div className="mt-4 divide-y divide-border rounded-2xl border border-border bg-bg-secondary px-4">
        <DetailRow label="Type">{PERMIT_TYPE_LABELS[p.permit_type]}</DetailRow>
        <DetailRow label="Permit number">{p.permit_number ?? '—'}</DetailRow>
        <DetailRow label="Jurisdiction">{p.jurisdiction ?? '—'}</DetailRow>
        <DetailRow label="Customer">{row.site?.customerName ?? '—'}</DetailRow>
        <DetailRow label="Applied">{formatHomeDate(p.applied_on)}</DetailRow>
        <DetailRow label="Issued">{formatHomeDate(p.issued_on)}</DetailRow>
        <DetailRow label="Final inspection">{formatHomeDate(p.final_inspection_on)}</DetailRow>
        <DetailRow label="Expires">{formatHomeDate(p.expires_on)}</DetailRow>
        <DetailRow label="Fee">{p.cost_cents === null ? '—' : `$${(p.cost_cents / 100).toFixed(2)}`}</DetailRow>
        {p.description && <DetailRow label="Scope">{p.description}</DetailRow>}
        {p.notes && <DetailRow label="Notes">{p.notes}</DetailRow>}
      </div>

      <div className="mt-4 flex items-end gap-2">
        <label className="flex-1 text-xs font-medium text-text-secondary">Update status
          <select className={`${INPUT} mt-1`} value={status} onChange={(e) => setStatus(e.target.value as PermitStatus)}>
            {PERMIT_STATUSES.map((s) => <option key={s} value={s}>{PERMIT_STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <Button size="sm" onClick={saveStatus} disabled={saving || status === p.status}>{saving && <Loader2 size={14} className="animate-spin" />} Save</Button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {row.site && <Link to={`/dashboard/customers/${row.site.customer_id}/sites/${row.site.id}/intelligence`} className={LINK_BTN}>Property Intelligence</Link>}
        {row.site && <Link to={`/dashboard/homes/${row.site.id}`} className={LINK_BTN}>Home graph (edit permit)</Link>}
        {row.job && <Link to="/dashboard/jobs" className={LINK_BTN}>Jobs</Link>}
        {docUrl && <a href={docUrl} target="_blank" rel="noopener noreferrer" className={`${LINK_BTN} inline-flex items-center gap-2`}><ExternalLink size={14} /> Document</a>}
      </div>

      {reviewRow && (
        <div className={`${CARD} mt-4 text-sm`}>
          <p className="text-xs text-text-secondary">Linked job compliance review</p>
          <p className="font-medium text-text-primary">{reviewRow.label}</p>
          <p className="text-xs text-text-secondary">{reviewRow.counts.resolved}/{reviewRow.counts.total} requirements resolved · {reviewRow.blockers.length} blockers</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => onOpenReview(reviewRow.review.job_id)}>Open review</Button>
        </div>
      )}
      {p.job_id && <RegulationCard jobId={p.job_id} />}

      <h3 className="mt-5 text-sm font-semibold text-text-primary">History</h3>
      {events.length === 0 ? <p className="mt-2 text-xs text-text-secondary">No dated milestones recorded.</p> : (
        <ol className="mt-3 space-y-2 border-l border-border pl-4">
          {events.map((ev) => (
            <li key={ev.id} className="relative">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-accent" />
              <p className="text-sm text-text-primary">{ev.title}</p>
              <p className="text-[11px] text-text-secondary">{formatHomeDate(ev.date)}</p>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}

// ------------------------------------------------------------------ review drawer

function RequirementRow({ item, row, onSaved }: { item: ComplianceItem; row: ReviewRow; onSaved: () => void }) {
  const { toast } = useToast();
  const progress = progressFor(row.review, item.key);
  const [status, setStatus] = useState<ItemStatus>(progress?.status ?? 'open');
  const [permitNumber, setPermitNumber] = useState(progress?.permit_number ?? '');
  const [note, setNote] = useState(progress?.note ?? '');
  const [saving, setSaving] = useState(false);
  const showNumber = item.category === 'permit' || item.category === 'inspection';
  const dirty = status !== (progress?.status ?? 'open') || permitNumber !== (progress?.permit_number ?? '') || note !== (progress?.note ?? '');
  const sev = SEVERITY_META[item.severity];

  const save = async () => {
    setSaving(true);
    try {
      await setComplianceItemProgress(row.review.job_id, item.key, status, { permitNumber, note });
      toast('Requirement updated.', 'success');
      onSaved();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save this update.', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <li className="rounded-xl border border-border bg-bg-secondary p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${sev.className}`}>{sev.label}</span>
        <Pill tone="neutral">{CATEGORY_LABELS[item.category]}</Pill>
        {item.source === 'ai' && <Pill tone="accent">AI</Pill>}
      </div>
      <p className="mt-1.5 text-sm font-medium text-text-primary">{item.title}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{item.detail}</p>
      {(item.authority || item.reference) && <p className="mt-1 text-[11px] text-text-secondary">{[item.authority, item.reference].filter(Boolean).join(' · ')}</p>}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <select aria-label="Status" className={INPUT} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
          {(Object.keys(ITEM_STATUS_LABELS) as ItemStatus[]).map((s) => <option key={s} value={s}>{ITEM_STATUS_LABELS[s]}</option>)}
        </select>
        {showNumber && <input aria-label="Permit number" className={INPUT} placeholder="Permit / inspection #" maxLength={60} value={permitNumber} onChange={(e) => setPermitNumber(e.target.value)} />}
        <input aria-label="Note" className={`${INPUT} ${showNumber ? 'sm:col-span-2' : 'sm:col-span-1'}`} placeholder="Note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {dirty && <div className="mt-2 flex justify-end"><Button size="sm" onClick={save} disabled={saving}>{saving && <Loader2 size={14} className="animate-spin" />} Save</Button></div>}
    </li>
  );
}

function ReviewDrawer({ row, onClose, onChanged, onRegenerate, regenerating }: {
  row: ReviewRow; onClose: () => void; onChanged: () => void; onRegenerate: () => void; regenerating: boolean;
}) {
  const r = row.review;
  const likelihood = PERMIT_LIKELIHOOD_META[r.permit_likelihood];
  const order = { blocker: 0, warning: 1, info: 2 } as const;
  const items = [...r.requirements].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <Drawer title={row.label} subtitle={r.jurisdiction?.label || 'Jurisdiction not resolved'} onClose={onClose}>
      <div className="mt-3 flex flex-wrap gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${likelihood.className}`}>{likelihood.label}</span>
        <Pill tone={r.ai_status === 'ok' ? 'accent' : 'neutral'}>{r.ai_status === 'ok' ? 'AI-assisted' : 'Rules only'}</Pill>
        <Pill tone={row.blockers.length ? 'danger' : 'success'}>{row.blockers.length ? `${row.blockers.length} blockers` : 'No blockers'}</Pill>
      </div>
      {r.summary && <p className="mt-3 text-sm text-text-primary">{r.summary}</p>}
      <p className="mt-1 text-[11px] text-text-secondary">Generated {fmtDateTime(r.generated_at)}{r.jurisdiction?.coverage === 'generic' ? ' · generic coverage — verify locally' : ''}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onRegenerate} disabled={regenerating}>{regenerating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Regenerate</Button>
        {row.site && <Link to={`/dashboard/customers/${row.site.customer_id}/sites/${row.site.id}/intelligence`} className={LINK_BTN}>Property Intelligence</Link>}
        <Link to="/dashboard/compliance" className={LINK_BTN}>Compliance Center</Link>
        <Link to="/dashboard/jobs" className={LINK_BTN}>Jobs</Link>
      </div>

      <h3 className="mt-5 text-sm font-semibold text-text-primary">Requirements ({row.counts.resolved}/{row.counts.total} resolved)</h3>
      {items.length === 0 ? <p className="mt-2 text-xs text-text-secondary">No requirements were identified.</p> : (
        <ul className="mt-2 space-y-2">{items.map((it) => <RequirementRow key={it.key} item={it} row={row} onSaved={onChanged} />)}</ul>
      )}

      {r.verify_questions.length > 0 && (
        <section className={`${CARD} mt-4`}>
          <h3 className="text-sm font-semibold text-text-primary">Verify with the jurisdiction</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-secondary">{r.verify_questions.map((q) => <li key={q}>{q}</li>)}</ul>
        </section>
      )}
      <RegulationCard jobId={r.job_id} />
    </Drawer>
  );
}

// ------------------------------------------------------------------ page

export function PermitIntelligencePage() {
  const { toast } = useToast();
  const [data, setData] = useState<PermitIntelligenceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKey>('overview');
  const [filter, setFilter] = useState<PermitFilter>('all');
  const [query, setQuery] = useState('');
  const [permitId, setPermitId] = useState<string | null>(null);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  const load = useCallback(async (mode: 'initial' | 'manual') => {
    if (mode === 'manual') setRefreshing(true);
    try {
      setData(await fetchPermitIntelligenceData());
      setLoadError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load permit data.';
      if (mode === 'initial') setLoadError(msg); else toast(msg, 'error');
    } finally { setLoading(false); setRefreshing(false); }
  }, [toast]);

  useEffect(() => { void load('initial'); }, [load]);
  const reload = useCallback(() => { void load('manual'); }, [load]);
  const closePermit = useCallback(() => setPermitId(null), []);
  const closeReview = useCallback(() => setReviewJobId(null), []);

  const model = useMemo(() => {
    if (!data) return null;
    const now = Date.now();
    const permitRows = buildPermitRows(data, now);
    const reviewRows = buildReviewRows(data, now);
    const needsReview = jobsNeedingReview(data);
    return {
      permitRows, reviewRows, needsReview,
      actions: buildActions({ permitRows, reviewRows, needsReview, now }),
      stats: computeStats(permitRows, reviewRows, needsReview),
      jurisdictions: summarizeJurisdictions(permitRows, reviewRows),
      events: buildEvents(data, permitRows, reviewRows),
    };
  }, [data]);

  const generate = async (jobId: string) => {
    setBusyJobId(jobId);
    try {
      await generateComplianceReview(jobId, { force: true });
      toast('Compliance review updated.', 'success');
      await load('manual');
      setReviewJobId(jobId);
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not run the review.', 'error'); }
    finally { setBusyJobId(null); }
  };

  const runAction = (a: PiAction) => {
    if (a.target.type === 'permit') setPermitId(a.target.id);
    else if (a.target.type === 'review') setReviewJobId(a.target.jobId);
    else void generate(a.target.jobId);
  };

  const permitRows = model?.permitRows ?? [];
  const visiblePermits = useMemo(() => filterPermitRows(permitRows, filter, query), [permitRows, filter, query]);
  const visibleReviews = useMemo(() => filterReviewRows(model?.reviewRows ?? [], query), [model, query]);
  const visibleNeeds = useMemo(() => (model?.needsReview ?? []).filter((j) => matchesQuery(query, j.customer_name, j.service_type, j.address)), [model, query]);
  const visibleEvents = useMemo(() => (model?.events ?? []).filter((e) => matchesQuery(query, e.title, e.detail)), [model, query]);
  const issueRows = useMemo(() => permitRows.filter((r) => r.issue && matchesQuery(query, r.label, siteLabel(r.site), r.site?.customerName)), [permitRows, query]);
  const blockerRows = useMemo(() => visibleReviews.filter((r) => r.blockers.length > 0 && (!r.job || ['scheduled', 'en_route', 'in_progress'].includes(r.job.job_status))), [visibleReviews]);

  const selectedPermit = permitId ? permitRows.find((r) => r.permit.id === permitId) ?? null : null;
  const selectedReview = reviewJobId ? model?.reviewRows.find((r) => r.review.job_id === reviewJobId) ?? null : null;
  const stats = model?.stats;
  const now = Date.now();

  return (
    <DashboardLayout activeLabel="Permit Intelligence">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary"><ClipboardCheck size={20} /> Permit Intelligence</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Every property permit, inspection and expiration alongside the compliance requirements of your upcoming jobs — with prioritised actions from the permit compliance engine and Regulation Graph.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data && <span className="hidden text-[11px] text-text-secondary sm:inline">Updated {new Date(data.loadedAt).toLocaleTimeString()}</span>}
            <Button size="sm" variant="secondary" onClick={reload} disabled={refreshing} aria-label="Refresh"><RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh</Button>
          </div>
        </header>

        {loading ? (
          <><SkeletonStatGrid count={6} /><SkeletonCardList count={3} /></>
        ) : loadError || !data || !model || !stats ? (
          <EmptyStateError icon={ClipboardCheck} title="Couldn't load permit data" description={loadError ?? undefined} onRetry={() => { setLoading(true); void load('initial'); }} />
        ) : (
          <>
            {!data.schemaReady && (
              <div role="status" className="flex items-start gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" />
                <p className="text-text-secondary">Property permit records aren't available yet — apply the Home Lifetime Graph migration. Job compliance reviews still work.</p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <nav aria-label="Permit sections" className="flex flex-1 gap-1 overflow-x-auto rounded-2xl border border-border bg-bg-secondary p-1">
                {TABS.map(({ key, label, icon: Icon }) => (
                  <button key={key} type="button" onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}
                    className={`focus-ring inline-flex items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors ${tab === key ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}>
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </nav>
              <label className="relative">
                <span className="sr-only">Search</span>
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search property, customer, permit #…" className="focus-ring w-64 rounded-xl border border-border bg-bg-secondary py-2 pl-8 pr-3 text-sm text-text-primary" />
              </label>
            </div>

            {tab === 'overview' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
                  <Stat label="Open permits" value={String(stats.openPermits)} />
                  <Stat label={`Expiring ≤${EXPIRING_DAYS} days`} value={String(stats.expiring)} />
                  <Stat label="Permit issues" value={String(stats.issues)} hint="Failed / overdue / no final" />
                  <Stat label="Inspections pending" value={String(stats.inspectionsPending)} />
                  <Stat label="Jobs with blockers" value={String(stats.jobsWithBlockers)} hint="Active jobs" />
                  <Stat label="Requirements resolved" value={stats.requirementsResolvedPct === null ? '—' : `${Math.round(stats.requirementsResolvedPct * 100)}%`} hint={`${stats.needsReview} jobs unreviewed`} />
                </div>

                <section className={CARD} aria-label="Recommended actions">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Sparkles size={14} /> Recommended actions</h2>
                  <p className="mt-0.5 text-xs text-text-secondary">Prioritised from your permits, job reviews and the compliance rules engine.</p>
                  {model.actions.length === 0 ? (
                    <p className="mt-3 text-sm text-text-secondary">Nothing needs attention right now.</p>
                  ) : (
                    <ul className="mt-3 divide-y divide-border">
                      {model.actions.slice(0, 12).map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2"><Pill tone={PRIORITY_TONE[a.priority]}>{a.priority}</Pill><p className="truncate text-sm font-medium text-text-primary">{a.title}</p></div>
                            <p className="mt-0.5 text-xs text-text-secondary">{a.detail}</p>
                          </div>
                          <Button size="sm" variant="secondary" disabled={a.target.type === 'generate' && busyJobId === a.target.jobId} onClick={() => runAction(a)}>
                            {a.target.type === 'generate' ? (busyJobId === a.target.jobId ? <Loader2 size={14} className="animate-spin" /> : null) : null}
                            {a.target.type === 'generate' ? 'Run review' : 'Open'}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {model.actions.length > 12 && <p className="mt-2 text-xs text-text-secondary">Showing 12 of {model.actions.length}.</p>}
                </section>

                <section className={CARD} aria-label="Jurisdictions">
                  <h2 className="text-sm font-semibold text-text-primary">By jurisdiction</h2>
                  {model.jurisdictions.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No permits or reviews yet.</p> : (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[520px] text-left text-sm">
                        <thead className="text-[11px] uppercase tracking-wide text-text-secondary"><tr><th className="py-2 pr-4">Jurisdiction</th><th className="px-3 py-2">Permits</th><th className="px-3 py-2">Open</th><th className="px-3 py-2">Issues</th><th className="px-3 py-2">Reviews</th><th className="px-3 py-2">Blockers</th></tr></thead>
                        <tbody className="divide-y divide-border text-text-primary">
                          {model.jurisdictions.slice(0, 15).map((j) => (
                            <tr key={j.name}><td className="py-2 pr-4 font-medium">{j.name}</td><td className="px-3 py-2">{j.permits}</td><td className="px-3 py-2">{j.open}</td><td className="px-3 py-2">{j.issues}</td><td className="px-3 py-2">{j.reviews}</td><td className="px-3 py-2">{j.blockers}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            )}

            {tab === 'permits' && (
              <section className="space-y-3" aria-label="Permits">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter permits">
                    {FILTERS.map((f) => (
                      <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
                        className={`focus-ring rounded-full px-3 py-1.5 text-xs font-semibold ${filter === f.key ? 'bg-accent text-white' : 'border border-border text-text-secondary hover:bg-bg-tertiary'}`}>{f.label}</button>
                    ))}
                  </div>
                  <p className="text-xs text-text-secondary">Add or edit permits on each property's Home graph.</p>
                </div>
                {visiblePermits.length === 0 ? (
                  <EmptyState icon={FileText} title={permitRows.length === 0 ? 'No permits recorded yet' : 'No permits match'} description={permitRows.length === 0 ? 'Permits recorded on a property’s Home graph appear here with their inspections and expirations.' : 'Try a different filter or search.'} />
                ) : (
                  <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                    <table className="w-full min-w-[860px] text-left text-sm">
                      <thead className="text-[11px] uppercase tracking-wide text-text-secondary"><tr><th className="px-4 py-3">Permit</th><th className="px-4 py-3">Property</th><th className="px-4 py-3">Jurisdiction</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Inspection</th><th className="px-4 py-3">Expires</th></tr></thead>
                      <tbody className="divide-y divide-border">
                        {visiblePermits.slice(0, ROW_CAP).map((r) => (
                          <tr key={r.permit.id} onClick={() => setPermitId(r.permit.id)} className="cursor-pointer hover:bg-bg-tertiary/60">
                            <td className="px-4 py-3"><button type="button" className="focus-ring rounded text-left font-medium text-text-primary">{r.label}</button>{r.issue && <p className="text-[11px] text-danger">{r.issue.title}</p>}</td>
                            <td className="px-4 py-3 text-text-secondary">{siteLabel(r.site)}{r.site?.customerName && <span className="block text-[11px]">{r.site.customerName}</span>}</td>
                            <td className="px-4 py-3 text-text-secondary">{r.permit.jurisdiction ?? '—'}</td>
                            <td className="px-4 py-3"><Pill tone={PERMIT_TONE[r.permit.status]}>{PERMIT_STATUS_LABELS[r.permit.status]}</Pill></td>
                            <td className="px-4 py-3 text-text-secondary">{r.permit.final_inspection_on ? formatHomeDate(r.permit.final_inspection_on) : r.permit.status === 'inspection_pending' ? 'Pending' : '—'}</td>
                            <td className="px-4 py-3"><Expiry row={r} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {visiblePermits.length > ROW_CAP && <p className="text-xs text-text-secondary">Showing {ROW_CAP} of {visiblePermits.length}. Narrow with search.</p>}
              </section>
            )}

            {tab === 'reviews' && (
              <section className="space-y-4" aria-label="Job compliance">
                {visibleNeeds.length > 0 && (
                  <div className={CARD}>
                    <h2 className="text-sm font-semibold text-text-primary">Jobs without a compliance review</h2>
                    <ul className="mt-2 divide-y divide-border">
                      {visibleNeeds.slice(0, 20).map((j) => (
                        <li key={j.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                          <div className="min-w-0"><p className="truncate text-sm font-medium text-text-primary">{j.customer_name}{j.service_type ? ` · ${j.service_type}` : ''}</p><p className="text-xs text-text-secondary">{j.address ?? 'No address'}{j.scheduled_datetime ? ` · ${new Date(j.scheduled_datetime).toLocaleDateString()}` : ''}</p></div>
                          <Button size="sm" variant="secondary" disabled={busyJobId === j.id} onClick={() => void generate(j.id)}>{busyJobId === j.id && <Loader2 size={14} className="animate-spin" />} Run review</Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {visibleReviews.length === 0 ? (
                  <EmptyState icon={ClipboardCheck} title="No compliance reviews yet" description="Run a review on an upcoming job to see permit likelihood and requirements." />
                ) : (
                  <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                    <table className="w-full min-w-[820px] text-left text-sm">
                      <thead className="text-[11px] uppercase tracking-wide text-text-secondary"><tr><th className="px-4 py-3">Job</th><th className="px-4 py-3">Jurisdiction</th><th className="px-4 py-3">Permit</th><th className="px-4 py-3">Progress</th><th className="px-4 py-3">Recorded permits</th><th className="px-4 py-3">Scheduled</th></tr></thead>
                      <tbody className="divide-y divide-border">
                        {visibleReviews.slice(0, ROW_CAP).map((r) => {
                          const l = PERMIT_LIKELIHOOD_META[r.review.permit_likelihood];
                          return (
                            <tr key={r.review.id} onClick={() => setReviewJobId(r.review.job_id)} className="cursor-pointer hover:bg-bg-tertiary/60">
                              <td className="px-4 py-3"><button type="button" className="focus-ring rounded text-left font-medium text-text-primary">{r.label}</button><p className="text-[11px] text-text-secondary">{siteLabel(r.site) !== 'Unknown property' ? siteLabel(r.site) : r.job?.address ?? ''}</p></td>
                              <td className="px-4 py-3 text-text-secondary">{r.review.jurisdiction?.label || '—'}</td>
                              <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${l.className}`}>{l.label}</span></td>
                              <td className="px-4 py-3 text-text-primary">{r.counts.resolved}/{r.counts.total}{r.blockers.length > 0 && <span className="ml-2"><Pill tone="danger">{r.blockers.length} blockers</Pill></span>}</td>
                              <td className="px-4 py-3 text-text-secondary">{r.linkedPermits}</td>
                              <td className="px-4 py-3 text-text-secondary">{r.job?.scheduled_datetime ? new Date(r.job.scheduled_datetime).toLocaleDateString() : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {tab === 'issues' && (
              <section className="space-y-4" aria-label="Issues">
                <p className="text-xs text-text-secondary">Issues are derived from permit status, dates and open compliance blockers. Formal citations from authorities aren't tracked separately.</p>
                <div className={CARD}>
                  <h2 className="text-sm font-semibold text-text-primary">Permit issues ({issueRows.length})</h2>
                  {issueRows.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No failed, overdue or unclosed permits.</p> : (
                    <ul className="mt-2 divide-y divide-border">
                      {issueRows.slice(0, ROW_CAP).map((r) => (
                        <li key={r.permit.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                          <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Pill tone={PRIORITY_TONE[r.issue!.severity]}>{r.issue!.severity}</Pill><p className="text-sm font-medium text-text-primary">{r.issue!.title}</p></div><p className="mt-0.5 text-xs text-text-secondary">{siteLabel(r.site)} — {r.issue!.detail}</p></div>
                          <Button size="sm" variant="secondary" onClick={() => setPermitId(r.permit.id)}>Open</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className={CARD}>
                  <h2 className="text-sm font-semibold text-text-primary">Unresolved job blockers ({blockerRows.length})</h2>
                  {blockerRows.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No active jobs with unresolved blockers.</p> : (
                    <ul className="mt-2 divide-y divide-border">
                      {blockerRows.slice(0, ROW_CAP).map((r) => (
                        <li key={r.review.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                          <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Pill tone={r.upcoming ? 'danger' : 'warning'}>{r.upcoming ? 'This week' : 'Upcoming'}</Pill><p className="text-sm font-medium text-text-primary">{r.label}</p></div><p className="mt-0.5 text-xs text-text-secondary">{r.blockers.map((b) => b.title).join(' · ')}</p></div>
                          <Button size="sm" variant="secondary" onClick={() => setReviewJobId(r.review.job_id)}>Resolve</Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            )}

            {tab === 'history' && (
              <section className={CARD} aria-label="History">
                {visibleEvents.length === 0 ? <p className="text-sm text-text-secondary">No history yet.</p> : (
                  <ol className="space-y-3 border-l border-border pl-4">
                    {visibleEvents.slice(0, 150).map((ev) => (
                      <li key={ev.id} className="relative">
                        <span className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${ev.at > now ? 'bg-warning-500' : 'bg-accent'}`} />
                        <button type="button" className="focus-ring rounded text-left" onClick={() => (ev.permitId ? setPermitId(ev.permitId) : ev.jobId && model.reviewRows.some((r) => r.review.job_id === ev.jobId) ? setReviewJobId(ev.jobId) : undefined)}>
                          <p className="text-sm font-medium text-text-primary">{ev.title}{ev.at > now && <span className="ml-2"><Pill tone="warning">Upcoming</Pill></span>}</p>
                        </button>
                        <p className="text-[11px] text-text-secondary">{formatHomeDate(ev.date)}{ev.detail ? ` · ${ev.detail}` : ''}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {selectedPermit && model && (
        <PermitDrawer
          row={selectedPermit}
          reviewRow={selectedPermit.permit.job_id ? model.reviewRows.find((r) => r.review.job_id === selectedPermit.permit.job_id) ?? null : null}
          events={model.events.filter((e) => e.permitId === selectedPermit.permit.id)}
          onClose={closePermit}
          onChanged={reload}
          onOpenReview={(jobId) => { setPermitId(null); setReviewJobId(jobId); }}
        />
      )}
      {selectedReview && (
        <ReviewDrawer row={selectedReview} onClose={closeReview} onChanged={reload} onRegenerate={() => void generate(selectedReview.review.job_id)} regenerating={busyJobId === selectedReview.review.job_id} />
      )}
    </DashboardLayout>
  );
}
