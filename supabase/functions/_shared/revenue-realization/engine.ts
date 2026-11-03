// supabase/functions/_shared/revenue-realization/engine.ts
//
// Revenue Realization — pure engine (no Deno / network / DOM / clock reads; callers pass `now`).
// Shared by the edge functions, the dashboard page and the tests, so the number on screen is the
// number the digest and the CSV export carry.
//
// It EXTENDS the existing recovery ledger (revenue_recovery_events, written by estimate-recovery-agent
// and DB triggers): ledger rows are adapted into leaks here, never re-detected. Only moments the
// ledger does not cover have their own detector below.
//
// Money is integer cents. Nothing here invents a number: every amount comes from a source record and
// every probability comes from the account's own outcomes (shrunk toward a documented design prior
// while the sample is small). Priors are design parameters, NOT industry statistics.

export const FORMULA_VERSION = "rr-v1";

export const FORMULA = {
  version: FORMULA_VERSION,
  // Human-readable, rendered in-product (i18n copy lives in the locale files; this is the source of truth).
  expression: "realization % = captured / (captured + Σ(leak amount × leak confidence))",
  bounds: {
    low: "captured / (captured + Σ leak amount)  — every leak counts in full",
    high: "captured / (captured + Σ leak amount for leaks with confidence ≥ 0.7)  — only high-confidence leaks count",
  },
} as const;

export const HIGH_CONFIDENCE = 0.7;
/** Prior strength: how many observed outcomes it takes to outweigh the design prior. */
export const SHRINK_K = 10;
export const PRIOR_PRECISION = 0.8;
const DAY = 86_400_000;

// ------------------------------------------------------------------ types

export const DETECTORS = [
  "missed_call", "stale_quote", "declined_risk_rec", "unquoted_finding", "uninvoiced_work",
  "unbilled_trip_fee", "discount_over_policy", "warranty_unfiled", "agreement_expiring",
  "overdue_invoice", "no_show_gap", "membership_lapse", "underpriced_job",
] as const;
export type DetectorId = (typeof DETECTORS)[number];

/** Which detectors have a verified data loader in revenue-realization-run. The UI shows the rest as "not connected". */
export const DETECTOR_WIRED: Record<DetectorId, boolean> = {
  missed_call: true, stale_quote: true, declined_risk_rec: true, unquoted_finding: false, uninvoiced_work: true,
  unbilled_trip_fee: false, discount_over_policy: true, warranty_unfiled: true, agreement_expiring: true,
  overdue_invoice: true, no_show_gap: true /* cancellations only; true no-shows not wired */, membership_lapse: true,
  underpriced_job: true,
};

export type FixKind = "draft_followup" | "create_quote" | "invoice_correction" | "file_warranty_claim";
export type LeakStatus = "open" | "in_progress" | "realized" | "dismissed" | "false_positive" | "expired";

export interface Evidence { table: string; id: string; label: string }

export interface LeakCandidate {
  detector: DetectorId;
  /** One row per (detector, source record) — the DB unique key. */
  dedupeKey: string;
  /** Leaks sharing a pool describe the SAME dollars; only the largest weighted one counts in the formula. */
  poolKey: string;
  amountCents: number;
  confidence: number; // 0..1
  lowSample: boolean;
  evidence: Evidence[]; // never empty
  ownerId: string | null; // team_members.id responsible for follow-up
  technicianId: string | null;
  source: string | null; // lead source / channel when known
  occurredAt: string; // ISO
  whyKey: string; // i18n key under revenueRealization:why.*
  whyParams: Record<string, string | number>;
  fix: FixKind | null; // null = preventive only (money already gone; fix the policy)
  customerName: string | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const cents = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));
const ts = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** Bayesian shrink toward a prior: (successes + prior·k) / (trials + k). Always in [0,1]. */
export function shrink(successes: number, trials: number, prior: number, k = SHRINK_K): number {
  const s = Math.max(0, successes), t = Math.max(s, trials);
  return clamp((s + prior * k) / (t + k), 0, 1);
}

function make(
  c: Omit<LeakCandidate, "dedupeKey" | "poolKey" | "lowSample" | "source" | "technicianId" | "customerName"> &
    Partial<Pick<LeakCandidate, "poolKey" | "lowSample" | "source" | "technicianId" | "customerName">>,
  key: string,
): LeakCandidate | null {
  const amountCents = cents(c.amountCents);
  if (amountCents <= 0 || c.evidence.length === 0) return null; // no money or no evidence → not a leak
  return {
    ...c, amountCents, confidence: clamp(c.confidence, 0.02, 0.99),
    dedupeKey: `${c.detector}:${key}`, poolKey: c.poolKey ?? `${c.detector}:${key}`,
    lowSample: c.lowSample ?? false, source: c.source ?? null, technicianId: c.technicianId ?? null,
    customerName: c.customerName ?? null,
  };
}

// ------------------------------------------------------------------ ledger adapter (existing detectors)

export interface LedgerFact {
  id: string; sourceType: string; sourceTable: string; sourceId: string;
  estimatedValueCents: number; status: string; occurredAt: string;
  assignedTo: string | null; customerName: string | null;
  recoveredAmountCents: number | null; recoveredJobId: string | null;
}

interface LedgerRule { detector: DetectorId; prior: number; fix: FixKind; why: string }
export const LEDGER_RULES: Record<string, LedgerRule> = {
  missed_call: { detector: "missed_call", prior: 0.3, fix: "draft_followup", why: "missed_call" },
  voicemail: { detector: "missed_call", prior: 0.35, fix: "draft_followup", why: "missed_call" },
  not_booked: { detector: "missed_call", prior: 0.3, fix: "draft_followup", why: "missed_call" },
  declined_quote: { detector: "stale_quote", prior: 0.2, fix: "draft_followup", why: "stale_quote" },
  expired_quote: { detector: "stale_quote", prior: 0.3, fix: "draft_followup", why: "stale_quote" },
  quote_financing_stalled: { detector: "stale_quote", prior: 0.35, fix: "draft_followup", why: "stale_quote" },
  quote_accepted_unbooked: { detector: "stale_quote", prior: 0.6, fix: "draft_followup", why: "accepted_unbooked" },
  cancelled_job: { detector: "no_show_gap", prior: 0.3, fix: "draft_followup", why: "cancelled_job" },
  job_completed_unbilled: { detector: "uninvoiced_work", prior: 0.7, fix: "invoice_correction", why: "unbilled_job" },
  job_parts_unbilled: { detector: "uninvoiced_work", prior: 0.7, fix: "invoice_correction", why: "parts_unbilled" },
  invoice_overdue: { detector: "overdue_invoice", prior: 0.6, fix: "draft_followup", why: "overdue_invoice" },
  payment_failed: { detector: "overdue_invoice", prior: 0.6, fix: "draft_followup", why: "payment_failed" },
  membership_cancelled: { detector: "membership_lapse", prior: 0.3, fix: "draft_followup", why: "membership_lapse" },
  membership_churned: { detector: "membership_lapse", prior: 0.3, fix: "draft_followup", why: "membership_lapse" },
};

export type LedgerOutcomes = Record<string, { recovered: number; writtenOff: number }>;

/** Own-data outcome counts per ledger source_type (recovered vs written_off). */
export function ledgerOutcomes(rows: Pick<LedgerFact, "sourceType" | "status">[]): LedgerOutcomes {
  const out: LedgerOutcomes = {};
  for (const r of rows) {
    if (r.status !== "recovered" && r.status !== "written_off") continue;
    const o = (out[r.sourceType] ??= { recovered: 0, writtenOff: 0 });
    if (r.status === "recovered") o.recovered++; else o.writtenOff++;
  }
  return out;
}

export function adaptLedger(rows: LedgerFact[], outcomes: LedgerOutcomes): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const r of rows) {
    const rule = LEDGER_RULES[r.sourceType];
    if (!rule || (r.status !== "open" && r.status !== "contacted")) continue; // recovered/written_off are not open leaks
    const o = outcomes[r.sourceType] ?? { recovered: 0, writtenOff: 0 };
    const trials = o.recovered + o.writtenOff;
    const c = make({
      detector: rule.detector, amountCents: r.estimatedValueCents,
      confidence: shrink(o.recovered, trials, rule.prior), lowSample: trials < SHRINK_K,
      evidence: [{ table: r.sourceTable, id: r.sourceId, label: r.sourceType }, { table: "revenue_recovery_events", id: r.id, label: "ledger" }],
      ownerId: r.assignedTo, occurredAt: r.occurredAt, whyKey: rule.why,
      whyParams: { recovered: o.recovered, trials }, fix: rule.fix, customerName: r.customerName,
      poolKey: `${r.sourceTable}:${r.sourceId}`,
    }, `${r.sourceTable}:${r.sourceId}`);
    if (c) out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------ new detectors

export interface DeclinedRecFact {
  itemId: string; packageId: string; jobId: string | null; severity: "urgent" | "recommended" | "monitor";
  decidedAt: string; optionTotalCents: number; equipmentAgeYears: number | null; endOfLifeYears: number | null;
  customerName: string | null; ownerId: string | null; laterQuoteOrJob: boolean;
}
export function detectDeclinedRisk(facts: DeclinedRecFact[], now: number): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const f of facts) {
    const age = ts(f.decidedAt);
    if (f.laterQuoteOrJob || !Number.isFinite(age) || now - age > 365 * DAY || now - age < DAY) continue;
    const safety = f.severity === "urgent";
    const aged = f.equipmentAgeYears !== null && f.endOfLifeYears !== null && f.equipmentAgeYears >= f.endOfLifeYears;
    if (!safety && !aged) continue;
    const c = make({
      detector: "declined_risk_rec", amountCents: f.optionTotalCents,
      confidence: safety && aged ? 0.65 : safety ? 0.55 : 0.4,
      evidence: [{ table: "findings_package_items", id: f.itemId, label: "declined" }, ...(f.jobId ? [{ table: "jobs", id: f.jobId, label: "job" }] : [])],
      ownerId: f.ownerId, occurredAt: f.decidedAt, whyKey: safety ? (aged ? "declined_safety_age" : "declined_safety") : "declined_age",
      whyParams: { age: f.equipmentAgeYears ?? 0 }, fix: "create_quote", customerName: f.customerName,
    }, f.itemId);
    if (c) out.push(c);
  }
  return out;
}

export interface UnquotedFindingFact {
  id: string; jobId: string; source: "note" | "photo"; severity: "info" | "low" | "medium" | "high" | "emergency";
  valueCents: number; visionConfidence: number | null; verifyRequired: boolean; observedAt: string;
  quoted: boolean; ownerId: string | null; customerName: string | null;
}
export function detectUnquotedFindings(facts: UnquotedFindingFact[], now: number): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const f of facts) {
    const age = ts(f.observedAt);
    if (f.quoted || !["medium", "high", "emergency"].includes(f.severity) || !Number.isFinite(age) || now - age < DAY || now - age > 90 * DAY) continue;
    const base = f.source === "photo" ? (f.visionConfidence ?? 0.4) * 0.8 : 0.45;
    const c = make({
      detector: "unquoted_finding", amountCents: f.valueCents, confidence: f.verifyRequired ? base * 0.7 : base,
      evidence: [{ table: "jobs", id: f.jobId, label: f.source }, { table: "property_findings", id: f.id, label: "finding" }],
      ownerId: f.ownerId, occurredAt: f.observedAt, whyKey: "unquoted_finding", whyParams: { source: f.source },
      fix: "create_quote", customerName: f.customerName,
    }, f.id);
    if (c) out.push(c);
  }
  return out;
}

export interface TripFeeFact {
  jobId: string; completedAt: string; policyCents: number; billedCents: number; waived: boolean;
  technicianId: string | null; customerName: string | null;
}
export function detectUnbilledTripFees(facts: TripFeeFact[]): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const f of facts) {
    if (f.waived || f.policyCents <= 0 || f.billedCents >= f.policyCents) continue;
    const c = make({
      detector: "unbilled_trip_fee", amountCents: f.policyCents - f.billedCents, confidence: 0.7,
      evidence: [{ table: "jobs", id: f.jobId, label: "job" }], ownerId: f.technicianId, technicianId: f.technicianId,
      occurredAt: f.completedAt, whyKey: "unbilled_trip_fee", whyParams: { policy: f.policyCents, billed: f.billedCents },
      fix: "invoice_correction", customerName: f.customerName,
    }, f.jobId);
    if (c) out.push(c);
  }
  return out;
}

export interface DiscountFact {
  checkId: string; quoteId: string; quoteStatus: string; revenueCents: number; costCents: number;
  floorPct: number; overrideReason: string | null; ownerId: string | null; occurredAt: string; customerName: string | null;
}
/** Revenue needed to hit the margin floor: cost / (1 − floor). */
export function floorRevenueCents(costCents: number, floorPct: number): number {
  return Math.ceil(costCents / (1 - clamp(floorPct, 0, 95) / 100));
}
export function detectDiscountOverPolicy(facts: DiscountFact[]): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const f of facts) {
    if (f.quoteStatus !== "accepted") continue;
    const gap = floorRevenueCents(f.costCents, f.floorPct) - f.revenueCents;
    const c = make({
      detector: "discount_over_policy", amountCents: gap, confidence: f.overrideReason?.trim() ? 0.6 : 0.9,
      evidence: [{ table: "margin_guardrail_checks", id: f.checkId, label: "override" }, { table: "quotes", id: f.quoteId, label: "quote" }],
      ownerId: f.ownerId, occurredAt: f.occurredAt, whyKey: "discount_over_policy", whyParams: { floor: f.floorPct },
      fix: null, customerName: f.customerName,
    }, f.checkId);
    if (c) out.push(c);
  }
  return out;
}

export interface WarrantyFact {
  id: string; jobId: string | null; status: string; claimedCents: number | null; partCostCents: number; laborCostCents: number;
  claimDeadline: string | null; occurredAt: string; customerName: string | null;
}
export function detectWarrantyUnfiled(facts: WarrantyFact[], now: number): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const f of facts) {
    if (f.status !== "eligible" && f.status !== "packet_pending") continue;
    const dl = ts(f.claimDeadline);
    if (Number.isFinite(dl) && dl + DAY <= now) continue; // window closed — not recoverable any more
    const days = Number.isFinite(dl) ? Math.ceil((dl + DAY - now) / DAY) : null;
    const c = make({
      detector: "warranty_unfiled", amountCents: f.claimedCents ?? f.partCostCents + f.laborCostCents, confidence: 0.75,
      evidence: [{ table: "warranty_claims", id: f.id, label: "claim" }, ...(f.jobId ? [{ table: "jobs", id: f.jobId, label: "job" }] : [])],
      ownerId: null, occurredAt: f.occurredAt, whyKey: days === null ? "warranty_unfiled" : "warranty_unfiled_deadline",
      whyParams: { days: days ?? 0 }, fix: "file_warranty_claim", customerName: f.customerName,
    }, f.id);
    if (c) out.push(c);
  }
  return out;
}

export interface AgreementFact {
  id: string; title: string; customerName: string | null; status: string; endDate: string | null;
  annualValueCents: number; successorExists: boolean; ownerId: string | null;
}
export function detectAgreementsExpiring(facts: AgreementFact[], now: number, windowDays = 45): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const f of facts) {
    const end = ts(f.endDate);
    if (f.status !== "active" || f.successorExists || !Number.isFinite(end) || end + DAY < now || end - now > windowDays * DAY) continue;
    const days = Math.max(0, Math.ceil((end - now) / DAY));
    const c = make({
      detector: "agreement_expiring", amountCents: f.annualValueCents, confidence: days <= 14 ? 0.55 : 0.45,
      evidence: [{ table: "recurring_agreements", id: f.id, label: f.title }], ownerId: f.ownerId,
      occurredAt: f.endDate as string, whyKey: "agreement_expiring", whyParams: { days }, fix: "draft_followup", customerName: f.customerName,
    }, f.id);
    if (c) out.push(c);
  }
  return out;
}

export interface UnderpricedFact {
  jobId: string; service: string; invoicedCents: number; bookCents: number; match: "exact" | "keyword";
  technicianId: string | null; occurredAt: string; customerName: string | null;
}
export const UNDERPRICED_TOLERANCE = 0.85;
export function detectUnderpriced(facts: UnderpricedFact[]): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const f of facts) {
    if (f.invoicedCents <= 0 || f.bookCents <= 0 || f.invoicedCents >= f.bookCents * UNDERPRICED_TOLERANCE) continue;
    const c = make({
      detector: "underpriced_job", amountCents: f.bookCents - f.invoicedCents, confidence: f.match === "exact" ? 0.5 : 0.25,
      evidence: [{ table: "jobs", id: f.jobId, label: f.service }], ownerId: f.technicianId, technicianId: f.technicianId,
      occurredAt: f.occurredAt, whyKey: "underpriced_job", whyParams: { book: f.bookCents, invoiced: f.invoicedCents },
      fix: null, customerName: f.customerName,
    }, f.jobId);
    if (c) out.push(c);
  }
  return out;
}

export interface NoShowFact {
  jobId: string; scheduledAt: string; valueCents: number; rebooked: boolean; ownerId: string | null; customerName: string | null;
}
export function detectNoShowGaps(facts: NoShowFact[], now: number): LeakCandidate[] {
  const out: LeakCandidate[] = [];
  for (const f of facts) {
    const at = ts(f.scheduledAt);
    if (f.rebooked || !Number.isFinite(at) || now - at < 2 * DAY || now - at > 60 * DAY) continue;
    const c = make({
      detector: "no_show_gap", amountCents: f.valueCents, confidence: 0.3,
      evidence: [{ table: "jobs", id: f.jobId, label: "no_show" }], ownerId: f.ownerId, occurredAt: f.scheduledAt,
      whyKey: "no_show_gap", whyParams: {}, fix: "draft_followup", customerName: f.customerName,
    }, f.jobId);
    if (c) out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------ calibration (false-positive feedback loop)

export type FeedbackStats = Partial<Record<DetectorId, { truePositive: number; falsePositive: number }>>;

export function detectorPrecision(stats: FeedbackStats, detector: DetectorId): number {
  const s = stats[detector];
  return shrink(s?.truePositive ?? 0, (s?.truePositive ?? 0) + (s?.falsePositive ?? 0), PRIOR_PRECISION);
}

/** Scale confidence by observed precision relative to the prior. No feedback → unchanged. */
export function calibrate(cands: LeakCandidate[], stats: FeedbackStats): LeakCandidate[] {
  return cands.map((c) => ({ ...c, confidence: clamp((c.confidence * detectorPrecision(stats, c.detector)) / PRIOR_PRECISION, 0.02, 0.99) }));
}

// ------------------------------------------------------------------ formula

export interface ScoredLeak { poolKey: string; detector: DetectorId; amountCents: number; confidence: number; status: LeakStatus }

export interface Realization {
  formulaVersion: string;
  capturedCents: number;
  leakedWeightedCents: number; leakedFullCents: number; leakedHighConfidenceCents: number;
  /** null when captured + leaked is 0 (nothing to measure). Percent with one decimal. */
  pct: number | null; pctLow: number | null; pctHigh: number | null;
  leakCount: number;
  byDetector: Partial<Record<DetectorId, { count: number; weightedCents: number; fullCents: number }>>;
}

const pctOf = (captured: number, leaked: number): number | null => {
  const d = captured + leaked;
  return d > 0 ? Math.round((captured / d) * 1000) / 10 : null;
};

/** Only open / in_progress leaks are "identifiable leaked revenue". Same-pool leaks count once (the largest weighted). */
export function computeRealization(capturedCents: number, leaks: ScoredLeak[]): Realization {
  const best = new Map<string, ScoredLeak>();
  for (const l of leaks) {
    if (l.status !== "open" && l.status !== "in_progress") continue;
    const prev = best.get(l.poolKey);
    if (!prev || l.amountCents * l.confidence > prev.amountCents * prev.confidence) best.set(l.poolKey, l);
  }
  let weighted = 0, full = 0, high = 0;
  const byDetector: Realization["byDetector"] = {};
  for (const l of best.values()) {
    const w = Math.round(l.amountCents * l.confidence);
    weighted += w; full += l.amountCents; if (l.confidence >= HIGH_CONFIDENCE) high += l.amountCents;
    const d = (byDetector[l.detector] ??= { count: 0, weightedCents: 0, fullCents: 0 });
    d.count++; d.weightedCents += w; d.fullCents += l.amountCents;
  }
  const captured = cents(capturedCents);
  return {
    formulaVersion: FORMULA_VERSION, capturedCents: captured, leakedWeightedCents: weighted, leakedFullCents: full,
    leakedHighConfidenceCents: high, pct: pctOf(captured, weighted), pctLow: pctOf(captured, full), pctHigh: pctOf(captured, high),
    leakCount: best.size, byDetector,
  };
}

/** Pool dedupe applied to candidates before persisting, so the stored list and the formula agree. */
export function dedupeCandidates(cands: LeakCandidate[]): LeakCandidate[] {
  const byKey = new Map<string, LeakCandidate>();
  for (const c of cands) if (!byKey.has(c.dedupeKey)) byKey.set(c.dedupeKey, c);
  return [...byKey.values()].sort((a, b) => b.amountCents * b.confidence - a.amountCents * a.confidence || a.dedupeKey.localeCompare(b.dedupeKey));
}

// ------------------------------------------------------------------ estimated vs realized

export interface RealizedProof { kind: "invoice_paid" | "quote_accepted" | "ledger_recovered" | "warranty_credit"; table: string; id: string; amountCents: number; at: string }

/** A recovery is REALIZED only on a confirmed payment or booking. Draft/sent/approved never qualify. */
export function realizedAmount(proof: RealizedProof | null): number {
  if (!proof) return 0;
  const okKinds: RealizedProof["kind"][] = ["invoice_paid", "quote_accepted", "ledger_recovered", "warranty_credit"];
  return okKinds.includes(proof.kind) && proof.amountCents > 0 ? Math.round(proof.amountCents) : 0;
}

export interface Split { estimatedOpenCents: number; realizedCents: number }
export function splitEstimatedRealized(leaks: { status: LeakStatus; amountCents: number; confidence: number; realizedAmountCents: number | null }[]): Split {
  let estimatedOpenCents = 0, realizedCents = 0;
  for (const l of leaks) {
    if (l.status === "open" || l.status === "in_progress") estimatedOpenCents += Math.round(l.amountCents * l.confidence);
    else if (l.status === "realized") realizedCents += l.realizedAmountCents ?? 0;
  }
  return { estimatedOpenCents, realizedCents };
}

// ------------------------------------------------------------------ breakdowns, digest, export

export interface ReportLeak {
  id: string; detector: DetectorId; amountCents: number; confidence: number; status: LeakStatus;
  ownerId: string | null; technicianId: string | null; source: string | null; occurredAt: string; customerName: string | null;
}
export const weighted = (l: Pick<ReportLeak, "amountCents" | "confidence">) => Math.round(l.amountCents * l.confidence);

export function breakdown(leaks: ReportLeak[], key: "technicianId" | "source" | "detector"): { key: string; count: number; weightedCents: number; fullCents: number }[] {
  const m = new Map<string, { key: string; count: number; weightedCents: number; fullCents: number }>();
  for (const l of leaks) {
    if (l.status !== "open" && l.status !== "in_progress") continue;
    const k = (l[key] as string | null) ?? "unassigned";
    const e = m.get(k) ?? { key: k, count: 0, weightedCents: 0, fullCents: 0 };
    e.count++; e.weightedCents += weighted(l); e.fullCents += l.amountCents; m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.weightedCents - a.weightedCents || a.key.localeCompare(b.key));
}

export interface Digest { topLeaks: ReportLeak[]; newCount: number; weightedCents: number; deltaPctPoints: number | null }
export function buildDigest(leaks: ReportLeak[], sinceIso: string, current: Realization, previous: Realization | null, top = 5): Digest {
  const open = leaks.filter((l) => l.status === "open" || l.status === "in_progress");
  const since = ts(sinceIso);
  return {
    topLeaks: [...open].sort((a, b) => weighted(b) - weighted(a) || a.id.localeCompare(b.id)).slice(0, top),
    newCount: open.filter((l) => ts(l.occurredAt) >= since).length,
    weightedCents: current.leakedWeightedCents,
    deltaPctPoints: current.pct !== null && previous?.pct != null ? Math.round((current.pct - previous.pct) * 10) / 10 : null,
  };
}

/** CSV with spreadsheet-formula injection guard (=,+,-,@,tab,CR prefixes are neutralised). */
export function csvCell(v: string | number | null): string {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(leaks: ReportLeak[]): string {
  const head = ["id", "detector", "status", "amount_cents", "confidence", "weighted_cents", "owner", "technician", "source", "customer", "occurred_at"];
  const rows = leaks.map((l) => [l.id, l.detector, l.status, l.amountCents, l.confidence, weighted(l), l.ownerId, l.technicianId, l.source, l.customerName, l.occurredAt].map(csvCell).join(","));
  return [head.join(","), ...rows].join("\n");
}

// ------------------------------------------------------------------ backtest

export const BACKTEST_TARGETS = { precision: 0.7, recall: 0.6 } as const;

/** Precision / recall of a detector's flagged dedupe keys against human-labelled ground truth. */
export function scoreBacktest(flagged: string[], truth: string[]): { precision: number | null; recall: number | null; tp: number; fp: number; fn: number } {
  const f = new Set(flagged), t = new Set(truth);
  let tp = 0; for (const k of f) if (t.has(k)) tp++;
  const fp = f.size - tp, fn = t.size - tp;
  return { precision: f.size ? tp / f.size : null, recall: t.size ? tp / t.size : null, tp, fp, fn };
}
export const meetsTargets = (s: { precision: number | null; recall: number | null }) =>
  s.precision !== null && s.recall !== null && s.precision >= BACKTEST_TARGETS.precision && s.recall >= BACKTEST_TARGETS.recall;

/** Draft message text (never sent by the system — a human reviews and sends it). Strings are i18n keys + params. */
export function followupDraft(c: Pick<LeakCandidate, "detector" | "customerName">): { key: string; params: { name: string } } {
  return { key: `draft.${c.detector}`, params: { name: c.customerName?.trim() || "" } };
}
