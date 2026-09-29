/**
 * Service Risk Intelligence — pure scoring engine.
 *
 * No I/O and no imports: everything here is deterministic and unit-tested
 * (riskIntelligence.test.ts). Data gathering lives in riskIntelligenceApi.ts.
 *
 * Five dimensions are scored 0–100 (higher = riskier) and mapped to
 * Low / Medium / High, then combined into an overall score and a coverage
 * decision that drives the workflow (clear → conditions → manager review →
 * refer to insurer → hold).
 */

export const RISK_ENGINE_VERSION = '1.0.0';

export type RiskLevel = 'low' | 'medium' | 'high';
export type RiskDimension = 'property' | 'technician' | 'liability' | 'parts' | 'warranty';
export type CoverageDecision = 'clear' | 'conditions' | 'manager_review' | 'refer_to_insurer' | 'hold';

export const RISK_DIMENSIONS: RiskDimension[] = ['property', 'technician', 'liability', 'parts', 'warranty'];

export const DIMENSION_LABELS: Record<RiskDimension, string> = {
  property: 'Property Risk',
  technician: 'Technician Risk',
  liability: 'Job Liability Risk',
  parts: 'Parts Risk',
  warranty: 'Warranty Risk',
};

export const LEVEL_LABELS: Record<RiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export const LEVEL_COLORS: Record<RiskLevel, string> = {
  low: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
};

export const DECISION_LABELS: Record<CoverageDecision, string> = {
  clear: 'Clear to proceed',
  conditions: 'Proceed with conditions',
  manager_review: 'Manager review required',
  refer_to_insurer: 'Refer to insurer',
  hold: 'Hold — do not dispatch',
};

export const DECISION_COLORS: Record<CoverageDecision, string> = {
  clear: 'bg-success-500/10 text-success-500',
  conditions: 'bg-accent/10 text-accent',
  manager_review: 'bg-warning-500/10 text-warning-500',
  refer_to_insurer: 'bg-danger/10 text-danger',
  hold: 'bg-danger/10 text-danger',
};

/** Decisions that need a named human to accept the risk before dispatch. */
export function decisionRequiresAck(decision: CoverageDecision): boolean {
  return decision === 'manager_review' || decision === 'refer_to_insurer' || decision === 'hold';
}

export const LEVEL_THRESHOLDS = { medium: 34, high: 67 } as const;

export function levelOf(score: number): RiskLevel {
  if (score >= LEVEL_THRESHOLDS.high) return 'high';
  if (score >= LEVEL_THRESHOLDS.medium) return 'medium';
  return 'low';
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

// ============================================================
// POLICY
// ============================================================

export interface RiskPolicy {
  /** Max liability the business is comfortable carrying on one job. null = not set. */
  liabilityLimitCents: number | null;
  /** Jobs at or above this value are treated as high-value. */
  highValueJobCents: number;
  /** Extra service types (substring match, case-insensitive) treated as high hazard. */
  highRiskServiceTypes: string[];
  /** When true the database blocks dispatch of flagged jobs until acknowledged. */
  requireAckForHighRisk: boolean;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  liabilityLimitCents: null,
  highValueJobCents: 1_000_000,
  highRiskServiceTypes: [],
  requireAckForHighRisk: false,
};

const HIGH_HAZARD_KEYWORDS = [
  'gas',
  'electrical panel',
  'panel upgrade',
  'rewire',
  'roof',
  'structural',
  'asbestos',
  'mold',
  'fire',
  'boiler',
  'generator',
  'high voltage',
  'refrigerant',
  'sewer',
];

const MEDIUM_HAZARD_KEYWORDS = [
  'electrical',
  'plumb',
  'hvac',
  'furnace',
  'water heater',
  'install',
  'replace',
  'leak',
  'drain',
  'heat pump',
  'compressor',
];

/** 0 = routine, 1 = elevated, 2 = high hazard. */
export function hazardTierFor(serviceType: string | null, policy: RiskPolicy): 0 | 1 | 2 {
  const s = (serviceType ?? '').trim().toLowerCase();
  if (!s) return 0;
  const custom = policy.highRiskServiceTypes.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (custom.some((t) => s.includes(t))) return 2;
  if (HIGH_HAZARD_KEYWORDS.some((k) => s.includes(k))) return 2;
  if (MEDIUM_HAZARD_KEYWORDS.some((k) => s.includes(k))) return 1;
  return 0;
}

export function isAfterHours(scheduledIso: string | null): boolean {
  if (!scheduledIso) return false;
  const d = new Date(scheduledIso);
  if (Number.isNaN(d.getTime())) return false;
  const h = d.getHours();
  return h < 6 || h >= 21;
}

// ============================================================
// INPUTS
// ============================================================

export interface EquipmentRisk {
  ageYears: number | null;
  lifespanYears: number;
}

export interface PropertyInputs {
  hasAddress: boolean;
  commercial: boolean;
  equipment: EquipmentRisk[];
  /** Insurance claims on this address in the last 36 months (excluding this job's own). */
  priorClaims36m: number;
  /** A claim on this job or address is still open. */
  openClaim: boolean;
  /** Earlier rework jobs for the same customer. */
  customerReworkCount: number;
}

export interface TechnicianInputs {
  assigned: boolean;
  /** Labels of blocking credentials the technician does not validly hold. */
  blockingGaps: string[];
  /** Labels of advisory (non-blocking) credentials missing. */
  advisoryGaps: string[];
  /** Required credentials that are valid but expire soon. */
  expiringSoon: { label: string; days: number }[];
  /** Callback/rework share of recent outcomes, null when there is too little data. */
  reworkRatePct: number | null;
  outcomesCount: number;
  /** Completed jobs of this service type by this technician (last 12 months); null if unknown. */
  completedSameService: number | null;
}

export interface LiabilityInputs {
  hazardTier: 0 | 1 | 2;
  valueCents: number | null;
  afterHours: boolean;
  commercial: boolean;
  hasSla: boolean;
}

export interface PartsInputs {
  total: number;
  backordered: number;
  needed: number;
  hoursUntilStart: number | null;
}

export interface WarrantyInputs {
  /** Linked equipment that carries a warranty date at all. */
  warrantyEquipmentCount: number;
  activeWarrantyCount: number;
  expiredWarrantyCount: number;
  soonestExpiryDays: number | null;
  docs: {
    serialOnFile: boolean;
    installDateOnFile: boolean;
    diagnosisNotes: boolean;
    beforePhotos: number;
    evidenceVerdict: 'pass' | 'needs_attention' | 'fail' | null;
  };
  claim: { deadlineDays: number | null } | null;
}

export interface RiskInputs {
  policy: RiskPolicy;
  property: PropertyInputs;
  technician: TechnicianInputs;
  liability: LiabilityInputs;
  parts: PartsInputs;
  warranty: WarrantyInputs;
  /** Data sources that failed to load; lowers data coverage. */
  unavailableSources: string[];
}

// ============================================================
// OUTPUT
// ============================================================

export interface RiskFlag {
  code: string;
  dimension: RiskDimension;
  severity: RiskLevel;
  title: string;
  detail: string;
  action: string;
}

export interface DimensionRisk {
  dimension: RiskDimension;
  score: number;
  level: RiskLevel;
  /** false when the dimension does not apply to this job (e.g. no parts). */
  applicable: boolean;
  /** false when the inputs needed to judge it are missing. */
  known: boolean;
  flags: RiskFlag[];
}

export interface CoverageResult {
  decision: CoverageDecision;
  reasons: string[];
  requiredActions: string[];
  requiresAck: boolean;
}

export interface RiskReport {
  engineVersion: string;
  overallScore: number;
  overallLevel: RiskLevel;
  dimensions: Record<RiskDimension, DimensionRisk>;
  flags: RiskFlag[];
  coverage: CoverageResult;
  /** 0–1: share of dimensions judged from real data. */
  dataCoverage: number;
  dataGaps: string[];
  /** Stable fingerprint used to avoid recording identical snapshots twice. */
  signature: string;
}

// ============================================================
// DIMENSION SCORERS
// ============================================================

function flagFactory(dimension: RiskDimension, into: RiskFlag[]) {
  return (code: string, severity: RiskLevel, title: string, detail: string, action: string): void => {
    into.push({ code, dimension, severity, title, detail, action });
  };
}

function finish(dimension: RiskDimension, score: number, flags: RiskFlag[], known = true, applicable = true): DimensionRisk {
  const s = clamp(score);
  return { dimension, score: s, level: levelOf(s), applicable, known, flags };
}

function scoreProperty(p: PropertyInputs): DimensionRisk {
  let score = 10;
  const flags: RiskFlag[] = [];
  const flag = flagFactory('property', flags);

  const pastLife = p.equipment.filter((e) => e.ageYears !== null && e.lifespanYears > 0 && e.ageYears >= e.lifespanYears);
  const nearing = p.equipment.filter(
    (e) => e.ageYears !== null && e.lifespanYears > 0 && e.ageYears < e.lifespanYears && e.ageYears >= e.lifespanYears * 0.8,
  );
  if (pastLife.length > 0) {
    score += Math.min(36, 18 * pastLife.length);
    flag(
      'equipment_past_service_life',
      pastLife.length >= 2 ? 'high' : 'medium',
      'Equipment past expected service life',
      `${pastLife.length} linked unit${pastLife.length === 1 ? ' is' : 's are'} older than expected lifespan; failure and secondary-damage risk is elevated.`,
      'Document pre-existing condition with photos and note it on the estimate.',
    );
  }
  if (nearing.length > 0) {
    score += Math.min(16, 8 * nearing.length);
  }

  if (p.priorClaims36m > 0) {
    score += Math.min(40, 20 * p.priorClaims36m);
    flag(
      'prior_claims_on_property',
      p.priorClaims36m >= 2 ? 'high' : 'medium',
      'Prior insurance claims at this property',
      `${p.priorClaims36m} claim${p.priorClaims36m === 1 ? '' : 's'} on this address in the last 36 months.`,
      'Confirm prior loss was fully remediated and photograph existing damage before starting.',
    );
  }

  if (p.openClaim) {
    score += 10;
    flag(
      'open_claim_on_property',
      'medium',
      'Open insurance claim on this property',
      'A claim tied to this job or address is still in progress.',
      'Coordinate with the adjuster before work starts and keep every change documented.',
    );
  }

  if (p.customerReworkCount > 0) {
    score += Math.min(20, 10 * p.customerReworkCount);
    flag(
      'customer_rework_history',
      'medium',
      'Rework history with this customer',
      `${p.customerReworkCount} earlier job${p.customerReworkCount === 1 ? '' : 's'} for this customer needed rework.`,
      'Review the earlier jobs and send a senior technician if the cause is unresolved.',
    );
  }

  if (p.commercial) score += 5;

  if (!p.hasAddress) {
    score += 10;
    flag(
      'property_address_missing',
      'low',
      'Property address missing',
      'Property history cannot be checked without an address.',
      'Add the service address to the job.',
    );
  }

  return finish('property', score, flags, p.hasAddress);
}

function scoreTechnician(t: TechnicianInputs): DimensionRisk {
  const flags: RiskFlag[] = [];
  const flag = flagFactory('technician', flags);

  if (!t.assigned) {
    flag(
      'technician_unassigned',
      'medium',
      'No technician assigned yet',
      'Technician risk cannot be finalised until someone is assigned.',
      'Assign a technician, then re-check credentials and experience.',
    );
    return finish('technician', 40, flags, false);
  }

  let score = 10;

  for (const label of t.blockingGaps) {
    flag(
      'technician_missing_certification',
      'high',
      `Technician lacks required credential: ${label}`,
      'This credential is mandatory for this service type and is missing, revoked or expired.',
      'Assign a technician who holds a valid credential, or renew it before dispatch.',
    );
  }

  if (t.advisoryGaps.length > 0) {
    score += Math.min(30, 15 * t.advisoryGaps.length);
    flag(
      'technician_missing_advisory_credential',
      'medium',
      'Recommended credential missing',
      `Not held: ${t.advisoryGaps.join(', ')}.`,
      'Consider a better-qualified technician or record why this is acceptable.',
    );
  }

  const expiring = t.expiringSoon.filter((e) => e.days >= 0);
  if (expiring.length > 0) {
    score += Math.min(20, 10 * expiring.length);
    const soonest = Math.min(...expiring.map((e) => e.days));
    flag(
      'technician_credential_expiring',
      soonest <= 14 ? 'medium' : 'low',
      'Required credential expires soon',
      `${expiring.map((e) => `${e.label} (${e.days}d)`).join(', ')}.`,
      'Start renewal now so the job is not blocked later.',
    );
  }

  if (t.reworkRatePct !== null && t.outcomesCount >= 5) {
    if (t.reworkRatePct >= 25) {
      score += 40;
      flag(
        'technician_high_rework',
        'high',
        'High recent callback/rework rate',
        `${Math.round(t.reworkRatePct)}% of the last ${t.outcomesCount} outcomes needed a callback or rework.`,
        'Pair with a senior technician or require a supervisor check before closing.',
      );
    } else if (t.reworkRatePct >= 15) {
      score += 30;
      flag(
        'technician_elevated_rework',
        'medium',
        'Elevated callback/rework rate',
        `${Math.round(t.reworkRatePct)}% of the last ${t.outcomesCount} outcomes needed a callback or rework.`,
        'Add a photo checklist and review quality before closing.',
      );
    } else if (t.reworkRatePct >= 8) {
      score += 15;
    }
  }

  if (t.completedSameService !== null) {
    if (t.completedSameService === 0) {
      score += 20;
      flag(
        'technician_no_history_for_service',
        'medium',
        'No completed jobs of this type',
        'The technician has not completed this service type in the last 12 months.',
        'Provide a mission brief or remote expert assist for this job.',
      );
    } else if (t.completedSameService < 3) {
      score += 10;
    }
  }

  if (t.blockingGaps.length > 0) score = Math.max(score, 90);

  return finish('technician', score, flags);
}

function scoreLiability(l: LiabilityInputs, policy: RiskPolicy): DimensionRisk {
  let score = 10;
  const flags: RiskFlag[] = [];
  const flag = flagFactory('liability', flags);

  if (l.hazardTier === 2) {
    score += 40;
    flag(
      'high_hazard_work',
      'high',
      'High-hazard service type',
      'This work carries elevated injury or property-damage exposure.',
      'Confirm coverage, require safety photos and a signed completion record.',
    );
  } else if (l.hazardTier === 1) {
    score += 15;
  }

  if (l.valueCents !== null) {
    if (policy.liabilityLimitCents !== null && l.valueCents > policy.liabilityLimitCents) {
      score += 35;
      flag(
        'liability_exceeds_limit',
        'high',
        'Job value exceeds your liability limit',
        'The invoice value is above the maximum you set for a single job.',
        'Refer to your insurer or get written approval before dispatch.',
      );
    } else if (l.valueCents >= policy.highValueJobCents) {
      score += 20;
      flag(
        'high_value_job',
        'medium',
        'High-value job',
        'The invoice value is at or above your high-value threshold.',
        'Have a manager review scope and terms before work starts.',
      );
    }
  }

  if (l.commercial) score += 10;
  if (l.hasSla) score += 5;
  if (l.afterHours && l.hazardTier >= 1) {
    score += 5;
    flag(
      'after_hours_hazard',
      'low',
      'Elevated-hazard work outside normal hours',
      'Scheduled late evening or early morning.',
      'Confirm the technician has backup and a check-in plan.',
    );
  }

  return finish('liability', score, flags, l.valueCents !== null);
}

function scoreParts(p: PartsInputs): DimensionRisk {
  if (p.total <= 0) return finish('parts', 5, [], true, false);

  const flags: RiskFlag[] = [];
  const flag = flagFactory('parts', flags);
  const backShare = p.backordered / p.total;
  const neededShare = p.needed / p.total;
  let score = 10 + 65 * backShare + 20 * neededShare;

  if (p.backordered > 0) {
    flag(
      'parts_backordered',
      backShare >= 0.5 ? 'high' : 'medium',
      'Required parts are backordered',
      `${p.backordered} of ${p.total} required part${p.total === 1 ? '' : 's'} backordered.`,
      'Reschedule, source an alternative, or tell the customer before dispatch.',
    );
  }
  if (p.needed > 0 && p.hoursUntilStart !== null && p.hoursUntilStart <= 48) {
    score += 10;
    flag(
      'parts_not_allocated',
      'medium',
      'Parts not allocated and job starts soon',
      `${p.needed} required part${p.needed === 1 ? '' : 's'} still unallocated with the job within 48 hours.`,
      'Allocate stock or order the parts now.',
    );
  }

  return finish('parts', score, flags);
}

function scoreWarranty(w: WarrantyInputs): DimensionRisk {
  const applicable = w.warrantyEquipmentCount > 0 || w.claim !== null;
  if (!applicable) return finish('warranty', 5, [], true, false);

  let score = 10;
  const flags: RiskFlag[] = [];
  const flag = flagFactory('warranty', flags);

  const outOfWarranty = w.activeWarrantyCount === 0 && w.claim === null;
  if (outOfWarranty) {
    score += 25;
    flag(
      'warranty_expired',
      'medium',
      'Linked equipment is out of warranty',
      `${w.expiredWarrantyCount} linked unit${w.expiredWarrantyCount === 1 ? ' has' : 's have'} an expired warranty.`,
      'Do not promise manufacturer coverage; quote as a paid repair.',
    );
    return finish('warranty', score, flags);
  }

  const d = w.docs;
  const missing: string[] = [];
  if (!d.serialOnFile) missing.push('equipment serial number');
  if (!d.installDateOnFile) missing.push('install date / proof of purchase');
  if (!d.diagnosisNotes) missing.push("technician's diagnosis notes");
  if (d.beforePhotos < 1) missing.push('photo of the failed part / pre-work condition');
  if (d.evidenceVerdict === 'fail') missing.push('acceptable photo evidence (last evidence check failed)');

  score = 15 + missing.length * 14;
  if (missing.length > 0) {
    flag(
      'warranty_documentation_incomplete',
      missing.length >= 3 ? 'high' : 'medium',
      'Documentation is insufficient for a warranty claim',
      `Missing: ${missing.join('; ')}.`,
      'Capture the missing items before closing the job — an incomplete packet gets rejected.',
    );
  }

  if (w.soonestExpiryDays !== null && w.soonestExpiryDays >= 0 && w.soonestExpiryDays <= 30) {
    score += 10;
    flag(
      'warranty_expiring_soon',
      'low',
      'Warranty expires within 30 days',
      `Soonest expiry in ${w.soonestExpiryDays} day${w.soonestExpiryDays === 1 ? '' : 's'}.`,
      'File any claim before the warranty lapses.',
    );
  }

  if (w.claim && w.claim.deadlineDays !== null) {
    if (w.claim.deadlineDays < 0) {
      score += 35;
      flag(
        'warranty_claim_deadline_passed',
        'high',
        'Warranty claim deadline has passed',
        `Deadline passed ${Math.abs(w.claim.deadlineDays)} day${Math.abs(w.claim.deadlineDays) === 1 ? '' : 's'} ago.`,
        'Contact the manufacturer immediately to ask for an exception.',
      );
    } else if (w.claim.deadlineDays <= 14) {
      score += 15;
      flag(
        'warranty_claim_deadline_near',
        'medium',
        'Warranty claim deadline is close',
        `Deadline in ${w.claim.deadlineDays} day${w.claim.deadlineDays === 1 ? '' : 's'}.`,
        'Submit the claim packet now.',
      );
    }
  }

  return finish('warranty', score, flags);
}

// ============================================================
// COVERAGE DECISION
// ============================================================

const DECISION_RANK: Record<CoverageDecision, number> = {
  clear: 0,
  conditions: 1,
  manager_review: 2,
  refer_to_insurer: 3,
  hold: 4,
};

function decideCoverage(
  dims: Record<RiskDimension, DimensionRisk>,
  overallLevel: RiskLevel,
  flags: RiskFlag[],
  inputs: RiskInputs,
): CoverageResult {
  let decision: CoverageDecision = 'clear';
  const reasons: string[] = [];
  const raise = (d: CoverageDecision, reason: string) => {
    if (DECISION_RANK[d] > DECISION_RANK[decision]) decision = d;
    reasons.push(reason);
  };

  if (inputs.technician.assigned && inputs.technician.blockingGaps.length > 0) {
    raise('hold', `Assigned technician lacks required credential(s): ${inputs.technician.blockingGaps.join(', ')}.`);
  }

  const exceeds = flags.some((f) => f.code === 'liability_exceeds_limit');
  const highValueHighRisk =
    dims.liability.level === 'high' &&
    inputs.liability.valueCents !== null &&
    inputs.liability.valueCents >= inputs.policy.highValueJobCents;
  if (exceeds) {
    raise('refer_to_insurer', 'Job value is above your per-job liability limit.');
  } else if (highValueHighRisk) {
    raise('refer_to_insurer', 'High-value job with high liability exposure.');
  }

  const highDims = RISK_DIMENSIONS.filter((d) => dims[d].level === 'high');
  if (overallLevel === 'high' || highDims.length >= 2) {
    raise('manager_review', 'Overall risk is high; a manager should review before dispatch.');
  }

  if (DECISION_RANK[decision] < DECISION_RANK.conditions) {
    if (flags.some((f) => f.severity !== 'low') || overallLevel === 'medium') {
      raise('conditions', 'Risks were found that should be addressed as part of the job.');
    }
  }

  const requiredActions: string[] = [];
  for (const f of flags) {
    if (f.severity === 'low') continue;
    if (!requiredActions.includes(f.action)) requiredActions.push(f.action);
    if (requiredActions.length >= 6) break;
  }

  return { decision, reasons, requiredActions, requiresAck: decisionRequiresAck(decision) };
}

// ============================================================
// PUBLIC API
// ============================================================

const WEIGHTS: Record<RiskDimension, number> = {
  liability: 0.3,
  technician: 0.25,
  property: 0.2,
  warranty: 0.15,
  parts: 0.1,
};

export function computeJobRisk(inputs: RiskInputs): RiskReport {
  const dimensions: Record<RiskDimension, DimensionRisk> = {
    property: scoreProperty(inputs.property),
    technician: scoreTechnician(inputs.technician),
    liability: scoreLiability(inputs.liability, inputs.policy),
    parts: scoreParts(inputs.parts),
    warranty: scoreWarranty(inputs.warranty),
  };

  const list = RISK_DIMENSIONS.map((d) => dimensions[d]);
  const weightedAvg = list.reduce((sum, d) => sum + d.score * WEIGHTS[d.dimension], 0);
  const max = Math.max(...list.map((d) => d.score));
  // A single severe dimension must not be diluted by four healthy ones.
  const overallScore = clamp(0.6 * max + 0.4 * weightedAvg);
  const overallLevel = levelOf(overallScore);

  const flags = list
    .flatMap((d) => d.flags)
    .sort(
      (a, b) =>
        LEVEL_RANK[b.severity] - LEVEL_RANK[a.severity] ||
        RISK_DIMENSIONS.indexOf(a.dimension) - RISK_DIMENSIONS.indexOf(b.dimension),
    );

  const coverage = decideCoverage(dimensions, overallLevel, flags, inputs);

  const dataGaps: string[] = [];
  if (!inputs.technician.assigned) dataGaps.push('Technician not assigned');
  if (inputs.liability.valueCents === null) dataGaps.push('Job value not set');
  if (!inputs.property.hasAddress) dataGaps.push('Service address missing');
  for (const s of inputs.unavailableSources) dataGaps.push(`Data source unavailable: ${s}`);

  const knownShare = list.filter((d) => d.known).length / list.length;
  const dataCoverage = Math.max(0, Math.min(1, knownShare * (1 - 0.1 * inputs.unavailableSources.length)));

  const signature = [
    overallScore,
    coverage.decision,
    flags
      .map((f) => f.code)
      .sort()
      .join(','),
  ].join('|');

  return {
    engineVersion: RISK_ENGINE_VERSION,
    overallScore,
    overallLevel,
    dimensions,
    flags,
    coverage,
    dataCoverage: Math.round(dataCoverage * 1000) / 1000,
    dataGaps,
    signature,
  };
}
