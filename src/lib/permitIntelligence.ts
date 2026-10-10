import { supabase } from '@/lib/supabase';
import {
  COMPLIANCE_ELIGIBLE_STATUSES,
  complianceCounts,
  hasReviewableScope,
  isResolved,
  unresolvedBlockers,
  type ComplianceCounts,
  type ComplianceItem,
  type ComplianceReview,
} from '@/lib/permitCompliance';
import {
  buildRisks,
  PERMIT_TYPE_LABELS,
  ts,
  type HomeGraphRisk,
  type HomeLifetimeGraph,
  type HomePermit,
  type PermitStatus,
} from '@/lib/homeLifetimeGraph';

/**
 * Permit Intelligence — orchestration layer (read-only).
 * Permits come from `home_permits`, compliance reviews from the AI Permit
 * Compliance engine (`job_compliance_reviews`). Overdue / failed / missing-final-
 * inspection detection is delegated to `buildRisks` (Home Lifetime Graph) and
 * blocker logic to `permitCompliance.ts` — nothing is re-implemented here.
 */

const DAY = 86_400_000;
const CHUNK = 150;
export const EXPIRING_DAYS = 30;
export const UPCOMING_DAYS = 7;

export const OPEN_PERMIT_STATUSES: readonly PermitStatus[] = ['planned', 'applied', 'issued', 'inspection_pending'];
export const CLOSED_PERMIT_STATUSES: readonly PermitStatus[] = ['passed', 'closed', 'withdrawn'];

// ---------------------------------------------------------------- types

export interface PiSite {
  id: string;
  customer_id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  customerName: string | null;
}

export interface PiJob {
  id: string;
  customer_id: string | null;
  customer_name: string;
  service_type: string | null;
  dispatch_note: string | null;
  address: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  site_id: string | null;
}

export interface PermitIntelligenceData {
  permits: HomePermit[];
  /** False when the Home Lifetime Graph migration (home_permits) is not applied. */
  schemaReady: boolean;
  sites: Record<string, PiSite>;
  reviews: ComplianceReview[];
  jobs: Record<string, PiJob>;
  loadedAt: string;
}

// ---------------------------------------------------------------- data access

type DbError = { code?: string; message?: string };
const isMissing = (e: DbError): boolean =>
  e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? '');

const JOB_COLUMNS = 'id, customer_id, customer_name, service_type, dispatch_note, address, job_status, scheduled_datetime, site_id';
const SITE_COLUMNS = 'id, customer_id, name, address, city, state, postal_code';

async function fetchByIds<T>(table: string, columns: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase.from(table).select(columns).in('id', ids.slice(i, i + CHUNK));
    if (error) throw error;
    out.push(...((data ?? []) as unknown as T[]));
  }
  return out;
}

const unique = (xs: (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

export async function fetchPermitIntelligenceData(): Promise<PermitIntelligenceData> {
  const [permitsRes, reviewsRes, jobsRes] = await Promise.all([
    supabase.from('home_permits').select('*').order('created_at', { ascending: false }).limit(1000),
    supabase.from('job_compliance_reviews').select('*').order('generated_at', { ascending: false }).limit(500),
    supabase
      .from('jobs')
      .select(JOB_COLUMNS)
      .in('job_status', Array.from(COMPLIANCE_ELIGIBLE_STATUSES))
      .order('scheduled_datetime', { ascending: true })
      .limit(300),
  ]);

  let schemaReady = true;
  let permits: HomePermit[] = [];
  if (permitsRes.error) {
    if (isMissing(permitsRes.error)) schemaReady = false;
    else throw permitsRes.error;
  } else permits = (permitsRes.data ?? []) as unknown as HomePermit[];

  let reviews: ComplianceReview[] = [];
  if (reviewsRes.error) {
    if (!isMissing(reviewsRes.error)) throw reviewsRes.error;
  } else reviews = (reviewsRes.data ?? []) as unknown as ComplianceReview[];

  if (jobsRes.error) throw jobsRes.error;
  const jobs: Record<string, PiJob> = {};
  for (const j of (jobsRes.data ?? []) as unknown as PiJob[]) jobs[j.id] = j;

  const missingJobIds = unique([...reviews.map((r) => r.job_id), ...permits.map((p) => p.job_id)]).filter((id) => !jobs[id]);
  try {
    for (const j of await fetchByIds<PiJob>('jobs', JOB_COLUMNS, missingJobIds)) jobs[j.id] = j;
  } catch { /* labels only */ }

  const siteIds = unique([...permits.map((p) => p.site_id), ...Object.values(jobs).map((j) => j.site_id)]);
  const sites: Record<string, PiSite> = {};
  try {
    const rows = await fetchByIds<Omit<PiSite, 'customerName'>>('customer_sites', SITE_COLUMNS, siteIds);
    const names = new Map<string, string>();
    try {
      for (const c of await fetchByIds<{ id: string; name: string }>('customers', 'id, name', unique(rows.map((r) => r.customer_id)))) names.set(c.id, c.name);
    } catch { /* cosmetic */ }
    for (const s of rows) sites[s.id] = { ...s, customerName: names.get(s.customer_id) ?? null };
  } catch { /* labels only */ }

  return { permits, schemaReady, sites, reviews, jobs, loadedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- labels / helpers

export const permitLabel = (p: Pick<HomePermit, 'permit_type' | 'permit_number'>): string =>
  `${PERMIT_TYPE_LABELS[p.permit_type] ?? 'Other'} permit${p.permit_number ? ` #${p.permit_number}` : ''}`;

export function siteLabel(site: PiSite | null): string {
  if (!site) return 'Unknown property';
  return [site.address, site.city, site.state].filter(Boolean).join(', ') || site.name;
}

export function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}

export function matchesQuery(query: string, ...parts: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  return !q || parts.some((p) => (p ?? '').toLowerCase().includes(q));
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const isActiveJob = (j: PiJob | null): boolean => !j || COMPLIANCE_ELIGIBLE_STATUSES.has(j.job_status);

// ---------------------------------------------------------------- permit rows

export interface PermitRow {
  permit: HomePermit;
  label: string;
  site: PiSite | null;
  job: PiJob | null;
  /** Failed inspection / expired without closing / no final inspection — from buildRisks. */
  issue: HomeGraphRisk | null;
  daysToExpiry: number | null;
  open: boolean;
  expiring: boolean;
  attention: boolean;
}

/** Re-uses the Home Lifetime Graph permit rules without needing a full graph. */
export function permitIssues(permits: HomePermit[], now: number = Date.now()): Map<string, HomeGraphRisk> {
  const stub = { permits, twin: { equipment: [], maintenanceAlerts: [] } } as unknown as HomeLifetimeGraph;
  const map = new Map<string, HomeGraphRisk>();
  for (const r of buildRisks(stub, [], now)) {
    if (r.kind === 'permit' && r.id.startsWith('perm-')) map.set(r.id.slice(5), r);
  }
  return map;
}

export function buildPermitRows(data: PermitIntelligenceData, now: number = Date.now()): PermitRow[] {
  const issues = permitIssues(data.permits, now);
  const rows = data.permits.map<PermitRow>((permit) => {
    const exp = ts(permit.expires_on);
    const open = OPEN_PERMIT_STATUSES.includes(permit.status);
    const daysToExpiry = exp === null ? null : Math.ceil((exp - now) / DAY);
    const expiring = open && daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= EXPIRING_DAYS;
    const issue = issues.get(permit.id) ?? null;
    return {
      permit,
      label: permitLabel(permit),
      site: data.sites[permit.site_id] ?? null,
      job: permit.job_id ? data.jobs[permit.job_id] ?? null : null,
      issue, daysToExpiry, open, expiring,
      attention: issue !== null || expiring,
    };
  });
  return rows.sort((a, b) =>
    Number(b.attention) - Number(a.attention)
    || (ts(a.permit.expires_on) ?? Number.MAX_SAFE_INTEGER) - (ts(b.permit.expires_on) ?? Number.MAX_SAFE_INTEGER)
    || b.permit.created_at.localeCompare(a.permit.created_at));
}

export type PermitFilter = 'all' | 'open' | 'attention' | 'expiring' | 'inspection' | 'closed';

export function filterPermitRows(rows: PermitRow[], filter: PermitFilter, query: string): PermitRow[] {
  return rows.filter((r) => {
    const s = r.permit.status;
    if (filter === 'open' && !r.open) return false;
    if (filter === 'attention' && !r.attention) return false;
    if (filter === 'expiring' && !r.expiring) return false;
    if (filter === 'inspection' && s !== 'inspection_pending' && s !== 'failed') return false;
    if (filter === 'closed' && !CLOSED_PERMIT_STATUSES.includes(s)) return false;
    return matchesQuery(query, r.label, r.permit.permit_number, r.permit.jurisdiction, r.permit.description, siteLabel(r.site), r.site?.customerName);
  });
}

// ---------------------------------------------------------------- review rows

export interface ReviewRow {
  review: ComplianceReview;
  label: string;
  job: PiJob | null;
  site: PiSite | null;
  counts: ComplianceCounts;
  blockers: ComplianceItem[];
  linkedPermits: number;
  /** Active job scheduled within UPCOMING_DAYS. */
  upcoming: boolean;
}

export function buildReviewRows(data: PermitIntelligenceData, now: number = Date.now()): ReviewRow[] {
  const permitsByJob = new Map<string, number>();
  for (const p of data.permits) if (p.job_id) permitsByJob.set(p.job_id, (permitsByJob.get(p.job_id) ?? 0) + 1);

  return data.reviews
    .map<ReviewRow>((review) => {
      const job = data.jobs[review.job_id] ?? null;
      const sched = job?.scheduled_datetime ? Date.parse(job.scheduled_datetime) : NaN;
      return {
        review,
        label: job ? `${job.customer_name}${job.service_type ? ` · ${job.service_type}` : ''}` : `Job ${review.job_id.slice(0, 8)}`,
        job,
        site: job?.site_id ? data.sites[job.site_id] ?? null : null,
        counts: complianceCounts(review),
        blockers: unresolvedBlockers(review),
        linkedPermits: permitsByJob.get(review.job_id) ?? 0,
        upcoming: !!job && isActiveJob(job) && Number.isFinite(sched) && sched - now <= UPCOMING_DAYS * DAY && sched - now >= -DAY,
      };
    })
    .sort((a, b) => b.blockers.length - a.blockers.length || a.label.localeCompare(b.label));
}

export function filterReviewRows(rows: ReviewRow[], query: string): ReviewRow[] {
  return rows.filter((r) => matchesQuery(query, r.label, r.job?.address, siteLabel(r.site), r.review.jurisdiction?.label));
}

/** Active jobs with a described scope but no compliance review yet. */
export function jobsNeedingReview(data: PermitIntelligenceData): PiJob[] {
  const reviewed = new Set(data.reviews.map((r) => r.job_id));
  return Object.values(data.jobs)
    .filter((j) => COMPLIANCE_ELIGIBLE_STATUSES.has(j.job_status) && hasReviewableScope(j) && !reviewed.has(j.id))
    .sort((a, b) => (a.scheduled_datetime ?? '9999').localeCompare(b.scheduled_datetime ?? '9999'));
}

// ---------------------------------------------------------------- recommended actions

export type Priority = 'critical' | 'high' | 'medium' | 'low';
export const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export type ActionTarget =
  | { type: 'permit'; id: string }
  | { type: 'review'; jobId: string }
  | { type: 'generate'; jobId: string };

export interface PiAction { id: string; priority: Priority; title: string; detail: string; target: ActionTarget }

export function buildActions(input: { permitRows: PermitRow[]; reviewRows: ReviewRow[]; needsReview: PiJob[]; now?: number }): PiAction[] {
  const now = input.now ?? Date.now();
  const out: PiAction[] = [];
  const jobsWithPermit = new Set(input.permitRows.flatMap((r) => (r.permit.job_id ? [r.permit.job_id] : [])));

  for (const r of input.reviewRows) {
    if (!isActiveJob(r.job)) continue;
    const jobId = r.review.job_id;
    if (r.blockers.length > 0) {
      const titles = r.blockers.slice(0, 2).map((b) => b.title).join(' · ');
      out.push({
        id: `blk-${jobId}`,
        priority: r.upcoming ? 'critical' : 'high',
        title: `${plural(r.blockers.length, 'blocker')} unresolved — ${r.label}`,
        detail: titles + (r.blockers.length > 2 ? ` +${r.blockers.length - 2} more` : ''),
        target: { type: 'review', jobId },
      });
    }
    const permitItemOpen = r.review.requirements.some((q) => q.category === 'permit' && !isResolved(r.review, q.key));
    if (r.review.permit_likelihood === 'likely_required' && permitItemOpen && !jobsWithPermit.has(jobId)) {
      out.push({
        id: `gap-${jobId}`,
        priority: 'high',
        title: `Permit likely required, none recorded — ${r.label}`,
        detail: 'Record the permit on the property once applied, or mark the requirement not applicable with a note.',
        target: { type: 'review', jobId },
      });
    }
  }

  for (const r of input.permitRows) {
    if (r.issue) {
      out.push({ id: `iss-${r.permit.id}`, priority: r.issue.severity, title: r.issue.title, detail: `${siteLabel(r.site)} — ${r.issue.detail}`, target: { type: 'permit', id: r.permit.id } });
    } else if (r.expiring && r.daysToExpiry !== null) {
      out.push({
        id: `exp-${r.permit.id}`,
        priority: r.daysToExpiry <= 7 ? 'high' : 'medium',
        title: `${r.label} expires ${r.daysToExpiry === 0 ? 'today' : `in ${plural(r.daysToExpiry, 'day')}`}`,
        detail: `${siteLabel(r.site)} — close it out with a final inspection or renew before it lapses.`,
        target: { type: 'permit', id: r.permit.id },
      });
    }
  }

  for (const j of input.needsReview) {
    const sched = j.scheduled_datetime ? Date.parse(j.scheduled_datetime) : NaN;
    const soon = Number.isFinite(sched) && sched - now <= UPCOMING_DAYS * DAY;
    out.push({
      id: `gen-${j.id}`,
      priority: soon ? 'medium' : 'low',
      title: `Run a compliance review — ${j.customer_name}${j.service_type ? ` · ${j.service_type}` : ''}`,
      detail: 'No permit / code review exists for this upcoming job yet.',
      target: { type: 'generate', jobId: j.id },
    });
  }

  return out.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------- stats / jurisdictions

export interface PiStats {
  openPermits: number;
  expiring: number;
  issues: number;
  inspectionsPending: number;
  jobsWithBlockers: number;
  needsReview: number;
  requirementsResolvedPct: number | null;
}

export function computeStats(permitRows: PermitRow[], reviewRows: ReviewRow[], needsReview: PiJob[]): PiStats {
  let resolved = 0;
  let total = 0;
  for (const r of reviewRows) { resolved += r.counts.resolved; total += r.counts.total; }
  return {
    openPermits: permitRows.filter((r) => r.open).length,
    expiring: permitRows.filter((r) => r.expiring).length,
    issues: permitRows.filter((r) => r.issue).length,
    inspectionsPending: permitRows.filter((r) => r.permit.status === 'inspection_pending').length,
    jobsWithBlockers: reviewRows.filter((r) => r.blockers.length > 0 && isActiveJob(r.job)).length,
    needsReview: needsReview.length,
    requirementsResolvedPct: total > 0 ? resolved / total : null,
  };
}

export interface JurisdictionRow { name: string; permits: number; open: number; issues: number; reviews: number; blockers: number }

export function summarizeJurisdictions(permitRows: PermitRow[], reviewRows: ReviewRow[]): JurisdictionRow[] {
  const map = new Map<string, JurisdictionRow>();
  const get = (raw: string | null | undefined): JurisdictionRow => {
    const name = raw?.trim() || 'Unspecified';
    const key = name.toLowerCase();
    let row = map.get(key);
    if (!row) { row = { name, permits: 0, open: 0, issues: 0, reviews: 0, blockers: 0 }; map.set(key, row); }
    return row;
  };
  for (const r of permitRows) {
    const j = get(r.permit.jurisdiction);
    j.permits += 1;
    if (r.open) j.open += 1;
    if (r.issue) j.issues += 1;
  }
  for (const r of reviewRows) {
    const j = get(r.review.jurisdiction?.label);
    j.reviews += 1;
    if (isActiveJob(r.job)) j.blockers += r.blockers.length;
  }
  return [...map.values()].sort((a, b) => b.issues + b.blockers - (a.issues + a.blockers) || b.permits - a.permits || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- history

export interface PiEvent {
  id: string;
  at: number;
  date: string;
  title: string;
  detail: string;
  permitId: string | null;
  jobId: string | null;
}

export function buildEvents(data: PermitIntelligenceData, permitRows: PermitRow[], reviewRows: ReviewRow[]): PiEvent[] {
  const out: PiEvent[] = [];
  const push = (e: Omit<PiEvent, 'at'>) => { const at = Date.parse(e.date.length === 10 ? `${e.date}T00:00:00Z` : e.date); if (Number.isFinite(at)) out.push({ ...e, at }); };

  for (const r of permitRows) {
    const p = r.permit;
    const where = siteLabel(r.site);
    const base = { permitId: p.id, jobId: p.job_id };
    if (p.applied_on) push({ ...base, id: `${p.id}-ap`, date: p.applied_on, title: `${r.label} applied`, detail: where });
    if (p.issued_on) push({ ...base, id: `${p.id}-is`, date: p.issued_on, title: `${r.label} issued`, detail: where });
    if (p.final_inspection_on) push({ ...base, id: `${p.id}-fi`, date: p.final_inspection_on, title: `${r.label} — final inspection`, detail: where });
    if (p.expires_on) push({ ...base, id: `${p.id}-ex`, date: p.expires_on, title: `${r.label} expiry date`, detail: where });
  }

  for (const r of reviewRows) {
    const jobId = r.review.job_id;
    push({ id: `rev-${r.review.id}`, date: r.review.generated_at, title: `Compliance review generated — ${r.label}`, detail: r.review.jurisdiction?.label ?? '', permitId: null, jobId });
    const titles = new Map(r.review.requirements.map((q) => [q.key, q.title]));
    for (const [key, prog] of Object.entries(r.review.item_progress ?? {})) {
      if (!prog?.updated_at) continue;
      push({
        id: `prog-${r.review.id}-${key}`,
        date: prog.updated_at,
        title: `${titles.get(key) ?? 'Requirement'} marked ${prog.status.replace('_', ' ')}`,
        detail: [r.label, prog.permit_number ? `Permit #${prog.permit_number}` : null].filter(Boolean).join(' · '),
        permitId: null, jobId,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
