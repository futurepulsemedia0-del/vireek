import { describe, it, expect } from 'vitest';
import {
  buildEmail,
  buildSlackPayload,
  buildSms,
  escapeHtml,
  escapeSlack,
  inferSeverity,
  isCoolingDown,
  isWithinWindow,
  localParts,
  parseTimeToMinutes,
  planRouting,
  resolveRecipients,
  ruleMatches,
  severityRank,
  truncate,
  validateRule,
  type Directory,
  type RoutingRule,
} from './routing';

function rule(over: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'r1',
    name: 'Critical to owner',
    is_active: true,
    priority: 100,
    notification_types: [],
    min_severity: 'high',
    target_type: 'owner',
    target_role: null,
    target_member_id: null,
    schedule_id: null,
    channels: ['sms'],
    active_days: [0, 1, 2, 3, 4, 5, 6],
    window_start: null,
    window_end: null,
    timezone: 'UTC',
    escalate_if_unacked: false,
    cooldown_minutes: 0,
    ...over,
  };
}

const DIR: Directory = {
  owner: { key: 'owner', label: 'Sam Owner', phone: '+15550000001', email: 'sam@example.com' },
  members: [
    { key: 'member:t1', memberId: 't1', role: 'technician', label: 'Alex', phone: '+15550000002', email: 'alex@example.com' },
    { key: 'member:t2', memberId: 't2', role: 'technician', label: 'Bo', phone: null, email: 'bo@example.com' },
    { key: 'member:a1', memberId: 'a1', role: 'admin', label: 'Dana', phone: '+15550000004', email: null },
  ],
  onCallByScheduleId: { s1: 't1', s2: null },
};

// Friday 2026-10-09 12:00 UTC
const FRI_NOON = new Date('2026-10-09T12:00:00Z');

describe('severity', () => {
  it('ranks info < warning < high < critical', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('warning'));
    expect(severityRank('warning')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('critical'));
  });

  it('prefers an explicit valid severity, otherwise infers from type', () => {
    expect(inferSeverity('new_lead', 'critical')).toBe('critical');
    expect(inferSeverity('emergency_call')).toBe('critical');
    expect(inferSeverity('missed_call')).toBe('high');
    expect(inferSeverity('warranty_alert')).toBe('warning');
    expect(inferSeverity('something_failed')).toBe('high');
    expect(inferSeverity('totally_unknown')).toBe('info');
    expect(inferSeverity('missed_call', 'bogus')).toBe('high');
  });
});

describe('time windows', () => {
  it('parses HH:MM and HH:MM:SS and rejects garbage', () => {
    expect(parseTimeToMinutes('08:30')).toBe(510);
    expect(parseTimeToMinutes('23:59:00')).toBe(1439);
    expect(parseTimeToMinutes('24:00')).toBeNull();
    expect(parseTimeToMinutes('nope')).toBeNull();
  });

  it('reads local weekday/minutes in the rule timezone (DST aware)', () => {
    // 02:00Z on Fri Oct 9 = Thu 22:00 in New York (EDT, UTC-4)
    expect(localParts(new Date('2026-10-09T02:00:00Z'), 'America/New_York')).toEqual({ day: 4, minutes: 22 * 60 });
    expect(localParts(new Date('2026-10-09T02:00:00Z'), 'Not/AZone')).toBeNull();
  });

  it('no window = always, but still honours active days', () => {
    expect(isWithinWindow(rule(), FRI_NOON)).toBe(true);
    expect(isWithinWindow(rule({ active_days: [1, 2, 3, 4] }), FRI_NOON)).toBe(false); // Friday excluded
  });

  it('same-day window is [start, end)', () => {
    const r = rule({ window_start: '09:00', window_end: '17:00' });
    expect(isWithinWindow(r, new Date('2026-10-09T09:00:00Z'))).toBe(true);
    expect(isWithinWindow(r, new Date('2026-10-09T16:59:00Z'))).toBe(true);
    expect(isWithinWindow(r, new Date('2026-10-09T17:00:00Z'))).toBe(false);
    expect(isWithinWindow(r, new Date('2026-10-09T08:59:00Z'))).toBe(false);
  });

  it('overnight window attributes the after-midnight part to the day it started', () => {
    // Fri-only after-hours window 18:00 → 06:00
    const r = rule({ window_start: '18:00', window_end: '06:00', active_days: [5] });
    expect(isWithinWindow(r, new Date('2026-10-09T20:00:00Z'))).toBe(true); // Fri 20:00
    expect(isWithinWindow(r, new Date('2026-10-10T03:00:00Z'))).toBe(true); // Sat 03:00 (still Friday's window)
    expect(isWithinWindow(r, new Date('2026-10-09T03:00:00Z'))).toBe(false); // Fri 03:00 belongs to Thursday's window
    expect(isWithinWindow(r, new Date('2026-10-10T20:00:00Z'))).toBe(false); // Sat evening
    expect(isWithinWindow(r, new Date('2026-10-09T12:00:00Z'))).toBe(false); // midday gap
  });

  it('start == end means the whole day', () => {
    expect(isWithinWindow(rule({ window_start: '08:00', window_end: '08:00' }), FRI_NOON)).toBe(true);
  });

  it('fails open on an invalid timezone so alerts are never dropped by bad config', () => {
    expect(isWithinWindow(rule({ timezone: 'Mars/Base', window_start: '01:00', window_end: '02:00' }), FRI_NOON)).toBe(true);
  });

  it('evaluates windows in the rule timezone, not UTC', () => {
    const r = rule({ timezone: 'America/New_York', window_start: '08:00', window_end: '18:00' });
    expect(isWithinWindow(r, new Date('2026-10-09T13:00:00Z'))).toBe(true); // 09:00 EDT
    expect(isWithinWindow(r, new Date('2026-10-09T02:00:00Z'))).toBe(false); // 22:00 EDT
  });
});

describe('ruleMatches', () => {
  it('requires active, type, severity and window', () => {
    expect(ruleMatches(rule(), { type: 'missed_call', severity: 'high' }, FRI_NOON)).toBe(true);
    expect(ruleMatches(rule({ is_active: false }), { type: 'missed_call', severity: 'critical' }, FRI_NOON)).toBe(false);
    expect(ruleMatches(rule(), { type: 'missed_call', severity: 'warning' }, FRI_NOON)).toBe(false);
    expect(ruleMatches(rule({ notification_types: ['emergency_call'] }), { type: 'missed_call', severity: 'critical' }, FRI_NOON)).toBe(false);
    expect(ruleMatches(rule({ notification_types: ['emergency_call'] }), { type: 'emergency_call', severity: 'critical' }, FRI_NOON)).toBe(true);
    expect(ruleMatches(rule({ min_severity: 'info' }), { type: 'x', severity: 'info' }, FRI_NOON)).toBe(true);
  });
});

describe('resolveRecipients', () => {
  it('resolves owner, role, member and on-call targets', () => {
    expect(resolveRecipients(rule(), DIR).map((r) => r.key)).toEqual(['owner']);
    expect(resolveRecipients(rule({ target_type: 'role', target_role: 'technician' }), DIR).map((r) => r.key)).toEqual(['member:t1', 'member:t2']);
    expect(resolveRecipients(rule({ target_type: 'member', target_member_id: 'a1' }), DIR).map((r) => r.key)).toEqual(['member:a1']);
    expect(resolveRecipients(rule({ target_type: 'on_call', schedule_id: 's1' }), DIR).map((r) => r.key)).toEqual(['member:t1']);
  });

  it('returns nobody for an empty rotation or an unknown/inactive member', () => {
    expect(resolveRecipients(rule({ target_type: 'on_call', schedule_id: 's2' }), DIR)).toEqual([]);
    expect(resolveRecipients(rule({ target_type: 'member', target_member_id: 'gone' }), DIR)).toEqual([]);
  });
});

describe('planRouting', () => {
  const n = { type: 'emergency_call', severity: 'critical' as const };
  const opts = { slackConfigured: true };

  it('is unmatched when no rule applies', () => {
    const plan = planRouting([rule({ min_severity: 'critical' })], { type: 'x', severity: 'info' }, DIR, FRI_NOON, opts);
    expect(plan.unmatched).toBe(true);
    expect(plan.deliveries).toEqual([]);
  });

  it('fans out one delivery per channel x recipient', () => {
    const plan = planRouting([rule({ target_type: 'role', target_role: 'technician', channels: ['sms', 'email', 'push'] })], n, DIR, FRI_NOON, opts);
    expect(plan.deliveries.map((d) => `${d.channel}:${d.recipientKey}:${d.skipReason ?? 'ok'}`)).toEqual([
      'sms:member:t1:ok',
      'sms:member:t2:no_phone',
      'email:member:t1:ok',
      'email:member:t2:ok',
      'push:member:t1:ok',
      'push:member:t2:ok',
    ]);
  });

  it('marks missing email and unconfigured Slack as explicit skips', () => {
    const plan = planRouting([rule({ target_type: 'member', target_member_id: 'a1', channels: ['email', 'slack'] })], n, DIR, FRI_NOON, { slackConfigured: false });
    expect(plan.deliveries.map((d) => d.skipReason)).toEqual(['no_email', 'slack_not_configured']);
  });

  it('de-duplicates the same channel+recipient across rules; lowest priority number wins', () => {
    const a = rule({ id: 'a', priority: 50, channels: ['sms'] });
    const b = rule({ id: 'b', priority: 10, channels: ['sms', 'email'] });
    const plan = planRouting([a, b], n, DIR, FRI_NOON, opts);
    const sms = plan.deliveries.filter((d) => d.channel === 'sms');
    expect(sms).toHaveLength(1);
    expect(sms[0].ruleId).toBe('b');
    expect(plan.deliveries.filter((d) => d.channel === 'email')).toHaveLength(1);
    expect(plan.matchedRuleIds).toEqual(['b', 'a']);
  });

  it('sends Slack once per notification no matter how many rules request it', () => {
    const plan = planRouting([rule({ id: 'a', channels: ['slack'] }), rule({ id: 'b', channels: ['slack'], target_type: 'role', target_role: 'admin' })], n, DIR, FRI_NOON, opts);
    expect(plan.deliveries.filter((d) => d.channel === 'slack')).toHaveLength(1);
  });

  it('records no_recipient when a target resolves to nobody', () => {
    const plan = planRouting([rule({ target_type: 'on_call', schedule_id: 's2', channels: ['sms'] })], n, DIR, FRI_NOON, opts);
    expect(plan.deliveries).toHaveLength(1);
    expect(plan.deliveries[0].skipReason).toBe('no_recipient');
  });

  it('plans one escalation per schedule', () => {
    const plan = planRouting(
      [
        rule({ id: 'a', schedule_id: 's1', escalate_if_unacked: true }),
        rule({ id: 'b', schedule_id: 's1', escalate_if_unacked: true, priority: 200 }),
        rule({ id: 'c', escalate_if_unacked: false, schedule_id: 's2' }),
      ],
      n,
      DIR,
      FRI_NOON,
      opts,
    );
    expect(plan.escalations).toEqual([{ ruleId: 'a', scheduleId: 's1' }]);
  });

  it('does not mutate its input and is deterministic for equal priorities', () => {
    const rules = [rule({ id: 'b' }), rule({ id: 'a' })];
    const first = planRouting(rules, n, DIR, FRI_NOON, opts);
    expect(rules.map((r) => r.id)).toEqual(['b', 'a']);
    expect(first.matchedRuleIds).toEqual(['a', 'b']);
  });
});

describe('isCoolingDown', () => {
  it('only blocks inside the cooldown window', () => {
    const last = new Date(FRI_NOON.getTime() - 5 * 60_000).toISOString();
    expect(isCoolingDown(0, last, FRI_NOON)).toBe(false);
    expect(isCoolingDown(10, null, FRI_NOON)).toBe(false);
    expect(isCoolingDown(10, last, FRI_NOON)).toBe(true);
    expect(isCoolingDown(5, last, FRI_NOON)).toBe(false);
    expect(isCoolingDown(10, 'garbage', FRI_NOON)).toBe(false);
  });
});

describe('message builders', () => {
  const base = { title: 'Emergency: burst pipe', message: 'Caller at 12 Oak St reports flooding.', severity: 'critical' as const, openUrl: 'https://app.vireek.com/dashboard/calls', ackUrl: 'https://app.vireek.com/ack/abc' };

  it('keeps SMS under 320 chars and includes the ack link', () => {
    const sms = buildSms({ ...base, message: 'x'.repeat(2000) });
    expect(sms.length).toBeLessThanOrEqual(320);
    expect(sms).toContain('/ack/abc');
    expect(sms).toContain('CRITICAL');
  });

  it('falls back to the dashboard link when there is no ack token', () => {
    expect(buildSms({ ...base, ackUrl: null })).toContain('/dashboard/calls');
  });

  it('escapes HTML in email and Slack control characters', () => {
    const email = buildEmail({ ...base, title: '<script>alert(1)</script>', message: 'a & b' });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('a &amp; b');
    expect(email.subject.startsWith('[CRITICAL]')).toBe(true);
    expect(escapeHtml(`"'`)).toBe('&quot;&#39;');
    expect(escapeSlack('<!channel> & more')).toBe('&lt;!channel&gt; &amp; more');
    expect(buildSlackPayload({ ...base, title: '<!channel>' }).text).not.toContain('<!channel>');
  });

  it('truncates with an ellipsis and collapses whitespace', () => {
    expect(truncate('a   b\n c', 20)).toBe('a b c');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('validateRule', () => {
  it('accepts a good rule', () => {
    expect(validateRule(rule())).toEqual([]);
  });

  it('flags every inconsistent combination', () => {
    expect(validateRule(rule({ name: '  ' }))).toContain('name');
    expect(validateRule(rule({ channels: [] }))).toContain('channels');
    expect(validateRule(rule({ target_type: 'role', target_role: null }))).toContain('target_role');
    expect(validateRule(rule({ target_type: 'member', target_member_id: null }))).toContain('target_member_id');
    expect(validateRule(rule({ target_type: 'on_call', schedule_id: null }))).toContain('schedule_id');
    expect(validateRule(rule({ escalate_if_unacked: true, schedule_id: null }))).toContain('escalation_schedule');
    expect(validateRule(rule({ window_start: '09:00', window_end: null }))).toContain('window');
    expect(validateRule(rule({ window_start: '9am', window_end: '17:00' }))).toContain('window_start');
    expect(validateRule(rule({ active_days: [] }))).toContain('active_days');
    expect(validateRule(rule({ active_days: [7] }))).toContain('active_days');
    expect(validateRule(rule({ timezone: 'Nope/Zone' }))).toContain('timezone');
  });
});
