// Invoice-outcome statements (Task E): state machine, immutable snapshot, idempotency and content hash. PURE.
import type { AttributionDecision, BaselineComparison, ExclusionReason, FeeResult } from './invoiceAttribution.ts';

export const OUTCOME_SNAPSHOT_VERSION = 1;

// ============================================================
// STATE MACHINE  (draft -> approved -> invoiced -> paid | disputed)
// ============================================================

export type StatementState = 'draft' | 'approved' | 'invoiced' | 'paid' | 'disputed' | 'void';

export const STATEMENT_STATES: readonly StatementState[] = ['draft', 'approved', 'invoiced', 'paid', 'disputed', 'void'];

/** Single source of truth. The database trigger in the migration mirrors this table exactly. */
export const STATEMENT_TRANSITIONS: Readonly<Record<StatementState, readonly StatementState[]>> = {
  draft: ['approved', 'void'],
  approved: ['invoiced', 'void'],
  invoiced: ['paid', 'disputed'],
  disputed: ['invoiced', 'void'],
  paid: [],
  void: [],
};

export type TransitionError =
  | 'illegal_transition'
  | 'approver_required'
  | 'self_approval_not_allowed'
  | 'dispute_window_open'
  | 'stripe_record_required'
  | 'feature_disabled';

export interface TransitionContext {
  featureEnabled: boolean;
  /** Staff user id performing the change; null for system. */
  actorId: string | null;
  /** The user who generated the draft (system or staff). Approver must differ when set. */
  generatedBy: string | null;
  approvedAt: string | null;
  now: string;
  disputeWindowDays: number;
  hasStripeTestRecord: boolean;
}

export type TransitionResult = { ok: true; to: StatementState } | { ok: false; error: TransitionError };

export const isFrozen = (s: StatementState): boolean => s !== 'draft';

export function transition(from: StatementState, to: StatementState, c: TransitionContext): TransitionResult {
  if (!STATEMENT_TRANSITIONS[from].includes(to)) return { ok: false, error: 'illegal_transition' };
  if (!c.featureEnabled && to !== 'void') return { ok: false, error: 'feature_disabled' };
  if (to === 'approved') {
    if (!c.actorId) return { ok: false, error: 'approver_required' };
    if (c.generatedBy !== null && c.generatedBy === c.actorId) return { ok: false, error: 'self_approval_not_allowed' };
  }
  if (to === 'invoiced' && from === 'approved') {
    const approved = c.approvedAt ? Date.parse(c.approvedAt) : NaN;
    const now = Date.parse(c.now);
    if (!Number.isFinite(approved) || !Number.isFinite(now) || now < approved + c.disputeWindowDays * 86_400_000) {
      return { ok: false, error: 'dispute_window_open' };
    }
    if (!c.hasStripeTestRecord) return { ok: false, error: 'stripe_record_required' };
  }
  return { ok: true, to };
}

// ============================================================
// SNAPSHOT
// ============================================================

export interface SnapshotLine {
  invoiceId: string;
  invoiceLabel: string;
  recoveredCents: number;
  feeCents: number;
  feeFree: boolean;
  /** true = contested; excluded from billing until the dispute is resolved. */
  held: boolean;
  evidence: {
    actionId: string | null;
    actionAt: string | null;
    paymentIds: string[];
    confirmationBasis: 'human' | 'evidence_chain' | null;
    ruleVersion: string;
  };
}

export interface OutcomeSnapshot {
  version: typeof OUTCOME_SNAPSHOT_VERSION;
  userId: string;
  period: string; // YYYY-MM
  currency: string;
  generatedAt: string;
  ruleVersion: string;
  termsVersion: number | null;
  model: string | null;
  lines: SnapshotLine[];
  excludedByReason: Partial<Record<ExclusionReason, number>>;
  baseFeeCents: number;
  outcomeFeeCents: number;
  adjustmentCents: number;
  totalCents: number;
  zeroReason: string | null;
  baseline: BaselineComparison | null;
  /** Fixed plain-language disclaimer key so the PDF and the app always show the same text. */
  disclaimerKey: 'outcome.disclaimer.v1';
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isPeriod = (p: string): boolean => PERIOD_RE.test(p);

export function buildSnapshot(input: {
  userId: string;
  period: string;
  currency: string;
  generatedAt: string;
  ruleVersion: string;
  termsVersion: number | null;
  model: string | null;
  decisions: readonly AttributionDecision[];
  invoiceLabels: Readonly<Record<string, string>>;
  contestedInvoiceIds: ReadonlySet<string>;
  fee: FeeResult;
  baseline: BaselineComparison | null;
}): OutcomeSnapshot {
  if (!isPeriod(input.period)) throw new Error('invalid_period');
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('invalid_currency');

  const feeByInvoice = new Map(input.fee.lines.map((l) => [l.invoiceId, l] as const));
  const lines: SnapshotLine[] = input.decisions
    .filter((d) => d.qualifies)
    .map((d) => {
      const f = feeByInvoice.get(d.invoiceId);
      const held = input.contestedInvoiceIds.has(d.invoiceId);
      return {
        invoiceId: d.invoiceId,
        invoiceLabel: input.invoiceLabels[d.invoiceId] ?? d.invoiceId,
        recoveredCents: d.recoveredCents,
        feeCents: held ? 0 : (f?.feeCents ?? 0),
        feeFree: f?.feeFree ?? false,
        held,
        evidence: {
          actionId: d.primaryActionId,
          actionAt: d.primaryActionAt,
          paymentIds: [...d.paymentIds],
          confirmationBasis: d.confirmationBasis,
          ruleVersion: d.ruleVersion,
        },
      };
    });

  const excluded: Partial<Record<ExclusionReason, number>> = {};
  for (const d of input.decisions) {
    if (d.qualifies) continue;
    for (const r of d.reasons) excluded[r] = (excluded[r] ?? 0) + 1;
  }

  return {
    version: OUTCOME_SNAPSHOT_VERSION,
    userId: input.userId,
    period: input.period,
    currency: input.currency,
    generatedAt: input.generatedAt,
    ruleVersion: input.ruleVersion,
    termsVersion: input.termsVersion,
    model: input.model,
    lines,
    excludedByReason: excluded,
    baseFeeCents: input.fee.baseFeeCents,
    outcomeFeeCents: input.fee.outcomeFeeCents,
    adjustmentCents: input.fee.adjustmentCents,
    totalCents: input.fee.totalCents,
    zeroReason: input.fee.zeroReason,
    baseline: input.baseline,
    disclaimerKey: 'outcome.disclaimer.v1',
  };
}

/** Every priced line must be explained: sum(lines.fee) + adjustment == outcome fee. Returns problems (empty = OK). */
export function snapshotIntegrity(s: OutcomeSnapshot): string[] {
  const problems: string[] = [];
  const lineSum = s.lines.reduce((a, l) => a + l.feeCents, 0);
  if (s.model === 'recovered_pct' && lineSum + s.adjustmentCents !== s.outcomeFeeCents) {
    problems.push('lines_plus_adjustment_mismatch');
  }
  if (s.baseFeeCents + s.outcomeFeeCents !== s.totalCents) problems.push('total_mismatch');
  if (s.lines.some((l) => !l.evidence.actionId || l.evidence.paymentIds.length === 0)) problems.push('line_without_evidence');
  if (new Set(s.lines.map((l) => l.invoiceId)).size !== s.lines.length) problems.push('duplicate_invoice_line');
  return problems;
}

export function isSnapshot(v: unknown): v is OutcomeSnapshot {
  const s = v as OutcomeSnapshot | null;
  return !!s && s.version === OUTCOME_SNAPSHOT_VERSION && isPeriod(s.period) && /^[A-Z]{3}$/.test(s.currency)
    && Array.isArray(s.lines) && typeof s.totalCents === 'number' && s.disclaimerKey === 'outcome.disclaimer.v1';
}

// ============================================================
// IDEMPOTENCY & HASH
// ============================================================

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** One statement per account per period, regardless of how often generation runs. */
export const statementIdempotencyKey = (userId: string, period: string): string => `ivo:${userId}:${period}`;

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const snapshotHash = (s: OutcomeSnapshot): Promise<string> => sha256Hex(canonicalJson(s));

/** Cents actually billable now: held (contested) lines are excluded; base fee stays unless suspended upstream. */
export function billableTotalCents(s: OutcomeSnapshot, activeDisputedInvoiceIds: ReadonlySet<string>): number {
  const heldFees = s.lines.reduce((a, l) => (l.held || activeDisputedInvoiceIds.has(l.invoiceId) ? a + l.feeCents : a), 0);
  return Math.max(s.baseFeeCents, s.totalCents - heldFees);
}
