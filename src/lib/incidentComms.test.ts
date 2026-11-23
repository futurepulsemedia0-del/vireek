import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), auth: { getSession: vi.fn() } } }));

import { allowedAudiences, approveBlock, canSend, isLocked, isStale, parseOverview } from './incidentComms';

const draftRow = {
  id: 'd1', incident_id: 'i1', phase: 'investigating', severity: 'sev1', audience: 'status_page_and_subscribers',
  status_post_text: 'We are investigating.', email_subject: 'S', email_body: 'B', next_update_at: '2029-05-01T14:30:00Z',
  state: 'pending_approval', created_by: 'u1', submitted_by: 'u1', content_hash: 'abc', email_result: { sent: 3, failed: 1, total: 4 },
};

describe('parseOverview', () => {
  it('parses incidents and drafts and drops malformed rows', () => {
    const o = parseOverview({
      me: 'u2', require_second_approver_major: true,
      incidents: [{ id: 'i1', title: 'T', impact: 'major', status: 'investigating', component_id: 'voice' }, { title: 'no id' }],
      drafts: [draftRow, { ...draftRow, id: 'd2', phase: 'weird' }, { ...draftRow, id: 'd3', state: 'nope' }],
    });
    expect(o.me).toBe('u2');
    expect(o.incidents).toHaveLength(1);
    expect(o.drafts).toHaveLength(1);
    expect(o.drafts[0].emailResult).toEqual({ sent: 3, failed: 1, total: 4 });
  });
  it('defaults to the strict setting when the flag is missing, and survives garbage', () => {
    expect(parseOverview({}).requireSecondApprover).toBe(true);
    expect(parseOverview(null).drafts).toEqual([]);
  });
});

describe('approval rules mirror the database', () => {
  const d = { state: 'pending_approval' as const, severity: 'sev1' as const, createdBy: 'u1', submittedBy: 'u1' };
  it('requires a different person for SEV1/SEV2 or major incidents when the setting is on', () => {
    expect(approveBlock(d, 'u1', true, 'minor')).toBe('second_person');
    expect(approveBlock(d, 'u2', true, 'minor')).toBeNull();
    expect(approveBlock({ ...d, severity: 'sev3' }, 'u1', true, 'major')).toBe('second_person');
    expect(approveBlock({ ...d, severity: 'sev3' }, 'u1', true, 'minor')).toBeNull();
  });
  it('lets the drafter approve when the setting is off', () => {
    expect(approveBlock(d, 'u1', false, 'major')).toBeNull();
  });
  it('only a pending draft can be approved', () => {
    expect(approveBlock({ ...d, state: 'draft' }, 'u2', true, 'minor')).toBe('not_pending');
    expect(approveBlock({ ...d, state: 'approved' }, 'u2', true, 'minor')).toBe('not_pending');
  });
});

describe('state helpers', () => {
  it('sends only approved or failed drafts; locked states are not editable', () => {
    expect(canSend('approved')).toBe(true);
    expect(canSend('send_failed')).toBe(true);
    expect(canSend('draft')).toBe(false);
    expect(canSend('pending_approval')).toBe(false);
    expect(canSend('sent')).toBe(false);
    expect(isLocked('sending')).toBe(true);
    expect(isLocked('sent')).toBe(true);
    expect(isLocked('draft')).toBe(false);
  });
  it('audiences by severity', () => {
    expect(allowedAudiences('sev3')).toEqual(['status_page']);
    expect(allowedAudiences('sev4')).toEqual([]);
    expect(allowedAudiences('sev1')).toHaveLength(2);
  });
  it('stale only for open phases with a passed, unposted promise', () => {
    const now = new Date('2029-05-01T15:00:00Z');
    expect(isStale({ phase: 'investigating', nextUpdateAt: '2029-05-01T14:30:00Z', statusPostedAt: null }, now)).toBe(true);
    expect(isStale({ phase: 'resolved', nextUpdateAt: '2029-05-01T14:30:00Z', statusPostedAt: null }, now)).toBe(false);
    expect(isStale({ phase: 'investigating', nextUpdateAt: '2029-05-01T14:30:00Z', statusPostedAt: '2029-05-01T14:10:00Z' }, now)).toBe(false);
  });
});
