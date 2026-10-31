import { describe, it, expect } from 'vitest';
import {
  AP_TRANSITIONS,
  DEFAULT_LADDER_DAYS,
  buildDemandLetterDraft,
  canTransitionAp,
  daysOverdue,
  decideLadderStep,
  demandLetterIsClean,
  evaluateInvoiceGate,
  overrideStillValid,
  recoveryKindFor,
  validateApTransition,
  validateLadder,
  type ApState,
  type GateInput,
  type LadderInvoice,
} from './logic';

const policy = { requirePo: false, requireCompletionProof: false };
const wo = (o: Partial<NonNullable<GateInput['workOrder']>> = {}): NonNullable<GateInput['workOrder']> => ({
  approvalStatus: 'approved',
  poNumber: 'PO-123',
  notToExceedCents: 100_000,
  otherInvoicedCents: 0,
  ...o,
});
const gate = (o: Partial<GateInput> = {}) =>
  evaluateInvoiceGate({ invoiceTotalCents: 50_000, policy, workOrder: wo(), hasCompletionProof: true, ...o });

describe('evaluateInvoiceGate — block rules', () => {
  it('passes a fully documented invoice', () => {
    const r = gate();
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.approvedCents).toBe(100_000);
    expect(r.committedCents).toBe(50_000);
  });

  it('is a no-op for an ordinary invoice with no work order and default policy', () => {
    const r = gate({ workOrder: null, hasCompletionProof: false });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('blocks amount above the not-to-exceed, counting other live invoices', () => {
    const r = gate({ invoiceTotalCents: 60_000, workOrder: wo({ otherInvoicedCents: 50_000 }) });
    expect(r.ok).toBe(false);
    expect(r.blocks.map((b) => b.code)).toEqual(['OVER_APPROVED_AMOUNT']);
    expect(r.committedCents).toBe(110_000);
  });

  it('allows billing exactly up to the not-to-exceed (boundary)', () => {
    expect(gate({ invoiceTotalCents: 50_000, workOrder: wo({ otherInvoicedCents: 50_000 }) }).ok).toBe(true);
    expect(gate({ invoiceTotalCents: 50_001, workOrder: wo({ otherInvoicedCents: 50_000 }) }).ok).toBe(false);
  });

  it('does not cap when there is no NTE', () => {
    const r = gate({ invoiceTotalCents: 9_999_999, workOrder: wo({ notToExceedCents: null }) });
    expect(r.ok).toBe(true);
    expect(r.committedCents).toBeNull();
  });

  it('blocks pending and rejected work orders, allows approved / not_required', () => {
    expect(gate({ workOrder: wo({ approvalStatus: 'pending' }) }).blocks[0].code).toBe('WO_NOT_APPROVED');
    expect(gate({ workOrder: wo({ approvalStatus: 'rejected' }) }).blocks[0].code).toBe('WO_NOT_APPROVED');
    expect(gate({ workOrder: wo({ approvalStatus: 'not_required' }) }).ok).toBe(true);
  });

  it('missing PO warns by default and blocks when the account requires it', () => {
    const w = gate({ workOrder: wo({ poNumber: '  ' }) });
    expect(w.ok).toBe(true);
    expect(w.warnings.map((x) => x.code)).toEqual(['MISSING_PO']);
    const b = gate({ workOrder: wo({ poNumber: null }), policy: { ...policy, requirePo: true } });
    expect(b.ok).toBe(false);
    expect(b.blocks[0].code).toBe('MISSING_PO');
  });

  it('requirePo blocks an invoice with no work order at all', () => {
    const r = gate({ workOrder: null, policy: { ...policy, requirePo: true } });
    expect(r.blocks.map((x) => x.code)).toEqual(['MISSING_PO']);
  });

  it('missing completion proof warns by default and blocks when required', () => {
    const w = gate({ hasCompletionProof: false });
    expect(w.ok).toBe(true);
    expect(w.warnings.map((x) => x.code)).toEqual(['MISSING_COMPLETION_PROOF']);
    const b = gate({ hasCompletionProof: false, policy: { ...policy, requireCompletionProof: true } });
    expect(b.ok).toBe(false);
  });

  it('reports every problem at once', () => {
    const r = gate({
      invoiceTotalCents: 200_000,
      workOrder: wo({ approvalStatus: 'pending', poNumber: null }),
      hasCompletionProof: false,
    });
    expect(r.findings.map((f) => f.code).sort()).toEqual(
      ['MISSING_COMPLETION_PROOF', 'MISSING_PO', 'OVER_APPROVED_AMOUNT', 'WO_NOT_APPROVED'],
    );
  });

  it('is deterministic integer math (no float drift)', () => {
    const r = gate({ invoiceTotalCents: 33_333, workOrder: wo({ notToExceedCents: 66_666, otherInvoicedCents: 33_333 }) });
    expect(r.ok).toBe(true);
    expect(r.committedCents).toBe(66_666);
  });
});

describe('overrideStillValid', () => {
  it('requires a reason and an unchanged total', () => {
    expect(overrideStillValid({ totalCents: 500, reason: 'Customer verbally approved' }, 500)).toBe(true);
    expect(overrideStillValid({ totalCents: 500, reason: 'ok' }, 501)).toBe(false);
    expect(overrideStillValid({ totalCents: 500, reason: '  ' }, 500)).toBe(false);
    expect(overrideStillValid(null, 500)).toBe(false);
  });
});

describe('AP state machine', () => {
  const states: ApState[] = ['sent', 'received', 'approved', 'rejected', 'paid'];

  it('allows the documented transitions only', () => {
    expect(canTransitionAp('sent', 'received')).toBe(true);
    expect(canTransitionAp('sent', 'approved')).toBe(true);
    expect(canTransitionAp('received', 'approved')).toBe(true);
    expect(canTransitionAp('approved', 'rejected')).toBe(true);
    expect(canTransitionAp('rejected', 'received')).toBe(true);
    expect(canTransitionAp('approved', 'sent')).toBe(false);
    expect(canTransitionAp('received', 'sent')).toBe(false);
  });

  it('paid is terminal and never manually reachable', () => {
    for (const s of states) {
      expect(canTransitionAp('paid', s)).toBe(false);
      expect(validateApTransition(s, 'paid', null).ok).toBe(false);
    }
    expect(AP_TRANSITIONS.paid).toEqual([]);
  });

  it('requires a non-blank reason to reject', () => {
    expect(validateApTransition('sent', 'rejected', '').ok).toBe(false);
    expect(validateApTransition('sent', 'rejected', '   ').ok).toBe(false);
    expect(validateApTransition('sent', 'rejected', null).ok).toBe(false);
    expect(validateApTransition('sent', 'rejected', 'PO number on invoice is wrong').ok).toBe(true);
  });

  it('rejects no-op transitions', () => {
    expect(validateApTransition('received', 'received', null).ok).toBe(false);
  });
});

describe('validateLadder', () => {
  it('accepts the default ladder', () => expect(validateLadder(DEFAULT_LADDER_DAYS).ok).toBe(true));
  it.each([
    [[]],
    [[0, 5]],
    [[5, 5]],
    [[7, 3]],
    [[1.5]],
    [[400]],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ])('rejects %j', (days) => expect(validateLadder(days as number[]).ok).toBe(false));
});

describe('daysOverdue', () => {
  it('counts whole calendar days, negative before due', () => {
    expect(daysOverdue('2026-10-01', '2026-10-01')).toBe(0);
    expect(daysOverdue('2026-10-01', '2026-10-04')).toBe(3);
    expect(daysOverdue('2026-10-10', '2026-10-01')).toBe(-9);
  });
  it('is DST-safe and handles month/year rollover', () => {
    expect(daysOverdue('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysOverdue('2026-12-30', '2027-01-02')).toBe(3);
  });
  it('returns null on malformed input instead of guessing', () => {
    expect(daysOverdue('garbage', '2026-10-01')).toBeNull();
    expect(daysOverdue('2026-10-01', '')).toBeNull();
  });
});

describe('decideLadderStep — timing', () => {
  const base: LadderInvoice = {
    dueDate: '2026-10-01',
    balanceCents: 50_000,
    invoiceStatus: 'sent',
    apState: 'sent',
    followupsApproved: true,
    followupsPaused: false,
    lastLadderStep: 0,
  };
  const ladder = [3, 7, 14, 30];

  it('does nothing before the first step', () => {
    expect(decideLadderStep(base, ladder, '2026-10-03')).toEqual({ send: false, reason: 'not_due_yet' });
  });
  it('fires step 1 exactly on day 3', () => {
    expect(decideLadderStep(base, ladder, '2026-10-04')).toMatchObject({ send: true, stepNumber: 1, daysOverdue: 3 });
  });
  it('does not re-send a step that was already claimed (idempotent)', () => {
    expect(decideLadderStep({ ...base, lastLadderStep: 1 }, ladder, '2026-10-04')).toEqual({ send: false, reason: 'already_sent' });
    expect(decideLadderStep({ ...base, lastLadderStep: 1 }, ladder, '2026-10-07')).toEqual({ send: false, reason: 'already_sent' });
  });
  it('fires the next step on its day', () => {
    expect(decideLadderStep({ ...base, lastLadderStep: 1 }, ladder, '2026-10-08')).toMatchObject({ send: true, stepNumber: 2 });
  });
  it('after downtime sends ONE email and jumps to the highest due step (no burst)', () => {
    const d = decideLadderStep(base, ladder, '2026-10-20');
    expect(d).toMatchObject({ send: true, stepNumber: 3 });
    expect(decideLadderStep({ ...base, lastLadderStep: 3 }, ladder, '2026-10-20')).toEqual({ send: false, reason: 'already_sent' });
  });
  it('stops after the last step', () => {
    expect(decideLadderStep({ ...base, lastLadderStep: 4 }, ladder, '2027-03-01')).toEqual({ send: false, reason: 'already_sent' });
  });
  it('honours a custom configurable ladder', () => {
    expect(decideLadderStep(base, [1], '2026-10-02')).toMatchObject({ send: true, stepNumber: 1 });
  });
});

describe('decideLadderStep — safety', () => {
  const base: LadderInvoice = {
    dueDate: '2026-10-01', balanceCents: 1, invoiceStatus: 'sent', apState: 'sent',
    followupsApproved: true, followupsPaused: false, lastLadderStep: 0,
  };
  const t = '2026-11-01';
  it.each([
    [{ followupsApproved: false }, 'followups_not_approved'],
    [{ followupsPaused: true }, 'paused'],
    [{ invoiceStatus: 'draft' as const }, 'invoice_not_open'],
    [{ invoiceStatus: 'paid' as const }, 'invoice_not_open'],
    [{ invoiceStatus: 'void' as const }, 'invoice_not_open'],
    [{ apState: 'rejected' as const }, 'rejected_needs_human'],
    [{ apState: 'paid' as const }, 'paid'],
    [{ balanceCents: 0 }, 'no_balance'],
    [{ dueDate: null }, 'missing_due_date'],
    [{ dueDate: 'not-a-date' }, 'malformed_date'],
  ])('skips %j -> %s', (patch, reason) => {
    expect(decideLadderStep({ ...base, ...patch }, [3], t)).toEqual({ send: false, reason });
  });
  it('skips on an invalid configured ladder rather than guessing', () => {
    expect(decideLadderStep(base, [7, 3], t)).toEqual({ send: false, reason: 'invalid_ladder' });
  });
});

describe('demand letter draft', () => {
  const facts = {
    businessName: 'Acme HVAC', customerName: 'Pat Doe', invoiceNumber: 'INV-0042', invoiceDate: 'Sep 1, 2026',
    dueDate: 'Sep 15, 2026', totalCents: 123_456, paidCents: 23_456, balanceCents: 100_000, daysOverdue: 30,
    poNumber: 'PO-77', workOrderNumber: 'WO-00003', payByDate: 'Nov 15, 2026',
  };
  it('uses only the supplied (DB-derived) numbers', () => {
    const t = buildDemandLetterDraft(facts);
    expect(t).toContain('$1,234.56');
    expect(t).toContain('$234.56');
    expect(t).toContain('$1,000.00');
    expect(t).toContain('PO PO-77');
    expect(t).toContain('30 days past due');
  });
  it('contains no legal advice, threats or collections language', () => {
    expect(demandLetterIsClean(buildDemandLetterDraft(facts))).toBe(true);
    expect(demandLetterIsClean(buildDemandLetterDraft({ ...facts, poNumber: null, workOrderNumber: null, payByDate: null, daysOverdue: 1 }))).toBe(true);
  });
  it('the cleanliness check actually catches forbidden wording', () => {
    expect(demandLetterIsClean('We will sue you')).toBe(false);
    expect(demandLetterIsClean('Our attorney will contact you')).toBe(false);
    expect(demandLetterIsClean('Late fee and interest apply')).toBe(false);
  });
  it('singularises one day', () => {
    expect(buildDemandLetterDraft({ ...facts, daysOverdue: 1 })).toContain('1 day past due');
  });
});

describe('recoveryKindFor', () => {
  it('rejected with a balance -> invoice_rejected, even if not yet due', () => {
    expect(recoveryKindFor('rejected', -5, 100)).toBe('invoice_rejected');
  });
  it('overdue with a balance -> invoice_overdue', () => {
    expect(recoveryKindFor('sent', 1, 100)).toBe('invoice_overdue');
    expect(recoveryKindFor('approved', 40, 100)).toBe('invoice_overdue');
  });
  it('not yet due, paid, or zero balance -> nothing', () => {
    expect(recoveryKindFor('sent', 0, 100)).toBeNull();
    expect(recoveryKindFor('sent', null, 100)).toBeNull();
    expect(recoveryKindFor('paid', 50, 0)).toBeNull();
    expect(recoveryKindFor('rejected', 50, 0)).toBeNull();
  });
});
