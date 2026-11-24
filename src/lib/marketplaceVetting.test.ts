import { describe, expect, it } from 'vitest';
import {
  answerNeedsNote, checklistProgress, classifyError, groupChecks, noteIsValid, parseApprovalBlockers, worstStatus,
  type ChecklistItemState, type VettingCheck,
} from './marketplaceVetting';

const item = (over: Partial<ChecklistItemState>): ChecklistItemState => ({
  slug: 'x', category: 'security', allows_na: false, needs_counsel: false, applies: true, answer: null, note: null, ...over,
});

describe('parseApprovalBlockers', () => {
  it('extracts known codes from the database message', () => {
    expect(parseApprovalBlockers('APPROVAL_BLOCKED: no_report,checklist_incomplete')).toEqual(['no_report', 'checklist_incomplete']);
    expect(parseApprovalBlockers('error: APPROVAL_BLOCKED: report_stale, self_review')).toEqual(['report_stale', 'self_review']);
  });
  it('drops unknown codes and handles non-matches', () => {
    expect(parseApprovalBlockers('APPROVAL_BLOCKED: no_report,evil_code')).toEqual(['no_report']);
    expect(parseApprovalBlockers('Staff only.')).toEqual([]);
    expect(parseApprovalBlockers(null)).toEqual([]);
  });
});

describe('checklistProgress', () => {
  it('ignores items that do not apply', () => {
    const p = checklistProgress([item({ answer: 'pass' }), item({ applies: false }), item({ answer: 'na' })]);
    expect(p).toEqual({ total: 2, done: 2, failed: 0, complete: true });
  });
  it('is incomplete with unanswered or failed items', () => {
    expect(checklistProgress([item({ answer: 'pass' }), item({})]).complete).toBe(false);
    const f = checklistProgress([item({ answer: 'fail' }), item({ answer: 'pass' })]);
    expect(f.failed).toBe(1);
    expect(f.complete).toBe(false);
  });
  it('an empty applicable set is complete', () => {
    expect(checklistProgress([]).complete).toBe(true);
  });
});

describe('notes', () => {
  it('requires 5 trimmed characters', () => {
    expect(noteIsValid('  abc ')).toBe(false);
    expect(noteIsValid('abcde')).toBe(true);
    expect(noteIsValid(null)).toBe(false);
  });
  it('only pass can go without a note', () => {
    expect(answerNeedsNote('pass')).toBe(false);
    expect(answerNeedsNote('fail')).toBe(true);
    expect(answerNeedsNote('na')).toBe(true);
  });
});

describe('check helpers', () => {
  const c = (category: VettingCheck['category'], status: VettingCheck['status']): VettingCheck => ({ id: `${category}.${status}`, category, status, detail: '' });
  it('groups by category and finds the worst status', () => {
    const g = groupChecks([c('scopes', 'warn'), c('outbound', 'fail'), c('scopes', 'pass')]);
    expect(g.scopes).toHaveLength(2);
    expect(g.outbound).toHaveLength(1);
    expect(g.data).toHaveLength(0);
    expect(worstStatus([c('scopes', 'pass'), c('data', 'warn')])).toBe('warn');
    expect(worstStatus([c('scopes', 'pass'), c('data', 'fail')])).toBe('fail');
    expect(worstStatus([])).toBe('pass');
  });
  it('classifies database errors', () => {
    expect(classifyError('Staff only.')).toBe('forbidden');
    expect(classifyError('permission denied for table x')).toBe('forbidden');
    expect(classifyError('APPROVAL_BLOCKED: no_report')).toBe('blocked');
    expect(classifyError('Agent not found.')).toBe('notFound');
    expect(classifyError('boom')).toBe('generic');
  });
});
