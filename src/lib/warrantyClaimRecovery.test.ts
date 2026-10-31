// @vitest-environment node
// Reliability tests for the warranty-recovery claim logic (src/lib/warrantyClaimRecovery.ts) and its contract with the
// check-warranty-claim-deadlines edge function. "KNOWN GAP" tests pin CURRENT behaviour that is a weakness.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_STATUS_LABELS, CLAIM_STATUS_OPTIONS, EMPTY_CHECKLIST, PACKET_ITEM_LABELS, daysUntil, formatCents, isDeadlineAtRisk, isOpenClaim, packetProgress,
  type ClaimStatus,
} from './warrantyClaimRecovery';

const NOW = '2026-10-28T12:00:00.000Z';
const inDays = (d: number) => new Date(Date.parse(NOW) + d * 86400_000).toISOString();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); });

const ALL: ClaimStatus[] = ['eligible', 'packet_pending', 'submitted', 'approved', 'denied', 'credit_received', 'closed'];

describe('claim status vocabulary', () => {
  it('every status has a label and appears in the options list exactly once', () => {
    expect([...CLAIM_STATUS_OPTIONS].sort()).toEqual([...ALL].sort());
    for (const s of ALL) expect(CLAIM_STATUS_LABELS[s]).toBeTruthy();
  });

  it('only denied and closed are "not open"', () => {
    expect(ALL.filter((s) => !isOpenClaim(s)).sort()).toEqual(['closed', 'denied']);
  });
});

describe('packetProgress', () => {
  it('counts completed checklist items; null/undefined behave as an empty checklist', () => {
    const total = Object.keys(EMPTY_CHECKLIST).length;
    expect(packetProgress(null)).toEqual({ done: 0, total });
    expect(packetProgress(undefined)).toEqual({ done: 0, total });
    expect(packetProgress({ ...EMPTY_CHECKLIST, defect_photo: true, invoice: true })).toEqual({ done: 2, total });
    expect(packetProgress(Object.fromEntries(Object.keys(EMPTY_CHECKLIST).map((k) => [k, true])) as typeof EMPTY_CHECKLIST)).toEqual({ done: total, total });
  });

  it('every checklist key has a label (no blank rows in the packet UI)', () => {
    for (const k of Object.keys(EMPTY_CHECKLIST)) expect((PACKET_ITEM_LABELS as Record<string, string>)[k]).toBeTruthy();
  });
});

describe('formatCents', () => {
  it.each([[null, 'Not on file'], [undefined, 'Not on file'], [0, '$0'], [12345, '$123'], [123456789, '$1,234,568']])('%s -> %s', (input, out) => {
    expect(formatCents(input as number | null | undefined)).toBe(out);
  });
});

describe('daysUntil / isDeadlineAtRisk', () => {
  it('returns null for missing deadlines', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil(undefined)).toBeNull();
    expect(daysUntil('')).toBeNull();
    expect(isDeadlineAtRisk('eligible', null)).toBe(false);
  });

  it('rounds up to whole days, negative once past', () => {
    expect(daysUntil(inDays(3))).toBe(3);
    expect(daysUntil(new Date(Date.parse(NOW) + 3600_000).toISOString())).toBe(1);
    expect(daysUntil(inDays(-2))).toBe(-2);
  });

  it('at risk = unfiled (eligible / packet_pending) AND 7 days or fewer left (including already past)', () => {
    expect(isDeadlineAtRisk('eligible', inDays(7))).toBe(true);
    expect(isDeadlineAtRisk('packet_pending', inDays(1))).toBe(true);
    expect(isDeadlineAtRisk('eligible', inDays(-10))).toBe(true);
    expect(isDeadlineAtRisk('eligible', inDays(8))).toBe(false);
  });

  it.each(['submitted', 'approved', 'denied', 'credit_received', 'closed'] as ClaimStatus[])('%s claims are never "at risk" — there is nothing left to file', (s) => {
    expect(isDeadlineAtRisk(s, inDays(-30))).toBe(false);
    expect(isDeadlineAtRisk(s, inDays(1))).toBe(false);
  });

  it('KNOWN GAP: an unparseable deadline yields NaN days; NaN is not "<= 7", so the claim is silently NOT flagged', () => {
    expect(daysUntil('garbage')).toBeNaN();
    expect(isDeadlineAtRisk('eligible', 'garbage')).toBe(false);
  });
});

describe('contract with check-warranty-claim-deadlines', () => {
  const edge = readFileSync(resolve(process.cwd(), 'supabase/functions/check-warranty-claim-deadlines/index.ts'), 'utf8');

  it('the edge function\'s 7-day warning window equals the UI "at risk" threshold', () => {
    const window = Number(/WARNING_WINDOW_DAYS\s*=\s*(\d+)/.exec(edge)?.[1]);
    expect(window).toBe(7);
    expect(isDeadlineAtRisk('eligible', inDays(window))).toBe(true);
    expect(isDeadlineAtRisk('eligible', inDays(window + 1))).toBe(false);
  });

  it('every status the edge function excludes from alerts is a real ClaimStatus', () => {
    const excluded = /\.not\("status",\s*"in",\s*"\(([^)]*)\)"\)/.exec(edge)?.[1].split(',') ?? [];
    expect(excluded.length).toBeGreaterThan(0);
    for (const s of excluded) expect(ALL, s).toContain(s);
  });

  it('KNOWN GAP: the edge function alerts on submitted/approved claims too (it excludes only denied, closed, credit_received), although the UI treats those as having nothing left to file — a filed claim can still get a "deadline missed" notification', () => {
    const excluded = (/\.not\("status",\s*"in",\s*"\(([^)]*)\)"\)/.exec(edge)?.[1] ?? '').split(',').sort();
    expect(excluded).toEqual(['closed', 'credit_received', 'denied']);
    const alertedButNothingToFile = ALL.filter((s) => !excluded.includes(s) && !isDeadlineAtRisk(s, inDays(1)));
    expect(alertedButNothingToFile.sort()).toEqual(['approved', 'submitted']);
  });
});
