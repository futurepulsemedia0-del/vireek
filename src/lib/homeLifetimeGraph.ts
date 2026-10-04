import type { Equipment, Job } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';

/**
 * Vireek Home Lifetime Graph — pure logic (no network, no runtime imports from
 * propertyTwin/supabase, so it is safe to unit test).
 *
 * The HOME is the permanent entity. Everything here is derived from facts
 * attached to the home (site_id / room_id), never to the current owner, so the
 * Service Intelligence survives any change of owner.
 */

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
const RECURRING_FAILURE_THRESHOLD = 3;

// ------------------------------------------------------------------ labels

export const PERMIT_TYPES = ['building', 'mechanical', 'electrical', 'plumbing', 'gas', 'roofing', 'fire_safety', 'other'] as const;
export type PermitType = (typeof PERMIT_TYPES)[number];
export const PERMIT_TYPE_LABELS: Record<PermitType, string> = {
  building: 'Building', mechanical: 'Mechanical', electrical: 'Electrical', plumbing: 'Plumbing',
  gas: 'Gas', roofing: 'Roofing', fire_safety: 'Fire safety', other: 'Other',
};

export const PERMIT_STATUSES = ['planned', 'applied', 'issued', 'inspection_pending', 'passed', 'failed', 'closed', 'expired', 'withdrawn'] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];
export const PERMIT_STATUS_LABELS: Record<PermitStatus, string> = {
  planned: 'Planned', applied: 'Applied', issued: 'Issued', inspection_pending: 'Inspection pending',
  passed: 'Passed', failed: 'Failed', closed: 'Closed', expired: 'Expired', withdrawn: 'Withdrawn',
};

export const CONTRACTOR_ROLES = ['primary', 'subcontractor', 'previous_provider', 'inspector', 'other'] as const;
export type ContractorRole = (typeof CONTRACTOR_ROLES)[number];
export const CONTRACTOR_ROLE_LABELS: Record<ContractorRole, string> = {
  primary: 'Primary contractor', subcontractor: 'Subcontractor', previous_provider: 'Previous provider',
  inspector: 'Inspector', other: 'Other',
};

export const INTERVENTION_TYPES = ['maintenance', 'repair', 'replacement', 'inspection', 'upgrade'] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];
export const INTERVENTION_STATUSES = ['predicted', 'proposed', 'scheduled', 'completed', 'dismissed'] as const;
export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number];

export const TRANSFER_REASONS = ['sale', 'inheritance', 'new_tenant', 'property_manager_change', 'correction', 'other'] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];
export const TRANSFER_REASON_LABELS: Record<TransferReason, string> = {
  sale: 'Sale', inheritance: 'Inheritance', new_tenant: 'New tenant',
  property_manager_change: 'Property manager change', correction: 'Data correction', other: 'Other',
};

export type Level = 'low' | 'medium' | 'high';

// ------------------------------------------------------------------- types

export interface HomeOwnershipPeriod {
  id: string;
  site_id: string;
  customer_id: string | null;
  started_at: string;
  ended_at: string | null;
  transfer_reason: TransferReason | null;
  notes: string | null;
  ownerName: string | null;
}

export interface HomePermit {
  id: string;
  site_id: string;
  job_id: string | null;
  contractor_id: string | null;
  permit_type: PermitType;
  permit_number: string | null;
  jurisdiction: string | null;
  description: string | null;
  status: PermitStatus;
  applied_on: string | null;
  issued_on: string | null;
  expires_on: string | null;
  final_inspection_on: string | null;
  cost_cents: number | null;
  document_url: string | null;
  notes: string | null;
  created_at: string;
}

export interface HomeContractor {
  id: string;
  site_id: string;
  vendor_id: string | null;
  name: string;
  trade: string | null;
  license_number: string | null;
  phone: string | null;
  email: string | null;
  role: ContractorRole;
  first_worked_on: string | null;
  last_worked_on: string | null;
  insured: boolean;
  notes: string | null;
  created_at: string;
}

export interface HomeIntervention {
  id: string;
  site_id: string;
  equipment_id: string | null;
  job_id: string | null;
  title: string;
  rationale: string | null;
  intervention_type: InterventionType;
  target_date: string | null;
  est_cost_low_cents: number | null;
  est_cost_high_cents: number | null;
  risk_level: Level;
  status: InterventionStatus;
  source: 'system' | 'staff' | 'ai';
  completed_on: string | null;
  created_at: string;
}

export interface WarrantyClaimLite {
  id: string;
  job_id: string | null;
  equipment_id: string | null;
  status: string;
  manufacturer: string | null;
  failure_date: string | null;
  claimed_amount_cents: number | null;
  approved_amount_cents: number | null;
  credit_received_cents: number | null;
  created_at: string;
}

export interface HomeLifetimeGraph {
  twin: PropertyTwin;
  siteId: string;
  currentCustomerId: string;
  yearBuilt: number | null;
  /** False when the home-graph migration has not been applied yet. */
  schemaReady: boolean;
  /** Newest first. */
  ownership: HomeOwnershipPeriod[];
  permits: HomePermit[];
  contractors: HomeContractor[];
  interventions: HomeIntervention[];
  warrantyClaims: WarrantyClaimLite[];
  technicianNames: Record<string, string>;
}

export type NewPermit = Omit<HomePermit, 'id' | 'created_at'>;
export type NewContractor = Omit<HomeContractor, 'id' | 'created_at'>;
export type NewIntervention = Omit<HomeIntervention, 'id' | 'created_at'>;

// ------------------------------------------------------------------- utils

export function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(t) ? null : t;
}

export function formatHomeDate(value: string | null | undefined): string {
  const t = ts(value);
  if (t === null) return '—';
  return new Date(t).toLocaleDateString(undefined, value && value.length === 10 ? { timeZone: 'UTC' } : undefined);
}

function toIsoDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function humanize(value: string): string {
  const s = value.replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : value;
}

export function equipmentLabel(e: Pick<Equipment, 'equipment_type' | 'make' | 'model'>): string {
  const mm = [e.make, e.model].filter(Boolean).join(' ');
  return mm ? `${humanize(e.equipment_type)} — ${mm}` : humanize(e.equipment_type);
}

// ----------------------------------------------------------- job classifier

export type JobCategory = 'installation' | 'replacement' | 'repair' | 'maintenance' | 'inspection' | 'other';

export interface ClassifiableJob {
  service_type: string | null;
  tags?: string[] | null;
  is_rework?: boolean | null;
}

const MINOR_REPLACE = /replac\w*\s+(the\s+|a\s+)?(air\s+)?(filter|battery|batteries|bulb|belt|capacitor|thermostat)/;

export function classifyJob(job: ClassifiableJob, linkServiceTypes: Array<string | null> = []): JobCategory {
  if (job.is_rework) return 'repair';
  const text = [job.service_type, ...(job.tags ?? []), ...linkServiceTypes].filter(Boolean).join(' ').toLowerCase();
  if (!text) return 'other';
  if (MINOR_REPLACE.test(text)) return 'maintenance';
  if (/replac|swap|change.?out|new (unit|system|furnace|heater|water heater)/.test(text)) return 'replacement';
  if (/install|retrofit|new construction/.test(text)) return 'installation';
  if (/inspect|assessment|audit|safety check/.test(text)) return 'inspection';
  if (/maint|tune.?up|service plan|clean|filter|flush|seasonal|check.?up/.test(text)) return 'maintenance';
  if (/repair|fix|leak|clog|burst|not (cool|heat|work)|no (heat|cool|power)|emergency|troubleshoot|diagnos|breakdown/.test(text)) return 'repair';
  return 'other';
}

export interface HistoryJob {
  job: Job;
  category: JobCategory;
  equipmentIds: string[];
}

export function completedHistory(g: Pick<HomeLifetimeGraph, 'twin'>): HistoryJob[] {
  const byJob = new Map<string, { eq: string[]; types: Array<string | null> }>();
  for (const l of g.twin.jobEquipmentLinks) {
    const e = byJob.get(l.job_id) ?? { eq: [], types: [] };
    e.eq.push(l.equipment_id);
    e.types.push(l.service_type);
    byJob.set(l.job_id, e);
  }
  return g.twin.jobs
    .filter((j) => j.job_status === 'completed')
    .map((job) => {
      const l = byJob.get(job.id);
      return { job, category: classifyJob(job, l?.types ?? []), equipmentIds: l?.eq ?? [] };
    });
}

// ---------------------------------------------------------------- warranty

export type WarrantyState = 'none' | 'active' | 'expiring' | 'expired';

export function warrantyState(expiresAt: string | null, now: number = Date.now()): WarrantyState {
  const t = ts(expiresAt);
  if (t === null) return 'none';
  if (t < now) return 'expired';
  return t - now <= 90 * DAY ? 'expiring' : 'active';
}

// ----------------------------------------------------------------- systems

export interface SystemRecord {
  equipment: Equipment;
  label: string;
  ageYears: number | null;
  lifeUsedPct: number | null;
  completedVisits: number;
  repairVisits: number;
  lastServiceDate: string | null;
  overdue: boolean;
  nearingEol: boolean;
  recurring: boolean;
  warranty: WarrantyState;
  claimsCount: number;
  recoveredCents: number;
  /** Earlier units in the same room/type, oldest first. */
  lineage: Equipment[];
}

export function buildSystems(g: HomeLifetimeGraph, history: HistoryJob[], now: number = Date.now()): SystemRecord[] {
  const visits = new Map<string, number>();
  const repairs = new Map<string, number>();
  const last = new Map<string, number>();
  for (const h of history) {
    const t = ts(h.job.scheduled_datetime);
    for (const id of h.equipmentIds) {
      visits.set(id, (visits.get(id) ?? 0) + 1);
      if (h.category === 'repair') repairs.set(id, (repairs.get(id) ?? 0) + 1);
      if (t !== null && t > (last.get(id) ?? 0)) last.set(id, t);
    }
  }
  const all = g.twin.equipment;
  return all
    .filter((e) => e.status === 'active')
    .map((e) => {
      const installed = ts(e.install_date);
      const age = installed === null ? null : Math.max(0, Math.round(((now - installed) / YEAR) * 10) / 10);
      const life = e.expected_lifespan_years;
      const lifeUsed = age !== null && life > 0 ? Math.min(150, Math.round((age / life) * 100)) : null;
      const baseSvc = ts(e.last_service_date) ?? last.get(e.id) ?? installed;
      let overdue = false;
      if (baseSvc !== null && e.service_interval_months > 0) {
        const due = new Date(baseSvc);
        due.setUTCMonth(due.getUTCMonth() + e.service_interval_months);
        overdue = due.getTime() < now;
      }
      const nearingEol = age !== null && life > 0 && life - age < 1;
      const claims = g.warrantyClaims.filter((c) => c.equipment_id === e.id);
      const lastTs = last.get(e.id);
      const lineage = all
        .filter((o) => o.id !== e.id && o.room_id && o.room_id === e.room_id && o.equipment_type === e.equipment_type
          && (ts(o.install_date) ?? 0) < (installed ?? Number.MAX_SAFE_INTEGER))
        .sort((a, b) => (ts(a.install_date) ?? 0) - (ts(b.install_date) ?? 0));
      return {
        equipment: e,
        label: equipmentLabel(e),
        ageYears: age,
        lifeUsedPct: lifeUsed,
        completedVisits: visits.get(e.id) ?? 0,
        repairVisits: repairs.get(e.id) ?? 0,
        lastServiceDate: e.last_service_date ?? (lastTs ? toIsoDate(lastTs) : null),
        overdue,
        nearingEol,
        recurring: (repairs.get(e.id) ?? 0) >= RECURRING_FAILURE_THRESHOLD,
        warranty: warrantyState(e.warranty_expires_at, now),
        claimsCount: claims.length,
        recoveredCents: claims.reduce((s, c) => s + (c.credit_received_cents ?? 0), 0),
        lineage,
      };
    });
}

// ---------------------------------------------------------------- timeline

export type TimelineKind = JobCategory | 'service' | 'permit' | 'warranty' | 'ownership' | 'intervention';

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  date: string;
  title: string;
  detail: string | null;
  equipmentId: string | null;
  costCents: number | null;
}

export function buildTimeline(g: HomeLifetimeGraph, history: HistoryJob[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const eqById = new Map(g.twin.equipment.map((e) => [e.id, e]));
  const jobIdsInHistory = new Set(history.map((h) => h.job.id));

  for (const h of history) {
    if (!h.job.scheduled_datetime) continue;
    const cents = Math.max(0, Math.round((h.job.invoice_amount ?? 0) * 100));
    out.push({
      id: `job-${h.job.id}`,
      kind: h.category === 'other' ? 'service' : h.category,
      date: h.job.scheduled_datetime,
      title: h.job.service_type ? humanize(h.job.service_type) : 'Service visit',
      detail: h.equipmentIds.map((id) => eqById.get(id)).filter((e): e is Equipment => !!e).map(equipmentLabel).join(', ') || null,
      equipmentId: h.equipmentIds[0] ?? null,
      costCents: cents > 0 ? cents : null,
    });
  }

  for (const e of g.twin.equipment) {
    if (e.install_date && !(e.install_job_id && jobIdsInHistory.has(e.install_job_id))) {
      out.push({ id: `install-${e.id}`, kind: 'installation', date: e.install_date, title: `${humanize(e.equipment_type)} installed`,
        detail: equipmentLabel(e), equipmentId: e.id, costCents: null });
    }
    if (e.status === 'replaced' && e.updated_at) {
      out.push({ id: `retired-${e.id}`, kind: 'replacement', date: e.updated_at, title: `${humanize(e.equipment_type)} replaced`,
        detail: `${equipmentLabel(e)} retired`, equipmentId: e.id, costCents: null });
    }
  }

  for (const p of g.permits) {
    const d = p.issued_on ?? p.applied_on ?? p.created_at;
    out.push({ id: `permit-${p.id}`, kind: 'permit', date: d,
      title: `${PERMIT_TYPE_LABELS[p.permit_type]} permit${p.permit_number ? ` #${p.permit_number}` : ''}`,
      detail: PERMIT_STATUS_LABELS[p.status], equipmentId: null, costCents: p.cost_cents });
  }

  for (const c of g.warrantyClaims) {
    out.push({ id: `claim-${c.id}`, kind: 'warranty', date: c.failure_date ?? c.created_at,
      title: `Warranty claim${c.manufacturer ? ` — ${c.manufacturer}` : ''}`, detail: humanize(c.status),
      equipmentId: c.equipment_id, costCents: c.credit_received_cents });
  }

  // Owners are listed newest-first; the oldest period is the starting point, not a change.
  g.ownership.slice(0, -1).forEach((p) => {
    out.push({ id: `own-${p.id}`, kind: 'ownership', date: p.started_at, title: 'Ownership changed',
      detail: p.transfer_reason ? TRANSFER_REASON_LABELS[p.transfer_reason] : null, equipmentId: null, costCents: null });
  });

  for (const i of g.interventions) {
    if (i.status === 'completed' && i.completed_on) {
      out.push({ id: `int-${i.id}`, kind: 'intervention', date: i.completed_on, title: i.title, detail: 'Planned intervention completed',
        equipmentId: i.equipment_id, costCents: null });
    }
  }

  return out.filter((e) => ts(e.date) !== null).sort((a, b) => (ts(b.date) ?? 0) - (ts(a.date) ?? 0));
}

// ------------------------------------------------------------------- costs

export interface HomeCosts {
  serviceCents: number;
  permitFeesCents: number;
  warrantyRecoveredCents: number;
  netCents: number;
  byCategory: Record<JobCategory, number>;
  byYear: Array<{ year: number; cents: number }>;
  yearsTracked: number;
  avgPerYearCents: number;
}

export function buildCosts(g: HomeLifetimeGraph, history: HistoryJob[], now: number = Date.now()): HomeCosts {
  const byCategory: Record<JobCategory, number> = { installation: 0, replacement: 0, repair: 0, maintenance: 0, inspection: 0, other: 0 };
  const byYearMap = new Map<number, number>();
  let service = 0;
  let permitFees = 0;
  let earliest: number | null = null;
  const touch = (t: number | null) => { if (t !== null && (earliest === null || t < earliest)) earliest = t; };
  const addYear = (t: number | null, cents: number) => {
    if (t === null || cents <= 0) return;
    const y = new Date(t).getUTCFullYear();
    byYearMap.set(y, (byYearMap.get(y) ?? 0) + cents);
  };

  for (const h of history) {
    const t = ts(h.job.scheduled_datetime);
    touch(t);
    const cents = Math.max(0, Math.round((h.job.invoice_amount ?? 0) * 100));
    service += cents;
    byCategory[h.category] += cents;
    addYear(t, cents);
  }
  for (const p of g.permits) {
    const t = ts(p.issued_on ?? p.applied_on ?? p.created_at);
    touch(t);
    permitFees += p.cost_cents ?? 0;
    addYear(t, p.cost_cents ?? 0);
  }
  for (const e of g.twin.equipment) touch(ts(e.install_date));

  const recovered = g.warrantyClaims.reduce((s, c) => s + (c.credit_received_cents ?? 0), 0);
  const net = Math.max(0, service + permitFees - recovered);
  const years = earliest === null ? 1 : Math.max(1, (now - earliest) / YEAR);

  return {
    serviceCents: service,
    permitFeesCents: permitFees,
    warrantyRecoveredCents: recovered,
    netCents: net,
    byCategory,
    byYear: [...byYearMap.entries()].sort((a, b) => a[0] - b[0]).map(([year, cents]) => ({ year, cents })),
    yearsTracked: Math.round(years * 10) / 10,
    avgPerYearCents: Math.round(net / years),
  };
}

// ------------------------------------------------------------------- risks

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RiskKind = 'predictive' | 'service' | 'end_of_life' | 'recurring' | 'permit' | 'warranty' | 'knowledge_gap';

export interface HomeGraphRisk {
  id: string;
  severity: RiskSeverity;
  kind: RiskKind;
  title: string;
  detail: string;
  equipmentId: string | null;
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function buildRisks(g: HomeLifetimeGraph, systems: SystemRecord[], now: number = Date.now()): HomeGraphRisk[] {
  const out: HomeGraphRisk[] = [];
  const labelById = new Map(g.twin.equipment.map((e) => [e.id, equipmentLabel(e)]));

  for (const a of g.twin.maintenanceAlerts) {
    out.push({ id: `alert-${a.id}`, severity: a.risk_level, kind: 'predictive', title: a.predicted_issue,
      detail: `${labelById.get(a.equipment_id) ?? 'Equipment'}${a.recommended_action ? ` — ${a.recommended_action}` : ''}`,
      equipmentId: a.equipment_id });
  }

  for (const s of systems) {
    const id = s.equipment.id;
    if (s.ageYears !== null && s.equipment.expected_lifespan_years > 0 && s.ageYears >= s.equipment.expected_lifespan_years) {
      out.push({ id: `eol-${id}`, severity: 'high', kind: 'end_of_life', title: `${s.label} is past its expected life`,
        detail: `${s.ageYears} yrs old vs ${s.equipment.expected_lifespan_years} yr expected life.`, equipmentId: id });
    } else if (s.nearingEol) {
      out.push({ id: `eol-${id}`, severity: 'medium', kind: 'end_of_life', title: `${s.label} is nearing end of life`,
        detail: `${s.ageYears} yrs old vs ${s.equipment.expected_lifespan_years} yr expected life.`, equipmentId: id });
    }
    if (s.recurring) {
      out.push({ id: `rec-${id}`, severity: 'high', kind: 'recurring', title: `Recurring failures — ${s.label}`,
        detail: `${s.repairVisits} repair visits on record. Consider replacement over another repair.`, equipmentId: id });
    }
    if (s.overdue) {
      out.push({ id: `svc-${id}`, severity: 'medium', kind: 'service', title: `Service overdue — ${s.label}`,
        detail: `Last service: ${formatHomeDate(s.lastServiceDate)}.`, equipmentId: id });
    }
    if (s.warranty === 'expiring') {
      out.push({ id: `war-${id}`, severity: 'low', kind: 'warranty', title: `Warranty ending soon — ${s.label}`,
        detail: `Expires ${formatHomeDate(s.equipment.warranty_expires_at)}. Inspect before it lapses.`, equipmentId: id });
    }
    if (!s.equipment.install_date) {
      out.push({ id: `gap-${id}`, severity: 'low', kind: 'knowledge_gap', title: `Unknown install date — ${s.label}`,
        detail: 'Age-based predictions for this unit are less reliable.', equipmentId: id });
    }
  }

  for (const p of g.permits) {
    const exp = ts(p.expires_on);
    const issued = ts(p.issued_on);
    const closedOut = p.status === 'passed' || p.status === 'closed' || p.status === 'withdrawn';
    const label = `${PERMIT_TYPE_LABELS[p.permit_type]} permit${p.permit_number ? ` #${p.permit_number}` : ''}`;
    if (p.status === 'failed') {
      out.push({ id: `perm-${p.id}`, severity: 'high', kind: 'permit', title: `${label} failed inspection`,
        detail: 'Re-inspection needed before the work is considered legal and sellable.', equipmentId: null });
    } else if (!closedOut && exp !== null && exp < now) {
      out.push({ id: `perm-${p.id}`, severity: 'high', kind: 'permit', title: `${label} expired without closing`,
        detail: `Expired ${formatHomeDate(p.expires_on)}. Open permits can block a sale or insurance claim.`, equipmentId: null });
    } else if ((p.status === 'issued' || p.status === 'inspection_pending') && issued !== null
      && now - issued > 180 * DAY && !p.final_inspection_on) {
      out.push({ id: `perm-${p.id}`, severity: 'medium', kind: 'permit', title: `${label} has no final inspection`,
        detail: `Issued ${formatHomeDate(p.issued_on)}; schedule the final inspection.`, equipmentId: null });
    }
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title));
}

// ----------------------------------------------------------------- future

export const OPEN_INTERVENTION_STATUSES: InterventionStatus[] = ['predicted', 'proposed', 'scheduled'];

export function openInterventions(list: HomeIntervention[]): HomeIntervention[] {
  return list
    .filter((i) => OPEN_INTERVENTION_STATUSES.includes(i.status))
    .sort((a, b) => (ts(a.target_date) ?? Number.MAX_SAFE_INTEGER) - (ts(b.target_date) ?? Number.MAX_SAFE_INTEGER));
}

export function suggestInterventions(
  systems: SystemRecord[],
  existing: HomeIntervention[],
  siteId: string,
  now: number = Date.now(),
): NewIntervention[] {
  const blocked = new Set(existing.filter((i) => i.status !== 'completed').map((i) => `${i.equipment_id}:${i.intervention_type}`));
  const out: NewIntervention[] = [];
  const base = { site_id: siteId, job_id: null, est_cost_low_cents: null, est_cost_high_cents: null, status: 'predicted' as const, source: 'system' as const, completed_on: null };
  for (const s of systems) {
    const e = s.equipment;
    if (s.nearingEol && !blocked.has(`${e.id}:replacement`)) {
      const installed = ts(e.install_date);
      const eol = installed === null ? now : new Date(installed).setUTCFullYear(new Date(installed).getUTCFullYear() + e.expected_lifespan_years);
      out.push({ ...base, equipment_id: e.id, intervention_type: 'replacement', title: `Plan replacement — ${s.label}`,
        rationale: `${s.ageYears ?? '?'} yrs old against a ${e.expected_lifespan_years} yr expected life.`,
        target_date: toIsoDate(Math.max(eol, now)), risk_level: (s.lifeUsedPct ?? 0) >= 100 ? 'high' : 'medium' });
    } else if (s.overdue && !blocked.has(`${e.id}:maintenance`)) {
      out.push({ ...base, equipment_id: e.id, intervention_type: 'maintenance', title: `Service — ${s.label}`,
        rationale: `Service interval of ${e.service_interval_months} months has passed.`,
        target_date: toIsoDate(now), risk_level: 'medium' });
    }
  }
  return out;
}

// ------------------------------------------------------------ intelligence

export interface IntelligenceFactor { key: string; label: string; earned: number; max: number; hint: string }
export interface HomeIntelligence {
  score: number;
  tier: 'Early' | 'Developing' | 'Established' | 'Deep';
  factors: IntelligenceFactor[];
  previousOwners: number;
  yearsOfHistory: number;
}

export function buildIntelligence(
  g: HomeLifetimeGraph,
  history: HistoryJob[],
  systems: SystemRecord[],
  costs: HomeCosts,
  techCount: number,
): HomeIntelligence {
  const active = systems.length;
  const completeness = active === 0 ? 0
    : systems.reduce((s, x) => s + (x.equipment.install_date ? 0.5 : 0) + (x.equipment.serial_number ? 0.3 : 0) + (x.equipment.warranty_expires_at ? 0.2 : 0), 0) / active;
  const contractorsKnown = g.contractors.length + techCount;
  const hasWarrantyData = systems.some((s) => s.warranty !== 'none') || g.warrantyClaims.length > 0;
  const open = openInterventions(g.interventions).length;
  const f = (key: string, label: string, ratio: number, max: number, hint: string): IntelligenceFactor =>
    ({ key, label, earned: Math.round(Math.max(0, Math.min(1, ratio)) * max), max, hint });

  const factors = [
    f('inventory', 'Equipment inventory', active / 5, 20, 'Document every major system (5+ for full credit).'),
    f('completeness', 'Equipment detail', completeness, 15, 'Install date, serial number and warranty date per unit.'),
    f('history', 'Service history', history.length / 10, 20, 'Completed visits on record (10+ for full credit).'),
    f('span', 'History span', costs.yearsTracked / 5, 10, 'Years of continuous records (5+ for full credit).'),
    f('permits', 'Permits', g.permits.length / 3, 10, 'Record permits for regulated work.'),
    f('contractors', 'Contractors', contractorsKnown / 2, 10, 'Who has worked on this home.'),
    f('warranty', 'Warranty tracking', hasWarrantyData ? 1 : 0, 5, 'Warranty dates or claims on at least one system.'),
    f('forward', 'Forward plan', open / 3, 10, 'Open future interventions (3+ for full credit).'),
  ];
  const score = factors.reduce((s, x) => s + x.earned, 0);
  return {
    score,
    tier: score >= 80 ? 'Deep' : score >= 55 ? 'Established' : score >= 30 ? 'Developing' : 'Early',
    factors,
    previousOwners: Math.max(0, g.ownership.length - 1),
    yearsOfHistory: costs.yearsTracked,
  };
}

// -------------------------------------------------------------------- view

export interface TechnicianContribution { id: string; name: string; visits: number; lastVisit: string | null }

export interface HomeView {
  history: HistoryJob[];
  systems: SystemRecord[];
  timeline: TimelineEvent[];
  costs: HomeCosts;
  risks: HomeGraphRisk[];
  intelligence: HomeIntelligence;
  technicians: TechnicianContribution[];
}

export function deriveHomeView(g: HomeLifetimeGraph, now: number = Date.now()): HomeView {
  const history = completedHistory(g);
  const systems = buildSystems(g, history, now);
  const costs = buildCosts(g, history, now);

  const techMap = new Map<string, TechnicianContribution>();
  for (const h of history) {
    const id = h.job.assigned_technician_id;
    if (!id) continue;
    const cur = techMap.get(id) ?? { id, name: g.technicianNames[id] ?? 'Technician', visits: 0, lastVisit: null };
    cur.visits += 1;
    if (h.job.scheduled_datetime && (cur.lastVisit === null || h.job.scheduled_datetime > cur.lastVisit)) cur.lastVisit = h.job.scheduled_datetime;
    techMap.set(id, cur);
  }
  const technicians = [...techMap.values()].sort((a, b) => b.visits - a.visits);

  return {
    history,
    systems,
    timeline: buildTimeline(g, history),
    costs,
    risks: buildRisks(g, systems, now),
    intelligence: buildIntelligence(g, history, systems, costs, technicians.length),
    technicians,
  };
}
