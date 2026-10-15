import { describe, it, expect } from 'vitest';
import {
  RULE_TEMPLATES,
  describeRule,
  draftToRow,
  emptyDraft,
  formatDays,
  formatWindow,
  hasErrors,
  isValidTimezone,
  ruleToDraft,
  skipReasonLabel,
  validateDraft,
  type RoutingRule,
} from './notificationRouting';

const lookup = {
  memberName: (id: string) => (id === 'm1' ? 'Alex Rivera' : null),
  scheduleName: (id: string) => (id === 's1' ? 'Emergency Dispatch' : null),
};

function rule(over: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 'r1',
    user_id: 'u1',
    name: 'Rule',
    is_active: true,
    priority: 100,
    notification_types: [],
    min_severity: 'high',
    target_type: 'owner',
    target_role: null,
    target_member_id: null,
    schedule_id: null,
    channels: ['push', 'sms'],
    active_days: [0, 1, 2, 3, 4, 5, 6],
    window_start: null,
    window_end: null,
    timezone: 'UTC',
    escalate_if_unacked: false,
    cooldown_minutes: 0,
    created_at: '2026-10-09T00:00:00Z',
    updated_at: '2026-10-09T00:00:00Z',
    ...over,
  };
}

describe('validateDraft', () => {
  const ok = () => emptyDraft({ name: 'Critical to me', timezone: 'UTC' });

  it('accepts a minimal valid draft', () => {
    expect(hasErrors(validateDraft(ok()))).toBe(false);
  });

  it('requires a name of sensible length', () => {
    expect(validateDraft({ ...ok(), name: '   ' }).name).toBeTruthy();
    expect(validateDraft({ ...ok(), name: 'x'.repeat(81) }).name).toBeTruthy();
  });

  it('requires at least one channel and one day', () => {
    expect(validateDraft({ ...ok(), channels: [] }).channels).toBeTruthy();
    expect(validateDraft({ ...ok(), active_days: [] }).days).toBeTruthy();
  });

  it('requires the target that matches target_type', () => {
    expect(validateDraft({ ...ok(), target_type: 'role', target_role: '' }).target).toBeTruthy();
    expect(validateDraft({ ...ok(), target_type: 'role', target_role: 'admin' }).target).toBeUndefined();
    expect(validateDraft({ ...ok(), target_type: 'member', target_member_id: '' }).target).toBeTruthy();
    expect(validateDraft({ ...ok(), target_type: 'on_call', schedule_id: '' }).schedule).toBeTruthy();
  });

  it('requires a schedule for escalation', () => {
    expect(validateDraft({ ...ok(), escalate_if_unacked: true, schedule_id: '' }).schedule).toBeTruthy();
    expect(validateDraft({ ...ok(), escalate_if_unacked: true, schedule_id: 's1' }).schedule).toBeUndefined();
  });

  it('validates the time window only when enabled', () => {
    expect(validateDraft({ ...ok(), window_enabled: true, window_start: '9am', window_end: '17:00' }).window).toBeTruthy();
    expect(validateDraft({ ...ok(), window_enabled: true, window_start: '25:00', window_end: '17:00' }).window).toBeTruthy();
    expect(validateDraft({ ...ok(), window_enabled: true, window_start: '18:00', window_end: '08:00' }).window).toBeUndefined();
    expect(validateDraft({ ...ok(), window_enabled: false, window_start: 'junk', window_end: 'junk' }).window).toBeUndefined();
  });

  it('validates timezone, cooldown and priority bounds', () => {
    expect(validateDraft({ ...ok(), timezone: 'Mars/Base' }).timezone).toBeTruthy();
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('')).toBe(false);
    expect(validateDraft({ ...ok(), cooldown_minutes: -1 }).cooldown).toBeTruthy();
    expect(validateDraft({ ...ok(), cooldown_minutes: 1441 }).cooldown).toBeTruthy();
    expect(validateDraft({ ...ok(), priority: 10001 }).priority).toBeTruthy();
    expect(validateDraft({ ...ok(), cooldown_minutes: Number.NaN }).cooldown).toBeTruthy();
  });
});

describe('draftToRow', () => {
  it('nulls fields that do not apply to the chosen target', () => {
    const row = draftToRow(emptyDraft({ name: ' A ', target_type: 'owner', target_role: 'admin', target_member_id: 'm1', schedule_id: 's1', timezone: ' UTC ' }));
    expect(row.name).toBe('A');
    expect(row.target_role).toBeNull();
    expect(row.target_member_id).toBeNull();
    expect(row.schedule_id).toBeNull();
    expect(row.timezone).toBe('UTC');
  });

  it('keeps the schedule for on-call targets and for escalation', () => {
    expect(draftToRow(emptyDraft({ target_type: 'on_call', schedule_id: 's1' })).schedule_id).toBe('s1');
    expect(draftToRow(emptyDraft({ escalate_if_unacked: true, schedule_id: 's1' })).schedule_id).toBe('s1');
  });

  it('writes the window only when enabled and sorts days', () => {
    const on = draftToRow(emptyDraft({ window_enabled: true, window_start: '18:00', window_end: '08:00', active_days: [5, 1, 3] }));
    expect([on.window_start, on.window_end]).toEqual(['18:00', '08:00']);
    expect(on.active_days).toEqual([1, 3, 5]);
    const off = draftToRow(emptyDraft({ window_enabled: false }));
    expect([off.window_start, off.window_end]).toEqual([null, null]);
  });

  it('round-trips through ruleToDraft (DB time strings with seconds)', () => {
    const draft = ruleToDraft(rule({ window_start: '18:00:00', window_end: '08:00:00', target_type: 'role', target_role: 'technician' }));
    expect(draft.window_enabled).toBe(true);
    expect(draft.window_start).toBe('18:00');
    expect(draft.target_role).toBe('technician');
    expect(ruleToDraft(rule()).window_enabled).toBe(false);
  });
});

describe('describeRule', () => {
  it('describes what, who, how and when', () => {
    const text = describeRule(
      rule({ notification_types: ['emergency_call'], min_severity: 'critical', target_type: 'on_call', schedule_id: 's1', channels: ['sms', 'push'], window_start: '18:00', window_end: '08:00', escalate_if_unacked: true }),
      lookup,
    );
    expect(text).toContain('Emergency call');
    expect(text).toContain('critical severity or above');
    expect(text).toContain('whoever is on call (Emergency Dispatch)');
    expect(text).toContain('SMS + Push');
    expect(text).toContain('18:00–08:00');
    expect(text).toContain('Escalates if nobody acknowledges');
  });

  it('handles members, roles and unknown lookups gracefully', () => {
    expect(describeRule(rule({ target_type: 'member', target_member_id: 'm1' }), lookup)).toContain('Alex Rivera');
    expect(describeRule(rule({ target_type: 'member', target_member_id: 'gone' }), lookup)).toContain('a team member');
    expect(describeRule(rule({ target_type: 'role', target_role: 'admin' }), lookup)).toContain('admins');
    expect(describeRule(rule({ min_severity: 'info' }), lookup)).not.toContain('severity');
  });
});

describe('formatting helpers', () => {
  it('formats days and windows', () => {
    expect(formatDays([0, 1, 2, 3, 4, 5, 6])).toBe('every day');
    expect(formatDays([5, 4, 3, 2, 1])).toBe('weekdays');
    expect(formatDays([6, 0])).toBe('weekends');
    expect(formatDays([1, 3])).toBe('Mon, Wed');
    expect(formatWindow(null, null)).toBe('any time');
    expect(formatWindow('08:00:00', '17:30:00')).toBe('08:00–17:30');
  });

  it('labels skip reasons and passes unknown codes through', () => {
    expect(skipReasonLabel('no_phone')).toMatch(/phone/i);
    expect(skipReasonLabel('weird')).toBe('weird');
    expect(skipReasonLabel(null)).toBe('');
  });
});

describe('RULE_TEMPLATES', () => {
  it('produce drafts that pass validation once a schedule exists', () => {
    for (const t of RULE_TEMPLATES) {
      const draft = emptyDraft({ ...t.draft, timezone: 'UTC', schedule_id: t.draft.target_type === 'on_call' || t.draft.escalate_if_unacked ? 's1' : '' });
      expect(hasErrors(validateDraft(draft)), t.id).toBe(false);
    }
  });
});
