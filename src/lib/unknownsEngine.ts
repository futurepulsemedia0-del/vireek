/**
 * Vireek Unknowns Engine — pure domain logic.
 *
 * Most AI products answer. This one manages *what it does not know*.
 * For every decision dimension of a job it classifies the current state of
 * knowledge as Known / Likely / Uncertain / Unknown / Contradictory /
 * Unverified, explains exactly why, and names the cheapest step that resolves
 * it. Before a decision it surfaces the few unknowns worth resolving first.
 *
 * Design rules (deliberate, keep them when extending):
 *  - Deterministic and side-effect free. No network, no LLM, no Date.now():
 *    the same input always yields the same report, so the UI can never
 *    disagree with a test, and nothing here can hallucinate.
 *  - Never fabricate certainty. Machine-generated evidence (AI diagnosis,
 *    rule/AI permit review) is capped at "Unverified" until a person confirms
 *    it; facts the system has no structured data for (physical site condition,
 *    part fitment) are capped below "Known" until a person verifies them.
 *  - A failed data load is reported as an unknown, never as silence.
 *  - Soft gate only: the verdict advises, it never blocks a status change.
 *
 * Counterparts: src/lib/unknownsEngineApi.ts (data loading + resolutions),
 * src/components/jobs/JobUnknownsPanel.tsx, supabase/migrations/
 * 20270210000000_unknowns_engine.sql. Keep dimension keys in sync with the
 * CHECK constraint in that migration.
 */

// ============================================================
// TYPES
// ============================================================

export type UnknownStatus =
  | 'known'
  | 'likely'
  | 'uncertain'
  | 'unknown'
  | 'contradictory'
  | 'unverified';

export type UnknownDimensionKey =
  | 'diagnosis'
  | 'equipment_identity'
  | 'part_compatibility'
  | 'site_condition'
  | 'permit_requirement'
  | 'scope_and_price';

export type GateVerdict = 'clear' | 'proceed_with_caution' | 'resolve_first';
export type ResolutionKind = 'verified' | 'waived';

export interface RawResolution {
  dimension: UnknownDimensionKey;
  resolution: ResolutionKind;
  value: string | null;
  note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

/** Evidence source that may have failed to load. `ok:false` is treated as "cannot assess". */
export interface Loaded<T> {
  ok: boolean;
  data: T;
}

export interface RawDiagnosisSession {
  id: string;
  equipment_id: string | null;
  /** 0-1 as stored by the diagnosis-copilot normalizer. */
  confidence: number | null;
  severity: string | null;
  top_cause: string | null;
  top_likelihood: number | null;
  missing_info: string[];
  parts: { name: string; necessity: 'likely' | 'possible' | 'if_confirmed' }[];
  created_at: string;
}

export interface RawEquipment {
  id: string;
  equipment_type: string | null;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  status: string | null;
}

export interface RawJobPart {
  status: 'needed' | 'allocated' | 'installed' | 'backordered' | string;
}

export interface RawSite {
  address: string | null;
  access_notes: string | null;
  site_contact_name: string | null;
  site_contact_phone: string | null;
}

export interface RawComplianceReview {
  permit_likelihood: 'likely_required' | 'possibly_required' | 'unlikely' | 'unknown';
  jurisdiction_basis: 'address' | 'country_only' | 'unknown' | null;
  jurisdiction_coverage: 'us_curated' | 'country_curated' | 'generic' | null;
  requirements: { key: string; category: string; severity: 'blocker' | 'warning' | 'info' }[];
  item_progress: Record<string, { status: string } | undefined>;
  verify_questions: string[];
}

export interface RawNoSurprise {
  pending: number;
  approved: number;
}

export interface UnknownsInput {
  job: {
    id: string;
    job_status: string;
    service_type: string | null;
    dispatch_note: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    site_id: string | null;
    customer_phone: string | null;
    quote_id: string | null;
    invoice_amount: number | null;
    technician_diagnosis: string | null;
    diagnosis_notes: string | null;
    before_photo_count: number;
  };
  diagnosis: Loaded<RawDiagnosisSession[]>;
  equipment: Loaded<RawEquipment[]>;
  parts: Loaded<RawJobPart[]>;
  site: Loaded<RawSite | null>;
  compliance: Loaded<RawComplianceReview | null>;
  /** Optional signal: a failed load is simply skipped, never reported as certainty or doubt. */
  noSurprise: RawNoSurprise | null;
  resolutions: RawResolution[];
}

export interface DimensionAssessment {
  key: UnknownDimensionKey;
  label: string;
  /** False when the dimension does not apply yet (e.g. no parts expected). Excluded from scores. */
  applicable: boolean;
  status: UnknownStatus;
  /** 0-100. 100 only when a person verified it. */
  confidencePct: number;
  summary: string;
  /** What the engine actually found. */
  evidence: string[];
  /** What is missing or in conflict. */
  gaps: string[];
  /** The cheapest step that resolves this unknown. */
  resolveWith: string;
  weight: number;
  resolution: RawResolution | null;
  /** 'resolved' = verified by a person; 'waived' = risk knowingly accepted. */
  state: 'open' | 'resolved' | 'waived';
  /** Expected value of resolving it — drives gate ordering. 0 when closed. */
  priority: number;
}

export interface UnknownsReport {
  /** 0-100 weighted decision readiness over applicable dimensions. null when nothing is assessable. */
  readinessPct: number | null;
  verdict: GateVerdict;
  headline: string;
  dimensions: DimensionAssessment[];
  /** The few unknowns to resolve before deciding, highest value first (max 3). */
  resolveFirst: DimensionAssessment[];
  counts: Record<UnknownStatus, number>;
}

// ============================================================
// DISCLOSED ASSUMPTIONS — tune to real numbers
// ============================================================

export const UNKNOWNS_ASSUMPTIONS = {
  /** Status bands for evidence confidence (percent). */
  knownMin: 90,
  likelyMin: 70,
  uncertainMin: 40,
  /** Ceilings for machine-only or unstructured evidence — only a person can lift these. */
  siteConditionAutoCap: 85,
  partFitmentAutoCap: 85,
  machineEvidenceCap: 95,
  /** Two diagnoses (or AI vs technician) agree when this share of the shorter cause's keywords overlap. */
  causeAgreementMin: 0.34,
  /** Both causes must carry at least this confidence (0-1) before disagreement counts as a contradiction. */
  contradictionMinConfidence: 0.5,
  /** Gate. */
  resolveFirstReadinessBelow: 60,
  cautionReadinessBelow: 80,
  highWeight: 0.15,
  maxResolveFirst: 3,
  minPriority: 3,
} as const;

export const DIMENSION_META: Record<UnknownDimensionKey, { label: string; weight: number }> = {
  diagnosis: { label: 'Diagnosis', weight: 0.25 },
  equipment_identity: { label: 'Equipment identity', weight: 0.18 },
  permit_requirement: { label: 'Permit requirement', weight: 0.18 },
  part_compatibility: { label: 'Part compatibility', weight: 0.15 },
  site_condition: { label: 'Site condition', weight: 0.12 },
  scope_and_price: { label: 'Scope & price', weight: 0.12 },
};

export const DIMENSION_ORDER: UnknownDimensionKey[] = [
  'diagnosis',
  'equipment_identity',
  'part_compatibility',
  'site_condition',
  'permit_requirement',
  'scope_and_price',
];

export const STATUS_META: Record<UnknownStatus, { label: string; className: string; hint: string }> = {
  known: { label: 'Known', className: 'bg-success-500/10 text-success-500', hint: 'Backed by confirmed evidence.' },
  likely: { label: 'Likely', className: 'bg-accent/10 text-accent', hint: 'Strong evidence, not fully confirmed.' },
  uncertain: { label: 'Uncertain', className: 'bg-warning-500/10 text-warning-500', hint: 'Some evidence, important gaps.' },
  unknown: { label: 'Unknown', className: 'bg-danger/10 text-danger', hint: 'No usable evidence yet.' },
  contradictory: { label: 'Contradictory', className: 'bg-danger/10 text-danger', hint: 'Sources disagree — confirm which is right.' },
  unverified: { label: 'Unverified', className: 'bg-warning-500/10 text-warning-500', hint: 'Only machine-generated or unchecked evidence.' },
};

export const VERDICT_META: Record<GateVerdict, { label: string; className: string }> = {
  clear: { label: 'Ready to decide', className: 'border-success-500/30 bg-success-500/5' },
  proceed_with_caution: { label: 'Proceed with caution', className: 'border-warning-500/30 bg-warning-500/5' },
  resolve_first: { label: 'Resolve unknowns first', className: 'border-danger/30 bg-danger/5' },
};

/** Statuses that can still be a blocker for a decision. */
const OPEN_STATUSES: ReadonlySet<UnknownStatus> = new Set(['unknown', 'contradictory', 'unverified', 'uncertain']);

/** Job phases where unknowns still matter. Closed jobs are reviewed elsewhere (evidence chain / autopsy). */
export const UNKNOWNS_ELIGIBLE_STATUSES = new Set(['scheduled', 'en_route', 'in_progress']);

// ============================================================
// HELPERS
// ============================================================

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const filled = (s: string | null | undefined, min = 1) => typeof s === 'string' && s.trim().length >= min;
const pct01 = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? clamp(n * 100) : null);

const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'unit', 'system', 'issue', 'problem', 'likely', 'probable',
  'caused', 'cause', 'failed', 'failure', 'bad', 'faulty', 'broken', 'needs', 'need', 'replace',
]);

/** Crude keyword stem: lowercase, letters only, drop short/stop words, trim common suffixes. */
export function keywords(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? '').toLowerCase().split(/[^a-z]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw)) continue;
    out.add(raw.replace(/(ing|ed|es|s)$/, ''));
  }
  return out;
}

/** Overlap coefficient: shared keywords over the smaller set. 1 when either set is a subset of the other. */
export function causeOverlap(a: string | null | undefined, b: string | null | undefined): number | null {
  const ka = keywords(a);
  const kb = keywords(b);
  const min = Math.min(ka.size, kb.size);
  if (min === 0) return null; // nothing comparable — never call that a contradiction
  let shared = 0;
  for (const k of ka) if (kb.has(k)) shared += 1;
  return shared / min;
}

interface Draft {
  confidencePct: number;
  /** True when no human has confirmed the evidence (AI / rules / unstructured). */
  machineOnly?: boolean;
  contradiction?: boolean;
  noEvidence?: boolean;
  summary: string;
  evidence: string[];
  gaps: string[];
  resolveWith: string;
}

export function statusFor(
  confidencePct: number,
  flags: { machineOnly?: boolean; contradiction?: boolean; noEvidence?: boolean },
): UnknownStatus {
  const A = UNKNOWNS_ASSUMPTIONS;
  if (flags.contradiction) return 'contradictory';
  if (flags.noEvidence || confidencePct < A.uncertainMin) return 'unknown';
  if (flags.machineOnly) return 'unverified';
  if (confidencePct >= A.knownMin) return 'known';
  if (confidencePct >= A.likelyMin) return 'likely';
  return 'uncertain';
}

function sessionsNewestFirst(list: RawDiagnosisSession[]): RawDiagnosisSession[] {
  return [...list].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

// ============================================================
// DIMENSION ASSESSORS — each returns a Draft, none throws
// ============================================================

const NOT_LOADED = (what: string): Draft => ({
  confidencePct: 0,
  noEvidence: true,
  summary: `${what} could not be loaded, so this is treated as unknown.`,
  evidence: [],
  gaps: [`${what} could not be loaded.`],
  resolveWith: 'Refresh. If it persists, check your connection or permissions.',
});

function assessDiagnosis(input: UnknownsInput): Draft {
  if (!input.diagnosis.ok) return NOT_LOADED('Diagnosis evidence');
  const A = UNKNOWNS_ASSUMPTIONS;
  const sessions = sessionsNewestFirst(input.diagnosis.data);
  const latest = sessions[0] ?? null;
  const humanDx = [input.job.technician_diagnosis, input.job.diagnosis_notes].find((s) => filled(s, 10)) ?? null;

  if (!latest && !humanDx) {
    return {
      confidencePct: 0,
      noEvidence: true,
      summary: 'No diagnosis exists for this job yet.',
      evidence: [],
      gaps: ['No AI diagnosis session and no technician diagnosis recorded.'],
      resolveWith: 'Run the Diagnosis Copilot or record the technician’s diagnosis on the job.',
    };
  }

  const evidence: string[] = [];
  const gaps: string[] = [];
  let contradiction = false;
  let aiPct: number | null = null;

  if (latest) {
    aiPct = pct01(latest.confidence) ?? pct01(latest.top_likelihood);
    evidence.push(
      `AI diagnosis${latest.top_cause ? `: “${latest.top_cause}”` : ''}${aiPct !== null ? ` at ${Math.round(aiPct)}% confidence` : ''}.`,
    );
    if (latest.severity === 'emergency') evidence.push('AI flagged this as an emergency-severity case.');
    for (const m of latest.missing_info.slice(0, 3)) gaps.push(`AI says it still needs: ${m}`);
  }
  if (humanDx) evidence.push('Technician diagnosis is recorded on the job.');

  // Contradiction 1: two AI runs disagree about the top cause.
  if (sessions.length >= 2) {
    const [a, b] = sessions;
    const min = A.contradictionMinConfidence;
    if ((a.confidence ?? 0) >= min && (b.confidence ?? 0) >= min) {
      const ov = causeOverlap(a.top_cause, b.top_cause);
      if (ov !== null && ov < A.causeAgreementMin) {
        contradiction = true;
        gaps.push(`Two diagnosis runs disagree: “${a.top_cause}” vs “${b.top_cause}”.`);
      }
    }
  }
  // Contradiction 2: technician text does not mention the AI's top cause at all.
  let humanAgrees: boolean | null = null;
  if (latest && humanDx && latest.top_cause && (latest.confidence ?? 0) >= A.contradictionMinConfidence) {
    const ov = causeOverlap(latest.top_cause, humanDx);
    if (ov !== null) {
      humanAgrees = ov >= A.causeAgreementMin;
      if (!humanAgrees) {
        contradiction = true;
        gaps.push('Technician diagnosis does not match the AI’s top cause — confirm which is right.');
      }
    }
  }

  let conf: number;
  if (humanDx && latest) conf = humanAgrees ? Math.max(aiPct ?? 70, 70) + 12 : Math.min(aiPct ?? 45, 45);
  else if (humanDx) conf = 72;
  else conf = aiPct ?? 50;
  conf -= Math.min(16, (latest?.missing_info.length ?? 0) * 4);

  return {
    confidencePct: clamp(conf, 0, A.machineEvidenceCap),
    machineOnly: !humanDx,
    contradiction,
    summary: contradiction
      ? 'Diagnosis sources disagree.'
      : humanDx
        ? 'Diagnosis recorded by a technician' + (latest ? ' and cross-checked against the AI.' : '.')
        : 'Diagnosis comes from AI only — no technician has confirmed it.',
    evidence,
    gaps,
    resolveWith: contradiction
      ? 'Re-test the leading cause on site and record the confirmed diagnosis.'
      : humanDx
        ? 'Record the measurement or test that confirmed the diagnosis.'
        : 'Have the technician confirm the cause with a test, then record it.',
  };
}

function equipmentCompleteness(e: RawEquipment): number {
  return (
    (filled(e.make) ? 25 : 0) +
    (filled(e.model) ? 30 : 0) +
    (filled(e.serial_number) ? 30 : 0) +
    (filled(e.equipment_type) ? 10 : 0) +
    (filled(e.install_date) ? 5 : 0)
  );
}

function assessEquipment(input: UnknownsInput): Draft {
  if (!input.equipment.ok) return NOT_LOADED('Equipment records');
  const items = input.equipment.data;
  const latest = sessionsNewestFirst(input.diagnosis.ok ? input.diagnosis.data : [])[0] ?? null;

  if (items.length === 0) {
    const referenced = Boolean(latest?.equipment_id);
    return {
      confidencePct: referenced ? 20 : 0,
      noEvidence: !referenced,
      summary: 'No equipment is linked to this job.',
      evidence: referenced ? ['A diagnosis references a unit, but it is not linked to the job.'] : [],
      gaps: ['No make, model or serial number on file for this job.'],
      resolveWith: 'Photograph the data plate and link the unit (make, model, serial) to the job.',
    };
  }

  const weakest = Math.min(...items.map(equipmentCompleteness));
  const evidence = [`${items.length} unit${items.length > 1 ? 's' : ''} linked to the job.`];
  const gaps: string[] = [];
  let contradiction = false;

  for (const e of items) {
    if (!filled(e.make)) gaps.push('A linked unit has no make.');
    if (!filled(e.model)) gaps.push('A linked unit has no model.');
    if (!filled(e.serial_number)) gaps.push('A linked unit has no serial number.');
    if (e.status === 'replaced' || e.status === 'removed') {
      contradiction = true;
      gaps.push(`A linked unit is marked “${e.status}” in its record but is attached to a live job.`);
    }
  }
  if (latest?.equipment_id && !items.some((e) => e.id === latest.equipment_id)) {
    contradiction = true;
    gaps.push('The latest diagnosis was run on a different unit than the one linked to this job.');
  }

  return {
    confidencePct: clamp(weakest, 0, 99),
    contradiction,
    summary: contradiction
      ? 'Records disagree about which unit this job is on.'
      : weakest >= 90
        ? 'Make, model and serial are on file.'
        : 'Equipment record is incomplete.',
    evidence,
    gaps: [...new Set(gaps)],
    resolveWith: contradiction
      ? 'Confirm the unit on site against its data plate and fix the link or status.'
      : 'Photograph the data plate and complete the missing fields.',
  };
}

function assessParts(input: UnknownsInput, equipmentConf: number): Draft | null {
  const A = UNKNOWNS_ASSUMPTIONS;
  if (!input.parts.ok) return NOT_LOADED('Parts requirements');
  const rows = input.parts.data;
  const latest = sessionsNewestFirst(input.diagnosis.ok ? input.diagnosis.data : [])[0] ?? null;
  const expected = (latest?.parts ?? []).filter((p) => p.necessity === 'likely' || p.necessity === 'possible');
  if (rows.length === 0 && expected.length === 0) return null; // not applicable yet

  const evidence: string[] = [];
  const gaps: string[] = [];
  let conf = 30;

  if (expected.length) evidence.push(`${expected.length} part${expected.length > 1 ? 's' : ''} suggested by the diagnosis.`);
  if (rows.length) evidence.push(`${rows.length} part${rows.length > 1 ? 's' : ''} on the job’s requirement list.`);

  if (equipmentConf >= 55) conf += 30;
  else gaps.push('Equipment identity is too weak to confirm any part fits.');

  const likelyCount = expected.filter((p) => p.necessity === 'likely').length;
  if (rows.length >= Math.max(1, likelyCount) && rows.length > 0) conf += 25;
  else if (likelyCount > rows.length) gaps.push(`${likelyCount - rows.length} likely part(s) from the diagnosis are not on the requirement list.`);

  const backordered = rows.filter((r) => r.status === 'backordered').length;
  if (backordered) {
    conf -= 15;
    gaps.push(`${backordered} part(s) are backordered.`);
  } else if (rows.length) conf += 10;

  if (input.equipment.ok && input.equipment.data.length === 0 && rows.some((r) => r.status === 'allocated' || r.status === 'installed')) {
    conf = Math.min(conf, 30);
    gaps.push('Parts are allocated but no unit is linked to check them against.');
  }

  gaps.push('Fitment has not been checked against a manufacturer cross-reference.');
  return {
    confidencePct: clamp(conf, 0, A.partFitmentAutoCap),
    machineOnly: true,
    summary: 'Parts are listed, but nobody has confirmed they fit this exact unit.',
    evidence,
    gaps,
    resolveWith: 'Match each part number to the unit’s model/serial in the manufacturer catalog and record the result.',
  };
}

function assessSite(input: UnknownsInput): Draft {
  if (!input.site.ok) return NOT_LOADED('Site records');
  const A = UNKNOWNS_ASSUMPTIONS;
  const { job } = input;
  const site = input.site.data;
  const evidence: string[] = [];
  const gaps: string[] = [];
  let conf = 0;

  const add = (ok: boolean, pts: number, have: string, missing: string) => {
    if (ok) {
      conf += pts;
      evidence.push(have);
    } else gaps.push(missing);
  };

  add(filled(job.address, 5) || filled(site?.address, 5), 20, 'Service address on file.', 'No service address.');
  add(job.latitude !== null && job.longitude !== null, 10, 'Address is geocoded.', 'Address is not geocoded.');
  add(site !== null, 10, 'Linked to a customer site record.', 'No customer site record linked.');
  add(filled(site?.access_notes) || filled(job.dispatch_note, 10), 15, 'Access or dispatch notes recorded.', 'No access notes (parking, gate codes, hazards).');
  add(
    filled(job.customer_phone) || filled(site?.site_contact_phone) || filled(site?.site_contact_name),
    15,
    'An on-site contact is reachable.',
    'No on-site contact.',
  );
  add(filled(job.dispatch_note, 10), 10, 'Dispatch note describes the work.', 'No dispatch note.');
  add(job.before_photo_count > 0, 20, `${job.before_photo_count} before-photo(s) show the site.`, 'No photos of the work area.');

  gaps.push('Physical conditions (access, clearance, hazards) are not recorded as structured data.');
  return {
    confidencePct: clamp(conf, 0, A.siteConditionAutoCap),
    noEvidence: conf === 0,
    machineOnly: false,
    summary: conf === 0 ? 'Nothing is recorded about the site.' : 'Only logistics are known — physical site condition is not confirmed.',
    evidence,
    gaps,
    resolveWith: 'Confirm access, working space and hazards with the customer or from site photos.',
  };
}

const PERMIT_CATEGORIES = new Set(['permit', 'inspection', 'licensing']);

function assessPermit(input: UnknownsInput): Draft {
  if (!input.compliance.ok) return NOT_LOADED('Permit & compliance review');
  const A = UNKNOWNS_ASSUMPTIONS;
  const review = input.compliance.data;

  if (!review) {
    const scoped = filled(input.job.service_type) || filled(input.job.dispatch_note);
    return {
      confidencePct: 0,
      noEvidence: true,
      summary: 'No permit determination exists for this job.',
      evidence: [],
      gaps: [scoped ? 'The compliance review has not been run.' : 'The job does not say what the work is, so permits cannot be assessed.'],
      resolveWith: scoped
        ? 'Run the compliance check in the Permit & Compliance panel.'
        : 'Add the service type or a dispatch note, then run the compliance check.',
    };
  }

  const relevant = review.requirements.filter(
    (r) => PERMIT_CATEGORIES.has(r.category) && (r.severity === 'blocker' || r.severity === 'warning'),
  );
  const resolvedOf = (r: { key: string }) => {
    const s = review.item_progress[r.key]?.status;
    return s === 'satisfied' || s === 'not_applicable';
  };
  const resolved = relevant.filter(resolvedOf);
  const permitItems = review.requirements.filter((r) => r.category === 'permit');
  const unresolvedPermitBlockers = permitItems.filter((r) => r.severity === 'blocker' && !resolvedOf(r));

  const evidence: string[] = [`Permit likelihood assessed as “${review.permit_likelihood.replace(/_/g, ' ')}”.`];
  const gaps: string[] = [];
  let contradiction = false;

  if (review.permit_likelihood === 'unlikely' && unresolvedPermitBlockers.length) {
    contradiction = true;
    gaps.push('Review says a permit is unlikely, yet it lists unresolved permit blockers.');
  }
  const allNa =
    permitItems.length > 0 &&
    permitItems.every((r) => review.item_progress[r.key]?.status === 'not_applicable');
  if (review.permit_likelihood === 'likely_required' && allNa) {
    contradiction = true;
    gaps.push('Review says a permit is likely required, yet every permit item was marked not applicable.');
  }

  const base = { unknown: 20, possibly_required: 45, likely_required: 60, unlikely: 70 }[review.permit_likelihood];
  let conf = base;
  if (relevant.length) {
    conf += Math.round(30 * (resolved.length / relevant.length));
    evidence.push(`${resolved.length} of ${relevant.length} permit/inspection/licensing items resolved by your team.`);
  } else conf += 15;

  if (review.jurisdiction_coverage === 'generic') {
    conf -= 15;
    gaps.push('Rules for this jurisdiction are generic, not locally curated.');
  }
  if (review.jurisdiction_basis === 'unknown') {
    conf -= 15;
    gaps.push('No address, so the jurisdiction could not be determined.');
  }
  for (const q of review.verify_questions.slice(0, 3)) gaps.push(`Verify: ${q}`);

  const humanConfirmed = relevant.length > 0 && resolved.length === relevant.length;
  return {
    confidencePct: clamp(conf, 0, A.machineEvidenceCap),
    machineOnly: !humanConfirmed,
    contradiction,
    summary: contradiction
      ? 'The permit review contradicts itself.'
      : humanConfirmed
        ? 'Every permit-related requirement has been checked by your team.'
        : 'Permit requirement comes from rules/AI and has not been checked with the authority.',
    evidence,
    gaps,
    resolveWith: contradiction
      ? 'Call the local authority to settle whether a permit is required, then update the items.'
      : 'Confirm with the local authority, then mark each requirement done or not applicable.',
  };
}

function assessScope(input: UnknownsInput): Draft {
  const { job } = input;
  const evidence: string[] = [];
  const gaps: string[] = [];
  let conf = 0;

  if (job.quote_id) {
    conf += 45;
    evidence.push('A quote is linked to this job.');
  } else gaps.push('No quote is linked, so the price is not agreed.');
  if (job.invoice_amount !== null) {
    conf += 15;
    evidence.push('An amount is set on the job.');
  } else gaps.push('No amount is set on the job.');
  if (filled(job.service_type)) {
    conf += 10;
    evidence.push('Service type is defined.');
  } else gaps.push('Service type is not defined.');

  const ns = input.noSurprise;
  if (ns && ns.pending > 0) {
    conf = Math.min(conf, 45);
    gaps.push(`${ns.pending} additional-work disclosure(s) are waiting on the customer’s decision.`);
  } else {
    conf += 15;
    if (ns && ns.approved > 0) {
      conf += 15;
      evidence.push(`${ns.approved} additional-work disclosure(s) approved by the customer.`);
    }
  }

  return {
    confidencePct: clamp(conf, 0, 99),
    noEvidence: conf <= 15 && !job.quote_id && job.invoice_amount === null,
    summary: job.quote_id ? 'Scope and price are backed by a quote.' : 'Scope and price are not yet agreed in writing.',
    evidence,
    gaps,
    resolveWith: ns && ns.pending > 0
      ? 'Get the customer’s decision on the pending disclosure before more work is done.'
      : 'Send a quote or record the agreed amount and scope.',
  };
}

// ============================================================
// ORCHESTRATION
// ============================================================

function toAssessment(
  key: UnknownDimensionKey,
  draft: Draft | null,
  resolution: RawResolution | null,
): DimensionAssessment {
  const meta = DIMENSION_META[key];
  if (draft === null) {
    return {
      key,
      label: meta.label,
      applicable: false,
      status: 'known',
      confidencePct: 0,
      summary: 'Not applicable yet — nothing to assess.',
      evidence: [],
      gaps: [],
      resolveWith: '',
      weight: meta.weight,
      resolution: null,
      state: 'open',
      priority: 0,
    };
  }

  const computedStatus = statusFor(draft.confidencePct, draft);
  const verified = resolution?.resolution === 'verified';
  const waived = resolution?.resolution === 'waived';

  const status: UnknownStatus = verified ? 'known' : computedStatus;
  const confidencePct = verified ? 100 : Math.round(draft.confidencePct);
  const state: DimensionAssessment['state'] = verified ? 'resolved' : waived ? 'waived' : 'open';

  const boost = status === 'contradictory' ? 1.5 : status === 'unknown' ? 1.25 : 1;
  const priority =
    state === 'open' && OPEN_STATUSES.has(status) ? meta.weight * (100 - confidencePct) * boost : 0;

  return {
    key,
    label: meta.label,
    applicable: true,
    status,
    confidencePct,
    summary: verified ? `Verified by your team${resolution?.value ? `: ${resolution.value}` : '.'}` : draft.summary,
    evidence: draft.evidence,
    gaps: verified ? [] : draft.gaps,
    resolveWith: draft.resolveWith,
    weight: meta.weight,
    resolution,
    state,
    priority,
  };
}

export function assessJobUnknowns(input: UnknownsInput): UnknownsReport {
  const A = UNKNOWNS_ASSUMPTIONS;
  const byDim = new Map<UnknownDimensionKey, RawResolution>();
  for (const r of input.resolutions) byDim.set(r.dimension, r);

  const equipmentDraft = assessEquipment(input);
  const equipmentConf = byDim.get('equipment_identity')?.resolution === 'verified' ? 100 : equipmentDraft.confidencePct;

  const drafts: Record<UnknownDimensionKey, Draft | null> = {
    diagnosis: assessDiagnosis(input),
    equipment_identity: equipmentDraft,
    part_compatibility: assessParts(input, equipmentConf),
    site_condition: assessSite(input),
    permit_requirement: assessPermit(input),
    scope_and_price: assessScope(input),
  };

  const dimensions = DIMENSION_ORDER.map((k) => toAssessment(k, drafts[k], byDim.get(k) ?? null));
  const applicable = dimensions.filter((d) => d.applicable);

  const counts: Record<UnknownStatus, number> = {
    known: 0, likely: 0, uncertain: 0, unknown: 0, contradictory: 0, unverified: 0,
  };
  for (const d of applicable) counts[d.status] += 1;

  const totalWeight = applicable.reduce((s, d) => s + d.weight, 0);
  const readinessPct =
    totalWeight > 0
      ? Math.round(applicable.reduce((s, d) => s + d.weight * d.confidencePct, 0) / totalWeight)
      : null;

  const resolveFirst = applicable
    .filter((d) => d.priority >= A.minPriority)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, A.maxResolveFirst);

  const open = applicable.filter((d) => d.state === 'open');
  const hardBlock =
    open.some((d) => d.status === 'contradictory') ||
    open.some((d) => d.status === 'unknown' && d.weight >= A.highWeight) ||
    (readinessPct !== null && readinessPct < A.resolveFirstReadinessBelow);
  const caution =
    open.some((d) => OPEN_STATUSES.has(d.status)) ||
    (readinessPct !== null && readinessPct < A.cautionReadinessBelow);

  const verdict: GateVerdict = readinessPct === null ? 'clear' : hardBlock ? 'resolve_first' : caution ? 'proceed_with_caution' : 'clear';

  const headline =
    verdict === 'clear'
      ? 'Every decision input is backed by confirmed evidence.'
      : verdict === 'resolve_first'
        ? `Before deciding, resolve ${resolveFirst.length || 'the'} unknown${resolveFirst.length === 1 ? '' : 's'} below.`
        : 'Mostly solid — a few inputs are still unconfirmed.';

  return { readinessPct, verdict, headline, dimensions, resolveFirst, counts };
}

/** Validation shared by the UI and tests; mirrors the migration's CHECK constraint. */
export function resolutionInputError(kind: ResolutionKind, text: string): string | null {
  const t = text.trim();
  if (kind === 'verified') return t.length >= 2 ? null : 'Say what you confirmed (at least 2 characters).';
  return t.length >= 10 ? null : 'Give a reason for accepting the risk (at least 10 characters).';
}
