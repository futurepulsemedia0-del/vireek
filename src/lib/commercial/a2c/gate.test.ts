import { describe, expect, it } from 'vitest';
import { evaluateGate, DEFAULT_RULE, type GateApproval, type GateFacts, type GateRule } from './gate';
import { GATE_CODES, type GateCode, type GateMode } from './types';

const NOW = '2027-03-01T12:00:00Z';
const fullRule: GateRule = {
  ...DEFAULT_RULE, requiresPo: true, poFormatRegex: '^PO-[0-9]{4}$', requiresWorkOrderNumber: true, requiresNteApproval: true,
  requiresCompletionPhotos: true, requiresSignature: true, requiresServiceReport: true, invoiceDueWindowDays: 30,
  requiredAttachments: ['po_copy', 'approval_proof', 'other'],
};
const okApproval: GateApproval = {
  poNumber: 'PO-1234', workOrderNumber: 'WO-9', approvedAmountCents: 100_000, expiresAt: '2027-12-31T00:00:00Z',
  hasEvidence: true, changeOrderPending: false,
};
const okFacts: GateFacts = {
  invoiceTotalCents: 40_000, previouslyBilledCents: 0, hasAfterPhoto: true, hasSignature: true, completedAt: '2027-02-20T00:00:00Z',
  documents: ['service_report', 'po_copy', 'approval_proof', 'other'], now: NOW, overrideTotalCents: null,
};

interface Scenario { code: GateCode; warnOnly: boolean; rule?: Partial<GateRule>; approval?: Partial<GateApproval> | null; facts?: Partial<GateFacts> }
const scenarios: Scenario[] = [
  { code: 'missing_po', warnOnly: false, approval: { poNumber: null } },
  { code: 'po_format_mismatch', warnOnly: false, approval: { poNumber: 'ABC' } },
  { code: 'missing_work_order', warnOnly: false, approval: { workOrderNumber: null } },
  { code: 'missing_nte_approval', warnOnly: false, rule: { requiresPo: false, poFormatRegex: null, requiresWorkOrderNumber: false, requiredAttachments: [] }, approval: null },
  { code: 'approval_expired', warnOnly: false, approval: { expiresAt: '2027-02-01T00:00:00Z' } },
  { code: 'over_approved_amount', warnOnly: false, facts: { invoiceTotalCents: 100_001 } },
  { code: 'nte_near_limit', warnOnly: true, facts: { invoiceTotalCents: 80_000 } },
  { code: 'missing_completion_photos', warnOnly: false, facts: { hasAfterPhoto: false } },
  { code: 'missing_signature', warnOnly: false, facts: { hasSignature: false } },
  { code: 'missing_service_report', warnOnly: false, facts: { documents: ['po_copy', 'approval_proof', 'other'] } },
  { code: 'missing_documents', warnOnly: false, facts: { documents: ['service_report', 'approval_proof', 'other'] } },
  { code: 'late_submission', warnOnly: true, facts: { completedAt: '2027-01-01T00:00:00Z' } },
];

const run = (s: Scenario, mode: GateMode) => {
  const rule: GateRule = { ...fullRule, ...(s.rule ?? {}), gateMode: mode };
  const approval = s.approval === null ? null : { ...okApproval, ...(s.approval ?? {}) };
  return evaluateGate(rule, approval, { ...okFacts, ...(s.facts ?? {}) });
};

describe('gate: compliant baseline', () => {
  it('passes with no reasons in every mode', () => {
    for (const mode of ['block', 'warn', 'off'] as const) {
      const r = evaluateGate({ ...fullRule, gateMode: mode }, okApproval, okFacts);
      expect(r.result, mode).toBe('pass');
      expect(r.blocked).toBe(false);
      expect(r.reasons).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });
});

describe('gate: every rule x block / warn / off', () => {
  it('covers every gate code', () => {
    expect(scenarios.map((s) => s.code).sort()).toEqual([...GATE_CODES].sort());
  });
  for (const s of scenarios) {
    it(`${s.code} — block mode`, () => {
      const r = run(s, 'block');
      if (s.warnOnly) {
        expect(r.blocked).toBe(false);
        expect(r.result).toBe('warn');
        expect(r.warnings.map((w) => w.code)).toContain(s.code);
      } else {
        expect(r.blocked).toBe(true);
        expect(r.result).toBe('blocked_needs_approval');
        expect(r.reasons.map((x) => x.code)).toContain(s.code);
      }
    });
    it(`${s.code} — warn mode never blocks and reports it`, () => {
      const r = run(s, 'warn');
      expect(r.blocked).toBe(false);
      expect(r.result).toBe('warn');
      expect(r.reasons).toEqual([]);
      expect(r.warnings.map((w) => w.code)).toContain(s.code);
    });
    it(`${s.code} — off mode ignores it`, () => {
      const r = run(s, 'off');
      expect(r).toMatchObject({ result: 'pass', blocked: false, reasons: [], warnings: [] });
    });
  }
});

describe('gate: details', () => {
  it('NTE is cumulative over previously billed amounts', () => {
    const r = evaluateGate({ ...fullRule }, okApproval, { ...okFacts, invoiceTotalCents: 30_000, previouslyBilledCents: 75_000 });
    const item = r.reasons.find((x) => x.code === 'over_approved_amount');
    expect(item?.detail).toMatchObject({ excessCents: 5_000, previouslyBilledCents: 75_000 });
  });
  it('exactly at the approved amount is allowed; one cent over is not', () => {
    expect(evaluateGate(fullRule, okApproval, { ...okFacts, invoiceTotalCents: 100_000 }).blocked).toBe(false);
    expect(evaluateGate(fullRule, okApproval, { ...okFacts, invoiceTotalCents: 100_001 }).blocked).toBe(true);
  });
  it('warn threshold is inclusive and configurable', () => {
    const at = evaluateGate({ ...fullRule, nteWarnPct: 50 }, okApproval, { ...okFacts, invoiceTotalCents: 50_000 });
    expect(at.warnings.map((w) => w.code)).toContain('nte_near_limit');
    const below = evaluateGate({ ...fullRule, nteWarnPct: 50 }, okApproval, { ...okFacts, invoiceTotalCents: 49_999 });
    expect(below.warnings.map((w) => w.code)).not.toContain('nte_near_limit');
  });
  it('blockPct tolerance moves the hard limit', () => {
    const r = evaluateGate({ ...fullRule, nteBlockPct: 110 }, okApproval, { ...okFacts, invoiceTotalCents: 110_000 });
    expect(r.blocked).toBe(false);
  });
  it('reports a pending change order on the over-amount reason', () => {
    const r = evaluateGate(fullRule, { ...okApproval, changeOrderPending: true }, { ...okFacts, invoiceTotalCents: 150_000 });
    expect(r.reasons.find((x) => x.code === 'over_approved_amount')?.detail).toMatchObject({ changeOrderPending: true });
  });
  it('an unusable regex is ignored, never throws', () => {
    const r = evaluateGate({ ...fullRule, poFormatRegex: '(a+)+$' }, { ...okApproval, poNumber: 'zzz' }, okFacts);
    expect(r.reasons.map((x) => x.code)).not.toContain('po_format_mismatch');
  });
  it('does not double-report a document already covered by a dedicated flag', () => {
    const r = evaluateGate({ ...fullRule, requiredAttachments: ['service_report', 'signature', 'completion_photos'] }, okApproval,
      { ...okFacts, documents: [], hasSignature: false, hasAfterPhoto: false });
    expect(r.reasons.map((x) => x.code)).not.toContain('missing_documents');
  });
  it('approval_proof is satisfied by recorded approval evidence', () => {
    const r = evaluateGate({ ...fullRule, requiredAttachments: ['approval_proof'] }, okApproval, { ...okFacts, documents: ['service_report'] });
    expect(r.reasons.map((x) => x.code)).not.toContain('missing_documents');
  });
});

describe('gate: authorised override', () => {
  const bad: GateFacts = { ...okFacts, hasAfterPhoto: false, invoiceTotalCents: 40_000 };
  it('unblocks only while the total has not grown past what the owner accepted', () => {
    expect(evaluateGate(fullRule, okApproval, { ...bad, overrideTotalCents: 40_000 })).toMatchObject({ blocked: false, overridden: true });
    expect(evaluateGate(fullRule, okApproval, { ...bad, invoiceTotalCents: 40_001, overrideTotalCents: 40_000 })).toMatchObject({ blocked: true, overridden: false });
  });
  it('an overridden invoice still reports the reasons as warnings', () => {
    const r = evaluateGate(fullRule, okApproval, { ...bad, overrideTotalCents: 99_999 });
    expect(r.result).toBe('warn');
    expect(r.warnings.map((w) => w.code)).toContain('missing_completion_photos');
  });
});
