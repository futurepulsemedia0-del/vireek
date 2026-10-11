import type { HomeLifetimeGraph, HomeView } from '@/lib/homeLifetimeGraph';
import {
  PERMIT_STATUS_LABELS,
  PERMIT_TYPE_LABELS,
  TRANSFER_REASON_LABELS,
  deriveHomeView,
  equipmentLabel,
  humanize,
  ts,
} from '@/lib/homeLifetimeGraph';
import type { PropertyIntelligence, PioPrediction } from '@/lib/propertyIntelligence';
import { NODE_KIND_LABELS } from '@/lib/propertyIntelligence';
import type { ChainReport } from '@/lib/jobEvidenceChain';
import type { PassportEvent, PassportIntegrity } from '@/lib/equipmentPassport';

/**
 * Vireek Home Passport Network — pure logic (no network, no React).
 *
 * The Home Passport is a READ MODEL. It owns no tables: every record is derived
 * from systems that already exist (Home Lifetime Graph, Property Intelligence,
 * Digital Twin, Equipment Passport ledger, Job Evidence Chain, Warranty claims,
 * Property Intelligence AI predictions) and is keyed by the permanent
 * `customer_sites.id`, never by the current owner, tenant or contractor.
 *
 * Every record carries: source, timestamp, confidence and verification status.
 */

const DAY = 86_400_000;

// ------------------------------------------------------------------- types

export type PassportDomain =
  | 'identity' | 'ownership' | 'equipment' | 'repair' | 'inspection' | 'permit'
  | 'warranty' | 'evidence' | 'risk' | 'failure' | 'outcome';

export const DOMAIN_LABELS: Record<PassportDomain, string> = {
  identity: 'Property', ownership: 'Ownership', equipment: 'Equipment', repair: 'Repairs',
  inspection: 'Inspections', permit: 'Permits', warranty: 'Warranty', evidence: 'Evidence',
  risk: 'Risks', failure: 'Failures', outcome: 'Outcomes',
};

export type SourceSystem =
  | 'property_intelligence' | 'digital_twin' | 'lifetime_graph' | 'equipment_passport'
  | 'evidence_chain' | 'warranty' | 'ai';

export const SOURCE_LABELS: Record<SourceSystem, string> = {
  property_intelligence: 'Property Intelligence',
  digital_twin: 'Property Digital Twin',
  lifetime_graph: 'Home Lifetime Graph',
  equipment_passport: 'Equipment Passport',
  evidence_chain: 'Evidence Chain',
  warranty: 'Warranty',
  ai: 'Vireek AI',
};

/**
 * verified   — cryptographically sealed (valid hash chain) or confirmed against an authority/document
 * system     — written automatically by Vireek from its own operational records
 * human      — entered or reported by a person
 * inferred   — produced by a model; a prediction, not a fact
 * unverified — present but unconfirmed, or its integrity check failed
 */
export type Verification = 'verified' | 'system' | 'human' | 'inferred' | 'unverified';

export const VERIFICATION_LABELS: Record<Verification, string> = {
  verified: 'Verified', system: 'System record', human: 'Reported', inferred: 'AI inferred', unverified: 'Unverified',
};

const CONFIDENCE_BASE: Record<Verification, number> = {
  verified: 0.95, system: 0.85, human: 0.7, inferred: 0.6, unverified: 0.4,
};

export interface PassportRecord {
  id: string;
  domain: PassportDomain;
  title: string;
  detail: string | null;
  /** When it happened (ISO date or datetime). Null when genuinely unknown. */
  occurredAt: string | null;
  /** When Vireek learned about it. */
  recordedAt: string | null;
  source: SourceSystem;
  /** Free text naming the precise origin, e.g. "Permit #4821" or "Ledger seq 7". */
  sourceDetail: string | null;
  /** 0..1 */
  confidence: number;
  verification: Verification;
  equipmentId: string | null;
  jobId: string | null;
  /** Short proof reference (hash prefix) when sealed. */
  proof: string | null;
}

export interface EquipmentPassportLite {
  code: string;
  integrity: PassportIntegrity | null;
  events: PassportEvent[];
}

export interface JobOutcomeLite {
  job_id: string;
  resolution: 'fixed_first_visit' | 'fixed_followup' | 'parts_pending' | 'quote_declined' | 'unresolved';
  is_rework: boolean;
  caused_callback: boolean;
  customer_rating: number | null;
  root_cause_key: string | null;
  recorded_at: string;
}

export interface PassportInputs {
  graph: HomeLifetimeGraph;
  intel: PropertyIntelligence | null;
  predictions: PioPrediction[];
  /** keyed by equipment id */
  passports: Record<string, EquipmentPassportLite>;
  /** keyed by job id */
  evidence: Record<string, ChainReport>;
  outcomes: JobOutcomeLite[];
}

export const RESOLUTION_LABELS: Record<JobOutcomeLite['resolution'], string> = {
  fixed_first_visit: 'Fixed on first visit', fixed_followup: 'Fixed after follow-up',
  parts_pending: 'Waiting on parts', quote_declined: 'Quote declined', unresolved: 'Unresolved',
};

// ------------------------------------------------------------------- utils

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

export function confidenceLabel(c: number): 'High' | 'Medium' | 'Low' {
  return c >= 0.8 ? 'High' : c >= 0.6 ? 'Medium' : 'Low';
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Stable, human-readable Home ID derived from the permanent site id.
 * Deterministic — survives owner, tenant and contractor changes by construction.
 * Format: VHP-XXXX-XXXX-XXXX (60 bits of the site UUID, Crockford base32).
 */
export function homeIdFromSiteId(siteId: string): string {
  const hex = siteId.replace(/[^0-9a-fA-F]/g, '').toLowerCase().padEnd(15, '0').slice(0, 15);
  let out = '';
  for (let i = 0; i < 15; i += 5) {
    let n = Number.parseInt(hex.slice(i, i + 5), 16); // 20 bits -> 4 base32 chars
    let chunk = '';
    for (let k = 0; k < 4; k += 1) { chunk = B32[n & 31] + chunk; n >>= 5; }
    out += (out ? '-' : '') + chunk;
  }
  return `VHP-${out}`;
}

function rec(r: Omit<PassportRecord, 'confidence'> & { confidence?: number }): PassportRecord {
  return { ...r, confidence: clamp01(r.confidence ?? CONFIDENCE_BASE[r.verification]) };
}

function shortProof(h: string | null | undefined): string | null {
  return h ? h.slice(0, 10) : null;
}

// ----------------------------------------------------------------- records

export function buildPassportRecords(inp: PassportInputs, view: HomeView): PassportRecord[] {
  const { graph: g, intel, predictions, passports, evidence, outcomes } = inp;
  const out: PassportRecord[] = [];
  const eqById = new Map(g.twin.equipment.map((e) => [e.id, e]));
  const label = (id: string | null) => {
    const e = id ? eqById.get(id) : undefined;
    return e ? equipmentLabel(e) : null;
  };
  const siteEquipmentIds = new Set(g.twin.equipment.map((e) => e.id));

  // ---- ownership periods (the home outlives its owners)
  g.ownership.forEach((p, i) => {
    out.push(rec({
      id: `own-${p.id}`, domain: 'ownership',
      title: p.ended_at ? 'Ownership period' : 'Current ownership',
      detail: `${p.started_at} → ${p.ended_at ?? 'present'}${p.transfer_reason ? ` · ${TRANSFER_REASON_LABELS[p.transfer_reason]}` : ''}`,
      occurredAt: p.started_at, recordedAt: p.started_at, source: 'lifetime_graph',
      sourceDetail: `Owner ${g.ownership.length - i}`, verification: 'system',
      equipmentId: null, jobId: null, proof: null,
    }));
  });

  // ---- property intelligence: parcel / building / construction nodes
  if (intel) {
    for (const n of intel.nodes) {
      out.push(rec({
        id: `node-${n.id}`, domain: n.kind === 'permit' ? 'permit' : 'identity',
        title: `${NODE_KIND_LABELS[n.kind]} — ${n.name}`, detail: null,
        occurredAt: n.occurred_on, recordedAt: n.created_at, source: 'property_intelligence',
        sourceDetail: n.source, verification: n.verified ? 'verified' : 'human',
        equipmentId: null, jobId: null, proof: null,
      }));
    }
    if (intel.profile.normalized_address) {
      const conf = intel.profile.geocode_confidence;
      out.push(rec({
        id: `profile-${intel.profile.id}`, domain: 'identity', title: 'Verified address & location',
        detail: intel.profile.normalized_address, occurredAt: null, recordedAt: intel.profile.last_enriched_at,
        source: 'property_intelligence', sourceDetail: 'Geocoded profile',
        verification: conf !== null && conf >= 0.8 ? 'verified' : 'system',
        confidence: conf ?? undefined, equipmentId: null, jobId: null, proof: null,
      }));
    }
  }

  // ---- equipment inventory + lineage (digital twin)
  for (const s of view.systems) {
    const e = s.equipment;
    const ledger = passports[e.id];
    const sealed = !!ledger && !!ledger.integrity?.valid;
    const detailBits = [
      e.install_date ? `Installed ${e.install_date}` : 'Install date unknown',
      s.ageYears !== null ? `${s.ageYears} yrs old` : null,
      e.serial_number ? 'serial on file' : 'no serial',
      s.lineage.length ? `${s.lineage.length} earlier unit${s.lineage.length === 1 ? '' : 's'} in this location` : null,
    ].filter(Boolean);
    out.push(rec({
      id: `eq-${e.id}`, domain: 'equipment', title: s.label, detail: detailBits.join(' · '),
      occurredAt: e.install_date, recordedAt: e.created_at,
      source: sealed ? 'equipment_passport' : 'digital_twin',
      sourceDetail: ledger ? `Passport ${ledger.code}` : 'Equipment record',
      verification: sealed ? 'verified' : e.install_date && e.serial_number ? 'system' : 'human',
      confidence: sealed ? undefined : (e.install_date ? 0.5 : 0) + (e.serial_number ? 0.3 : 0) + (e.warranty_expires_at ? 0.1 : 0) + 0.1,
      equipmentId: e.id, jobId: null, proof: shortProof(ledger?.integrity?.head_hash),
    }));
  }

  // ---- equipment passport ledger events (hash-chained device history)
  for (const [equipmentId, ledger] of Object.entries(passports)) {
    if (!siteEquipmentIds.has(equipmentId)) continue;
    const valid = !!ledger.integrity?.valid;
    for (const ev of ledger.events) {
      const domain: PassportDomain =
        ev.event_type === 'inspection' ? 'inspection'
          : ev.event_type === 'warranty_event' ? 'warranty'
            : ev.event_type === 'outcome' ? 'outcome'
              : ev.event_type === 'repair' || ev.event_type === 'part_replaced' || ev.event_type === 'service_visit' ? 'repair'
                : 'equipment';
      out.push(rec({
        id: `ledger-${ledger.code}-${ev.seq}`, domain, title: ev.title, detail: ev.detail,
        occurredAt: ev.occurred_at, recordedAt: ev.recorded_at, source: 'equipment_passport',
        sourceDetail: `Ledger #${ev.seq} · ${label(equipmentId) ?? ledger.code}`,
        verification: valid ? 'verified' : 'unverified', equipmentId, jobId: null, proof: shortProof(ev.entry_hash),
      }));
    }
  }

  // ---- service history (repairs / replacements / inspections / maintenance)
  const ledgerHasVisits = new Set(
    Object.values(passports).flatMap((l) => l.events.filter((x) => x.event_type === 'service_visit').map((x) => x.occurred_at.slice(0, 10))),
  );
  for (const h of view.history) {
    if (!h.job.scheduled_datetime) continue;
    const report = evidence[h.job.id];
    const domain: PassportDomain = h.category === 'inspection' ? 'inspection' : 'repair';
    // Avoid a duplicate when the same visit is already sealed in a device ledger on the same day.
    const day = h.job.scheduled_datetime.slice(0, 10);
    const sealedElsewhere = h.equipmentIds.length > 0 && ledgerHasVisits.has(day);
    out.push(rec({
      id: `job-${h.job.id}`, domain,
      title: `${humanize(h.category === 'other' ? 'service' : h.category)}${h.job.service_type ? ` — ${humanize(h.job.service_type)}` : ''}`,
      detail: h.equipmentIds.map(label).filter(Boolean).join(', ') || null,
      occurredAt: h.job.scheduled_datetime, recordedAt: h.job.scheduled_datetime,
      source: 'lifetime_graph', sourceDetail: sealedElsewhere ? 'Job + device ledger' : 'Completed job',
      verification: report?.integrity.valid ? 'verified' : 'system',
      confidence: report?.integrity.valid ? Math.max(0.9, report.score / 100) : undefined,
      equipmentId: h.equipmentIds[0] ?? null, jobId: h.job.id, proof: shortProof(report?.integrity.head_hash),
    }));
  }

  // ---- evidence chain reports
  for (const [jobId, r] of Object.entries(evidence)) {
    out.push(rec({
      id: `evidence-${jobId}`, domain: 'evidence',
      title: `Evidence chain — ${r.level.replace(/_/g, ' ')}`,
      detail: `${r.stats.media_files} file${r.stats.media_files === 1 ? '' : 's'} · ${r.stats.system_verified} system-verified · ${r.stats.human_recorded} human-recorded${r.blocking_gaps.length ? ` · ${r.blocking_gaps.length} blocking gap${r.blocking_gaps.length === 1 ? '' : 's'}` : ''}`,
      occurredAt: r.generated_at, recordedAt: r.generated_at, source: 'evidence_chain',
      sourceDetail: `Integrity ${r.integrity.valid ? 'valid' : `broken at #${r.integrity.broken_seq ?? '?'}`}`,
      verification: r.integrity.valid ? 'verified' : 'unverified', confidence: r.integrity.valid ? clamp01(r.score / 100) : 0.2,
      equipmentId: null, jobId, proof: shortProof(r.integrity.head_hash),
    }));
  }

  // ---- permits
  for (const p of g.permits) {
    const closed = p.status === 'passed' || p.status === 'closed';
    out.push(rec({
      id: `permit-${p.id}`, domain: 'permit',
      title: `${PERMIT_TYPE_LABELS[p.permit_type]} permit${p.permit_number ? ` #${p.permit_number}` : ''}`,
      detail: [PERMIT_STATUS_LABELS[p.status], p.jurisdiction, p.description].filter(Boolean).join(' · '),
      occurredAt: p.issued_on ?? p.applied_on ?? p.created_at, recordedAt: p.created_at,
      source: 'lifetime_graph', sourceDetail: p.jurisdiction ?? 'Permit register',
      verification: p.document_url && closed ? 'verified' : p.document_url ? 'system' : 'human',
      equipmentId: null, jobId: p.job_id, proof: null,
    }));
    if (p.final_inspection_on) {
      out.push(rec({
        id: `permit-insp-${p.id}`, domain: 'inspection',
        title: `Final inspection${p.permit_number ? ` — permit #${p.permit_number}` : ''}`,
        detail: p.status === 'failed' ? 'Failed' : p.status === 'passed' || p.status === 'closed' ? 'Passed' : PERMIT_STATUS_LABELS[p.status],
        occurredAt: p.final_inspection_on, recordedAt: p.created_at, source: 'lifetime_graph',
        sourceDetail: p.jurisdiction ?? 'Permit register', verification: p.document_url ? 'verified' : 'human',
        equipmentId: null, jobId: p.job_id, proof: null,
      }));
    }
  }

  // ---- warranty
  for (const c of g.warrantyClaims) {
    out.push(rec({
      id: `claim-${c.id}`, domain: 'warranty',
      title: `Warranty claim${c.manufacturer ? ` — ${c.manufacturer}` : ''}`,
      detail: `${humanize(c.status)}${c.credit_received_cents ? ' · credit received' : ''}`,
      occurredAt: c.failure_date ?? c.created_at, recordedAt: c.created_at, source: 'warranty',
      sourceDetail: 'Warranty claim register',
      verification: c.status === 'approved' || c.status === 'credit_received' ? 'verified' : 'system',
      equipmentId: c.equipment_id, jobId: c.job_id, proof: null,
    }));
  }
  for (const s of view.systems) {
    if (s.equipment.warranty_expires_at) {
      out.push(rec({
        id: `warranty-${s.equipment.id}`, domain: 'warranty', title: `Warranty — ${s.label}`,
        detail: s.warranty === 'expired' ? 'Expired' : s.warranty === 'expiring' ? 'Expiring within 90 days' : 'Active',
        occurredAt: s.equipment.warranty_expires_at, recordedAt: s.equipment.updated_at, source: 'digital_twin',
        sourceDetail: 'Equipment warranty date', verification: 'human', equipmentId: s.equipment.id, jobId: null, proof: null,
      }));
    }
  }

  // ---- outcomes + failures
  for (const o of outcomes) {
    const job = g.twin.jobs.find((j) => j.id === o.job_id);
    if (!job) continue;
    out.push(rec({
      id: `outcome-${o.job_id}`, domain: 'outcome', title: RESOLUTION_LABELS[o.resolution],
      detail: [o.customer_rating ? `Rated ${o.customer_rating}/5` : null, o.root_cause_key ? `Root cause: ${humanize(o.root_cause_key)}` : null].filter(Boolean).join(' · ') || null,
      occurredAt: job.scheduled_datetime, recordedAt: o.recorded_at, source: 'lifetime_graph',
      sourceDetail: 'Job outcome', verification: 'system', equipmentId: null, jobId: o.job_id, proof: null,
    }));
    if (o.is_rework || o.caused_callback) {
      out.push(rec({
        id: `failure-${o.job_id}`, domain: 'failure', title: o.is_rework ? 'Rework required' : 'Callback after service',
        detail: o.root_cause_key ? `Root cause: ${humanize(o.root_cause_key)}` : null,
        occurredAt: job.scheduled_datetime, recordedAt: o.recorded_at, source: 'lifetime_graph',
        sourceDetail: 'Job outcome', verification: 'system', equipmentId: null, jobId: o.job_id, proof: null,
      }));
    }
  }
  for (const s of view.systems) {
    if (s.recurring) {
      out.push(rec({
        id: `failure-recurring-${s.equipment.id}`, domain: 'failure', title: `Recurring failures — ${s.label}`,
        detail: `${s.repairVisits} repair visits on record`, occurredAt: s.lastServiceDate, recordedAt: null,
        source: 'digital_twin', sourceDetail: 'Repair visit pattern', verification: 'system',
        equipmentId: s.equipment.id, jobId: null, proof: null,
      }));
    }
  }

  // ---- risks (rule-based graph risks + AI predictions)
  for (const r of view.risks) {
    out.push(rec({
      id: `risk-${r.id}`, domain: 'risk', title: r.title, detail: r.detail, occurredAt: null, recordedAt: null,
      source: r.kind === 'predictive' ? 'ai' : 'lifetime_graph', sourceDetail: `${r.severity} · ${humanize(r.kind)}`,
      verification: r.kind === 'predictive' ? 'inferred' : 'system', equipmentId: r.equipmentId, jobId: null, proof: null,
    }));
  }
  for (const p of predictions) {
    if (!siteEquipmentIds.has(p.equipment_id)) continue;
    out.push(rec({
      id: `prediction-${p.id}`, domain: 'risk', title: p.label,
      detail: `${Math.round(p.probability * 100)}% likely in ${p.horizon_days_min}–${p.horizon_days_max} days · ${p.probable_cause}`,
      occurredAt: null, recordedAt: p.updated_at, source: 'ai', sourceDetail: `${p.severity} · ${label(p.equipment_id) ?? 'equipment'}`,
      verification: 'inferred', confidence: Math.min(0.85, clamp01(p.confidence)), equipmentId: p.equipment_id, jobId: null, proof: null,
    }));
  }

  return out.sort((a, b) => (ts(b.occurredAt ?? b.recordedAt) ?? 0) - (ts(a.occurredAt ?? a.recordedAt) ?? 0)
    || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------- trust

export interface TrustFactor { key: string; label: string; earned: number; max: number; hint: string }
export type TrustLevel = 'Sealed' | 'Strong' | 'Developing' | 'Thin';

export interface PassportTrust {
  score: number;
  level: TrustLevel;
  factors: TrustFactor[];
  byVerification: Record<Verification, number>;
  verifiedShare: number;
  avgConfidence: number;
}

function ratio(n: number, d: number): number { return d <= 0 ? 0 : clamp01(n / d); }

export function buildTrust(records: PassportRecord[], inp: PassportInputs, view: HomeView): PassportTrust {
  const byVerification: Record<Verification, number> = { verified: 0, system: 0, human: 0, inferred: 0, unverified: 0 };
  records.forEach((r) => { byVerification[r.verification] += 1; });
  const facts = records.filter((r) => r.verification !== 'inferred');
  const verifiedShare = ratio(byVerification.verified, facts.length);
  const avgConfidence = facts.length ? facts.reduce((s, r) => s + r.confidence, 0) / facts.length : 0;

  const systems = view.systems;
  const sealedSystems = systems.filter((s) => inp.passports[s.equipment.id]?.integrity?.valid).length;
  const completed = view.history.filter((h) => h.category === 'repair' || h.category === 'replacement' || h.category === 'installation');
  const withEvidence = completed.filter((h) => inp.evidence[h.job.id]?.integrity.valid).length;
  const chains = Object.values(inp.passports).filter((p) => p.integrity);
  const brokenLedgers = chains.filter((p) => p.integrity && !p.integrity.valid).length;
  const brokenEvidence = Object.values(inp.evidence).filter((r) => !r.integrity.valid).length;
  const integrityOk = brokenLedgers + brokenEvidence === 0;
  const spanYears = view.costs.yearsTracked;
  const hasIdentity = !!inp.intel?.profile.normalized_address || !!inp.graph.twin.site?.address;

  const f = (key: string, label: string, r: number, max: number, hint: string): TrustFactor =>
    ({ key, label, earned: Math.round(clamp01(r) * max), max, hint });

  const factors: TrustFactor[] = [
    f('identity', 'Property identity', hasIdentity ? (inp.intel?.profile.geocode_confidence ?? 0.7) : 0, 10, 'Verified address, parcel and building records.'),
    f('equipment', 'Equipment passports', ratio(sealedSystems, Math.max(systems.length, 1)), 20, 'Every active system has a sealed Equipment Passport.'),
    f('evidence', 'Evidence on major work', ratio(withEvidence, Math.max(completed.length, 1)), 20, 'Repairs, replacements and installs have a valid Evidence Chain.'),
    f('permits', 'Permits documented', ratio(inp.graph.permits.filter((p) => !!p.document_url).length, Math.max(inp.graph.permits.length, 1)), 10, 'Permit documents attached.'),
    f('history', 'History depth', Math.min(1, spanYears / 5), 10, 'Years of continuous records (5+ for full credit).'),
    f('verified', 'Verified share', verifiedShare, 20, 'Share of facts that are cryptographically sealed or document-backed.'),
    f('integrity', 'Integrity checks', integrityOk ? 1 : 0, 10, brokenLedgers + brokenEvidence ? `${brokenLedgers + brokenEvidence} chain(s) failed verification.` : 'All hash chains verify.'),
  ];
  const score = factors.reduce((s, x) => s + x.earned, 0);
  const level: TrustLevel = !integrityOk ? 'Developing' : score >= 80 ? 'Sealed' : score >= 60 ? 'Strong' : score >= 35 ? 'Developing' : 'Thin';
  return { score, level, factors, byVerification, verifiedShare, avgConfidence };
}

// ------------------------------------------------------------- continuity

export interface OwnerPeriodSummary {
  id: string;
  label: string;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
  isCurrent: boolean;
  records: number;
  repairs: number;
}

/** How much of the home's record each owner period contributed — proof the history outlives owners. */
export function buildContinuity(g: HomeLifetimeGraph, records: PassportRecord[]): OwnerPeriodSummary[] {
  const n = g.ownership.length;
  return g.ownership.map((p, i) => {
    const start = ts(p.started_at) ?? 0;
    const end = p.ended_at ? (ts(p.ended_at) ?? Number.MAX_SAFE_INTEGER) + DAY : Number.MAX_SAFE_INTEGER;
    const inPeriod = records.filter((r) => {
      if (r.domain === 'ownership' || r.domain === 'risk') return false;
      const t = ts(r.occurredAt);
      if (t === null) return false;
      // The earliest period also owns everything that predates the first recorded transfer.
      const lowerOk = i === n - 1 ? true : t >= start;
      return lowerOk && t < end;
    });
    return {
      id: p.id,
      label: `Owner ${n - i}`,
      startedAt: p.started_at,
      endedAt: p.ended_at,
      reason: p.transfer_reason ? TRANSFER_REASON_LABELS[p.transfer_reason] : null,
      isCurrent: p.ended_at === null,
      records: inPeriod.length,
      repairs: inPeriod.filter((r) => r.domain === 'repair').length,
    };
  });
}

// -------------------------------------------------------------------- gaps

export type GapSeverity = 'high' | 'medium' | 'low';
export interface PassportGap {
  id: string;
  severity: GapSeverity;
  title: string;
  detail: string;
  equipmentId: string | null;
  action: 'passport' | 'evidence' | 'permit' | 'equipment' | 'integrity' | 'identity';
}

const GAP_RANK: Record<GapSeverity, number> = { high: 0, medium: 1, low: 2 };

export function buildGaps(inp: PassportInputs, view: HomeView): PassportGap[] {
  const out: PassportGap[] = [];
  for (const s of view.systems) {
    const id = s.equipment.id;
    if (!inp.passports[id]) {
      out.push({ id: `gap-pass-${id}`, severity: 'medium', title: `No verified Equipment Passport — ${s.label}`,
        detail: 'Scan the unit label to seal its history so it follows the machine across owners.', equipmentId: id, action: 'passport' });
    }
    if (!s.equipment.install_date || !s.equipment.serial_number) {
      out.push({ id: `gap-eq-${id}`, severity: 'low', title: `Incomplete equipment record — ${s.label}`,
        detail: `Missing ${[!s.equipment.install_date && 'install date', !s.equipment.serial_number && 'serial number'].filter(Boolean).join(' and ')}.`,
        equipmentId: id, action: 'equipment' });
    }
  }
  for (const h of view.history) {
    if (!(h.category === 'repair' || h.category === 'replacement' || h.category === 'installation')) continue;
    if (inp.evidence[h.job.id]?.integrity.valid) continue;
    out.push({ id: `gap-ev-${h.job.id}`, severity: h.category === 'repair' ? 'low' : 'medium',
      title: `No sealed evidence — ${humanize(h.category)}${h.job.service_type ? ` (${humanize(h.job.service_type)})` : ''}`,
      detail: 'Add before/after measurements and photos to the job’s Evidence Chain.', equipmentId: h.equipmentIds[0] ?? null, action: 'evidence' });
  }
  for (const p of inp.graph.permits) {
    if (!p.document_url && p.status !== 'planned' && p.status !== 'withdrawn') {
      out.push({ id: `gap-permit-${p.id}`, severity: p.status === 'failed' ? 'high' : 'medium',
        title: `Permit has no document — ${PERMIT_TYPE_LABELS[p.permit_type]}${p.permit_number ? ` #${p.permit_number}` : ''}`,
        detail: 'Attach the permit or inspection document so the record can be verified.', equipmentId: null, action: 'permit' });
    }
  }
  for (const [eq, l] of Object.entries(inp.passports)) {
    if (l.integrity && !l.integrity.valid) {
      out.push({ id: `gap-int-${eq}`, severity: 'high', title: `Ledger integrity check failed — ${l.code}`,
        detail: `Hash chain breaks at entry #${l.integrity.broken_at_seq ?? '?'}. Treat later entries as unverified.`, equipmentId: eq, action: 'integrity' });
    }
  }
  for (const [jobId, r] of Object.entries(inp.evidence)) {
    if (!r.integrity.valid) {
      out.push({ id: `gap-evint-${jobId}`, severity: 'high', title: 'Evidence chain integrity failed',
        detail: `Breaks at entry #${r.integrity.broken_seq ?? '?'} (${r.integrity.reason?.replace(/_/g, ' ') ?? 'unknown'}).`, equipmentId: null, action: 'integrity' });
    }
  }
  if (!inp.intel?.profile.normalized_address) {
    out.push({ id: 'gap-identity', severity: 'medium', title: 'Property address not verified',
      detail: 'Run Property Intelligence enrichment to geocode and anchor this home’s identity.', equipmentId: null, action: 'identity' });
  }
  return out.sort((a, b) => GAP_RANK[a.severity] - GAP_RANK[b.severity] || a.title.localeCompare(b.title));
}

// -------------------------------------------------------------------- view

export interface HomePassport {
  homeId: string;
  siteId: string;
  name: string;
  address: string | null;
  yearBuilt: number | null;
  firstRecordAt: string | null;
  owners: number;
  currentOwnerName: string | null;
  records: PassportRecord[];
  domainCounts: Record<PassportDomain, number>;
  trust: PassportTrust;
  continuity: OwnerPeriodSummary[];
  gaps: PassportGap[];
  view: HomeView;
  contributors: { technicians: number; contractors: number };
  generatedAt: string;
}

export function buildHomePassport(inp: PassportInputs, now: number = Date.now()): HomePassport {
  const view = deriveHomeView(inp.graph, now);
  const records = buildPassportRecords(inp, view);
  const domainCounts = Object.keys(DOMAIN_LABELS).reduce((acc, k) => ({ ...acc, [k]: 0 }), {} as Record<PassportDomain, number>);
  records.forEach((r) => { domainCounts[r.domain] += 1; });
  const dated = records.map((r) => ts(r.occurredAt)).filter((t): t is number => t !== null);
  const site = inp.graph.twin.site;
  return {
    homeId: homeIdFromSiteId(inp.graph.siteId),
    siteId: inp.graph.siteId,
    name: site?.name ?? 'Home',
    address: inp.intel?.profile.normalized_address ?? site?.address ?? null,
    yearBuilt: inp.graph.yearBuilt,
    firstRecordAt: dated.length ? new Date(Math.min(...dated)).toISOString() : null,
    owners: Math.max(1, inp.graph.ownership.length),
    currentOwnerName: inp.graph.ownership[0]?.ownerName ?? null,
    records,
    domainCounts,
    trust: buildTrust(records, inp, view),
    continuity: buildContinuity(inp.graph, records),
    gaps: buildGaps(inp, view),
    view,
    contributors: { technicians: view.technicians.length, contractors: inp.graph.contractors.length },
    generatedAt: new Date(now).toISOString(),
  };
}

// ----------------------------------------------------------------- filters

export interface RecordFilter { domain: PassportDomain | 'all'; verification: Verification | 'all'; query: string }

export function filterRecords(records: PassportRecord[], f: RecordFilter): PassportRecord[] {
  const q = f.query.trim().toLowerCase();
  return records.filter((r) =>
    (f.domain === 'all' || r.domain === f.domain)
    && (f.verification === 'all' || r.verification === f.verification)
    && (!q || `${r.title} ${r.detail ?? ''} ${r.sourceDetail ?? ''}`.toLowerCase().includes(q)));
}

// ------------------------------------------------------------------ export

export interface PassportExport {
  schema: 'vireek.home-passport/1';
  homeId: string;
  generatedAt: string;
  property: { name: string; address: string | null; yearBuilt: number | null; owners: number };
  trust: { score: number; level: TrustLevel; verifiedShare: number };
  records: Array<Pick<PassportRecord, 'id' | 'domain' | 'title' | 'detail' | 'occurredAt' | 'recordedAt' | 'source' | 'confidence' | 'verification' | 'proof'>>;
}

/**
 * Redacted, shareable snapshot (buyer / insurer / next tenant). Owner and technician
 * names, prices and internal ids that identify people are intentionally excluded.
 */
export function toPassportExport(p: HomePassport): PassportExport {
  return {
    schema: 'vireek.home-passport/1',
    homeId: p.homeId,
    generatedAt: p.generatedAt,
    property: { name: p.name, address: p.address, yearBuilt: p.yearBuilt, owners: p.owners },
    trust: { score: p.trust.score, level: p.trust.level, verifiedShare: Math.round(p.trust.verifiedShare * 100) / 100 },
    records: p.records
      .filter((r) => r.domain !== 'ownership' && r.domain !== 'risk')
      .map((r) => ({
        id: r.id, domain: r.domain, title: r.title, detail: r.detail, occurredAt: r.occurredAt, recordedAt: r.recordedAt,
        source: r.source, confidence: Math.round(r.confidence * 100) / 100, verification: r.verification, proof: r.proof,
      })),
  };
}
