import { describe, it, expect } from 'vitest';
import {
  actionRequirements,
  allowedActions,
  buildOutreachMessage,
  campaignProgress,
  contactLinks,
  countByFilter,
  filterOutreach,
  followUpFromDate,
  formatFollowUp,
  friendlyRecallError,
  isOverdue,
  normalizeCampaigns,
  normalizeEvents,
  normalizeOutreach,
  normalizeScan,
  reasonLabel,
  safeHttpsUrl,
  summarizeCampaigns,
  urgencyOf,
  validateAction,
  type OutreachRow,
} from './recallMatching';

const NOW = new Date('2026-10-20T12:00:00');

const row = (over: Partial<OutreachRow> = {}): OutreachRow => ({
  id: 'o1',
  campaign_id: 'c1',
  equipment_id: 'e1',
  customer_id: 'cu1',
  status: 'pending',
  applicability: 'applies',
  match_method: 'exact',
  priority_score: 90,
  priority_reasons: ['severity_critical'],
  attempts: 0,
  last_contacted_at: null,
  next_follow_up_at: null,
  job_id: null,
  resolution_note: null,
  resolved_at: null,
  created_at: null,
  equipment: { equipment_type: 'furnace', make: 'Carrier', model: '58STA', serial_number: '2112345678', install_date: null },
  customer: { name: 'Pat Lee', phone: '(555) 010-1234', email: 'pat@example.com', address: '1 Main St', customer_type: 'residential' },
  ...over,
});

describe('normalizers', () => {
  it('survive garbage input', () => {
    expect(normalizeCampaigns(null)).toEqual([]);
    expect(normalizeCampaigns([{}, 5, null])).toEqual([]);
    expect(normalizeOutreach('x')).toEqual([]);
    expect(normalizeOutreach([{ id: 'a' }])).toEqual([]);
    expect(normalizeEvents(undefined)).toEqual([]);
    expect(normalizeScan(null)).toEqual({ campaigns: 0, matched: 0, created: 0 });
  });

  it('fills defaults and rejects unknown enums', () => {
    const [c] = normalizeCampaigns([{ id: 'c1', severity: 'weird', status: 'nope', source_url: 'http://x.com', counts: { total: 3, pending: 'x' } }]);
    expect(c.severity).toBe('medium');
    expect(c.status).toBe('active');
    expect(c.source_kind).toBe('recall');
    expect(c.source_url).toBeNull();
    expect(c.counts.total).toBe(3);
    expect(c.counts.pending).toBe(0);
    expect(c.number).toBe('—');
  });

  it('clamps and cleans outreach rows', () => {
    const [r] = normalizeOutreach([{ id: 'o', equipment_id: 'e', priority_score: 250, status: 'bad', priority_reasons: ['a', 1, 'b'], attempts: -4 }]);
    expect(r.priority_score).toBe(100);
    expect(r.status).toBe('pending');
    expect(r.priority_reasons).toEqual(['a', 'b']);
    expect(r.attempts).toBe(0);
    expect(r.applicability).toBe('possible');
    expect(r.customer.name).toBe('Unknown customer');
  });

  it('normalizes events', () => {
    const [e] = normalizeEvents([{ id: 'x', event_type: 'contacted', channel: 'carrier-pigeon' }]);
    expect(e.channel).toBeNull();
    expect(e.event_type).toBe('contacted');
  });

  it('only allows https links', () => {
    expect(safeHttpsUrl('https://oem.com/r')).toBe('https://oem.com/r');
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('http://oem.com')).toBeNull();
  });
});

describe('status logic', () => {
  it('urgency thresholds match the database score', () => {
    expect(urgencyOf(80)).toBe('urgent');
    expect(urgencyOf(79)).toBe('high');
    expect(urgencyOf(60)).toBe('high');
    expect(urgencyOf(59)).toBe('standard');
  });

  it('offers only valid actions', () => {
    expect(allowedActions('pending', 0)).not.toContain('unreachable');
    expect(allowedActions('contacted', 3)).toContain('unreachable');
    expect(allowedActions('completed', 5)).toEqual(['reopened', 'note']);
    expect(allowedActions('pending', 0)).not.toContain('reopened');
  });

  it('mirrors the evidence rules', () => {
    expect(validateAction(row(), { action: 'contacted', channel: null, note: '' })).toMatch(/how you contacted/i);
    expect(validateAction(row(), { action: 'declined', channel: 'phone', note: '  ' })).toMatch(/note is required/i);
    expect(validateAction(row(), { action: 'unreachable', channel: null, note: '' })).toMatch(/not allowed/i);
    expect(validateAction(row({ attempts: 3 }), { action: 'unreachable', channel: null, note: '' })).toBeNull();
    expect(validateAction(row(), { action: 'completed', channel: null, note: '' })).toBeNull();
    expect(validateAction(row({ status: 'completed' }), { action: 'contacted', channel: 'phone', note: '' })).toMatch(/not allowed/i);
    expect(validateAction(row(), { action: 'note', channel: null, note: 'x'.repeat(1001) })).toMatch(/too long/i);
  });

  it('knows which inputs each action needs', () => {
    expect(actionRequirements('attempt')).toEqual({ channel: true, note: false, followUp: true });
    expect(actionRequirements('not_affected').note).toBe(true);
    expect(actionRequirements('completed')).toEqual({ channel: false, note: false, followUp: false });
  });

  it('computes campaign progress', () => {
    const counts = { total: 10, pending: 3, contacted: 1, scheduled: 1, completed: 3, declined: 1, unreachable: 0, not_affected: 1 };
    expect(campaignProgress(counts)).toEqual({ closed: 5, open: 5, percent: 50 });
    expect(campaignProgress({ ...counts, total: 0, pending: 0, contacted: 0, scheduled: 0, completed: 0, declined: 0, not_affected: 0 })).toEqual({ closed: 0, open: 0, percent: 0 });
  });

  it('detects overdue follow-ups only on open rows', () => {
    expect(isOverdue({ status: 'contacted', next_follow_up_at: '2026-10-19T09:00:00' }, NOW)).toBe(true);
    expect(isOverdue({ status: 'contacted', next_follow_up_at: '2026-10-21T09:00:00' }, NOW)).toBe(false);
    expect(isOverdue({ status: 'completed', next_follow_up_at: '2026-10-01T09:00:00' }, NOW)).toBe(false);
    expect(isOverdue({ status: 'pending', next_follow_up_at: null }, NOW)).toBe(false);
    expect(isOverdue({ status: 'pending', next_follow_up_at: 'garbage' }, NOW)).toBe(false);
  });
});

describe('lists', () => {
  const rows = [
    row({ id: '1', priority_score: 95 }),
    row({ id: '2', priority_score: 40, applicability: 'possible', next_follow_up_at: '2026-10-10T09:00:00', status: 'contacted' }),
    row({ id: '3', status: 'completed' }),
    row({ id: '4', customer: { name: 'Zed Corp', phone: null, email: null, address: 'Dock 9', customer_type: 'commercial' } }),
  ];

  it('filters', () => {
    const ids = (f: Parameters<typeof filterOutreach>[1]) => filterOutreach(rows, f, '', NOW).map((r) => r.id);
    expect(ids('open')).toEqual(['1', '2', '4']);
    expect(ids('urgent')).toEqual(['1', '4']);
    expect(ids('overdue')).toEqual(['2']);
    expect(ids('verify')).toEqual(['2']);
    expect(ids('closed')).toEqual(['3']);
    expect(ids('all')).toHaveLength(4);
  });

  it('searches customer, address, model and serial', () => {
    expect(filterOutreach(rows, 'all', 'zed', NOW).map((r) => r.id)).toEqual(['4']);
    expect(filterOutreach(rows, 'all', 'dock', NOW).map((r) => r.id)).toEqual(['4']);
    expect(filterOutreach(rows, 'all', '58sta', NOW)).toHaveLength(4);
    expect(filterOutreach(rows, 'all', 'nothing-matches', NOW)).toHaveLength(0);
  });

  it('counts per filter', () => {
    expect(countByFilter(rows, NOW)).toEqual({ open: 3, urgent: 2, overdue: 1, verify: 1, closed: 1, all: 4 });
  });

  it('summarizes campaigns and ignores cancelled ones', () => {
    const base = { id: 'c', title: 't', number: 'n' };
    const camps = normalizeCampaigns([
      { ...base, id: 'a', status: 'active', urgent_open: 2, overdue: 1, counts: { total: 5, completed: 2 } },
      { ...base, id: 'b', status: 'cancelled', urgent_open: 9, overdue: 9, counts: { total: 9 } },
      { ...base, id: 'c', status: 'completed', counts: { total: 3, completed: 3 } },
    ]);
    expect(summarizeCampaigns(camps)).toEqual({ activeCampaigns: 1, openUnits: 3, urgentOpen: 2, overdue: 1 });
  });

  it('formats follow-ups', () => {
    expect(formatFollowUp(null, NOW)).toBeNull();
    expect(formatFollowUp('bad', NOW)).toBeNull();
    expect(formatFollowUp('2026-10-20T08:00:00', NOW)).toBe('Due today');
    expect(formatFollowUp('2026-10-23T08:00:00', NOW)).toBe('In 3 days');
    expect(formatFollowUp('2026-10-21T08:00:00', NOW)).toBe('In 1 day');
    expect(formatFollowUp('2026-10-19T08:00:00', NOW)).toBe('Overdue by 1 day');
    expect(formatFollowUp('2026-10-15T08:00:00', NOW)).toBe('Overdue by 5 days');
  });

  it('converts a date input to a 9am ISO time', () => {
    expect(followUpFromDate('')).toBeNull();
    expect(followUpFromDate('20/10/2026')).toBeNull();
    const iso = followUpFromDate('2026-10-25');
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getHours()).toBe(9);
  });

  it('labels reason codes, with a fallback', () => {
    expect(reasonLabel('fire_or_co_risk')).toBe('Fire / CO risk equipment');
    expect(reasonLabel('some_new_code')).toBe('Some new code');
  });

  it('maps database errors to friendly text', () => {
    expect(friendlyRecallError({ message: 'RECALL_MIN_ATTEMPTS' })).toMatch(/3 contact attempts/);
    expect(friendlyRecallError({ message: 'boom' })).toMatch(/try again/);
    expect(friendlyRecallError(null, 'x')).toBe('x');
  });
});

describe('contact + messages', () => {
  it('builds safe contact links', () => {
    const l = contactLinks({ phone: '(555) 010-1234', email: 'pat@example.com' }, 'Hi there', 'a b');
    expect(l.tel).toBe('tel:5550101234');
    expect(l.sms).toBe('sms:5550101234?body=a%20b');
    expect(l.mailto).toBe('mailto:pat@example.com?subject=Hi%20there&body=a%20b');
    expect(contactLinks({ phone: '+1 555 010 1234', email: null }).tel).toBe('tel:+15550101234');
    expect(contactLinks({ phone: '12', email: 'not-an-email' })).toEqual({ tel: null, sms: null, mailto: null });
  });

  const ctx = (over = {}) => ({
    campaign: { source_kind: 'recall' as const, number: 'R-1', title: 'Heat exchanger crack', severity: 'critical' as const, remedy: 'Replace the heat exchanger.' },
    row: { applicability: 'applies' as const, equipment: row().equipment, customer: row().customer },
    businessName: 'Acme HVAC',
    ...over,
  });

  it('writes a factual email', () => {
    const m = buildOutreachMessage('email', ctx());
    expect(m.subject).toBe('Important safety notice for your Carrier 58STA');
    expect(m.body).toContain('Hello Pat,');
    expect(m.body).toContain('R-1');
    expect(m.body).toContain("manufacturer's stated remedy: Replace the heat exchanger.");
    expect(m.body).toContain('rated critical');
    expect(m.body).not.toMatch(/free|guarantee/i);
    expect(m.body).not.toContain('We are confirming');
  });

  it('flags uncertainty when the match is only possible', () => {
    const m = buildOutreachMessage('sms', ctx({ row: { applicability: 'possible', equipment: row().equipment, customer: row().customer } }));
    expect(m.body).toContain('confirming whether your exact unit is affected');
  });

  it('writes a short SMS and a call script', () => {
    const sms = buildOutreachMessage('sms', ctx());
    expect(sms.body.length).toBeLessThan(320);
    expect(sms.body).toContain('Acme HVAC');
    const call = buildOutreachMessage('phone', ctx({ campaign: { source_kind: 'bulletin', number: 'B-2', title: 'Igniter', severity: 'low', remedy: null } }));
    expect(call.body).toContain('service bulletin B-2');
    expect(call.body).toContain('remedy will be confirmed at the visit');
    expect(call.subject).toBe('Service notice for your Carrier 58STA');
  });

  it('falls back gracefully for unknown customers', () => {
    const m = buildOutreachMessage('email', ctx({ row: { applicability: 'applies', equipment: row().equipment, customer: { ...row().customer, name: 'Unknown customer' } }, businessName: null }));
    expect(m.body).toContain('Hello there,');
    expect(m.body.trim().endsWith('Your service team')).toBe(true);
  });
});
