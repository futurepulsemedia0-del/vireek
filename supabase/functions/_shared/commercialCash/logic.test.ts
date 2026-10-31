import { describe, expect, it } from 'vitest';
import {
  buildDemandDraft, canTransition, DEMAND_DISCLAIMER, followupKey, manualStageOptions, nextLadderAction, daysBetween,
} from './logic';

const base = { anchor: '2026-01-01', ladderDays: [30, 45, 60], demandDraftAfterDays: 60, doneReminders: [] as number[], draftDone: false };
const at = (today: string, over: Partial<typeof base> = {}) => nextLadderAction({ ...base, today, ...over });

describe('daysBetween', () => {
  it('counts whole UTC calendar days regardless of time of day', () => {
    expect(daysBetween('2026-01-01T23:59:00Z', '2026-01-31T00:01:00Z')).toBe(30);
    expect(daysBetween('2026-01-31', '2026-01-01')).toBe(-30);
  });
});

describe('ladder timing', () => {
  it('does nothing before the first step or without an anchor', () => {
    expect(at('2026-01-30')).toEqual({ action: 'none' });
    expect(nextLadderAction({ ...base, anchor: null, today: '2026-06-01' })).toEqual({ action: 'none' });
  });
  it('sends the 30-day reminder exactly on day 30 and not again once done', () => {
    expect(at('2026-01-31')).toEqual({ action: 'reminder', stepDay: 30, skipped: [] });
    expect(at('2026-02-05', { doneReminders: [30] })).toEqual({ action: 'none' });
  });
  it('sends the 45-day reminder next', () => {
    expect(at('2026-02-15', { doneReminders: [30] })).toEqual({ action: 'reminder', stepDay: 45, skipped: [] });
  });
  it('after downtime, sends only the latest reached step and reports earlier ones as skipped', () => {
    expect(at('2026-02-20')).toEqual({ action: 'reminder', stepDay: 45, skipped: [30] });
  });
  it('queues a demand DRAFT (never a reminder) from day 60', () => {
    expect(at('2026-03-02')).toEqual({ action: 'demand_draft', stepDay: 60, skipped: [30, 45] });
    expect(at('2026-03-02', { doneReminders: [30, 45] })).toEqual({ action: 'demand_draft', stepDay: 60, skipped: [] });
  });
  it('queues the draft only once', () => {
    expect(at('2026-06-01', { draftDone: true })).toEqual({ action: 'none' });
  });
  it('honours custom ladders and ignores steps at/after the demand threshold', () => {
    expect(at('2026-01-16', { ladderDays: [14, 28], demandDraftAfterDays: 90 })).toEqual({ action: 'reminder', stepDay: 14, skipped: [] });
    expect(at('2026-01-21', { ladderDays: [10, 20], demandDraftAfterDays: 20 })).toEqual({ action: 'demand_draft', stepDay: 20, skipped: [10] });
  });
  it('is stable across repeated runs on the same day (idempotent decision)', () => {
    expect(at('2026-01-31')).toEqual(at('2026-01-31T18:00:00Z'));
  });
});

describe('invoice state machine', () => {
  it('allows the documented path and blocks shortcuts', () => {
    expect(canTransition('draft', 'sent')).toBe(true);
    expect(canTransition('sent', 'received')).toBe(true);
    expect(canTransition('received', 'approved')).toBe(true);
    expect(canTransition('approved', 'paid')).toBe(true);
    expect(canTransition('rejected', 'sent')).toBe(true);
    expect(canTransition('blocked_needs_approval', 'paid')).toBe(false);
    expect(canTransition('paid', 'sent')).toBe(false);
    expect(canTransition('void', 'sent')).toBe(false);
  });
  it('offers only human-settable stages', () => {
    expect(manualStageOptions('sent')).toEqual(['received', 'approved', 'rejected']);
    expect(manualStageOptions('paid')).toEqual([]);
  });
});

describe('demand draft', () => {
  const draft = buildDemandDraft({
    businessName: 'Cool Air', customerName: 'Acme Property', invoiceNumber: 'INV-0042', balanceFormatted: '$1,200.00',
    dueDate: 'Jan 31, 2026', sentDate: 'Jan 1, 2026', daysOutstanding: 61, poReference: 'PO-9981', remindersSent: 2,
  });
  it('is always labelled draft / review required and never claims legal rights', () => {
    expect(draft.disclaimer).toBe(DEMAND_DISCLAIMER);
    expect(draft.disclaimer).toMatch(/REVIEW REQUIRED/);
    expect(draft.disclaimer).toMatch(/not legal advice/i);
    expect(draft.body).not.toMatch(/lien|lawsuit|attorney|legal action|court|sue/i);
  });
  it('states the facts it was given', () => {
    expect(draft.body).toContain('INV-0042');
    expect(draft.body).toContain('$1,200.00');
    expect(draft.body).toContain('PO-9981');
    expect(draft.body).toContain('61 days');
    expect(draft.body).toContain('2 earlier reminders');
  });
});

describe('followupKey', () => {
  it('is deterministic per invoice/kind/step', () => {
    expect(followupKey('i1', 'reminder', 30)).toBe('i1:reminder:30');
    expect(followupKey('i1', 'reminder', 30)).not.toBe(followupKey('i1', 'reminder', 45));
  });
});
