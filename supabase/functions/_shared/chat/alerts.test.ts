import { describe, it, expect } from 'vitest';
import {
  buildAlertMessage,
  canManageChatIntegrations,
  escapeHtml,
  escapeSlack,
  packChatState,
  sanitizeRules,
  shouldSendAlert,
  toSlackPayload,
  toTeamsHtml,
  unpackChatState,
} from './alerts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

describe('OAuth state packing', () => {
  it('round-trips provider, owner and actor', () => {
    expect(unpackChatState(packChatState('teams', OWNER, ACTOR))).toEqual({ provider: 'teams', ownerId: OWNER, actorId: ACTOR });
  });

  it('rejects tampered or malformed payloads', () => {
    expect(unpackChatState(`discord|${OWNER}|${ACTOR}`)).toBeNull();
    expect(unpackChatState(`slack|not-a-uuid|${ACTOR}`)).toBeNull();
    expect(unpackChatState(`slack|${OWNER}|${ACTOR}|extra`)).toBeNull();
    expect(unpackChatState('')).toBeNull();
  });
});

describe('canManageChatIntegrations', () => {
  const member = (over = {}) => ({ inviteStatus: 'active', permissions: { can_manage_team: true }, customRolePermissions: null, ...over });

  it('allows owners and active members with can_manage_team', () => {
    expect(canManageChatIntegrations({ profileRole: 'owner', member: null })).toBe(true);
    expect(canManageChatIntegrations({ profileRole: 'admin', member: member() })).toBe(true);
  });

  it('denies everyone else, and lets a custom role override', () => {
    expect(canManageChatIntegrations({ profileRole: 'admin', member: null })).toBe(false);
    expect(canManageChatIntegrations({ profileRole: 'admin', member: member({ inviteStatus: 'pending' }) })).toBe(false);
    expect(canManageChatIntegrations({ profileRole: 'admin', member: member({ customRolePermissions: { can_manage_team: false } }) })).toBe(false);
  });
});

describe('sanitizeRules', () => {
  const ok = { eventType: 'emergency', enabled: true, channelId: 'C123', channelName: 'dispatch' };

  it('accepts valid rules and defaults the CSAT threshold', () => {
    const r = sanitizeRules([ok, { eventType: 'low_csat', enabled: false }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rules[0].channelId).toBe('C123');
      expect(r.rules[1].threshold).toBe(3);
      expect(r.rules[0].threshold).toBeNull();
    }
  });

  it('rejects enabled rules without a channel, duplicates, unknown events and bad thresholds', () => {
    expect(sanitizeRules([{ eventType: 'emergency', enabled: true }]).ok).toBe(false);
    expect(sanitizeRules([ok, ok]).ok).toBe(false);
    expect(sanitizeRules([{ eventType: 'weather', enabled: false }]).ok).toBe(false);
    expect(sanitizeRules([{ eventType: 'low_csat', enabled: false, threshold: 9 }]).ok).toBe(false);
    expect(sanitizeRules('nope').ok).toBe(false);
  });

  it('strips control characters and drops container info when there is no channel', () => {
    const r = sanitizeRules([{ eventType: 'new_job', enabled: false, channelId: null, containerId: 'team-1' }, { ...ok, eventType: 'missed_call', channelName: 'a\u0000b' }]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.rules[0].containerId).toBeNull();
    expect(r.rules[1].channelName).toBe('ab');
  });
});

describe('shouldSendAlert', () => {
  it('never sends disabled rules', () => {
    expect(shouldSendAlert({ enabled: false, threshold: null }, 'emergency', {})).toBe(false);
  });

  it('applies the CSAT threshold inclusively', () => {
    const rule = { enabled: true, threshold: 3 };
    expect(shouldSendAlert(rule, 'low_csat', { rating: 3 })).toBe(true);
    expect(shouldSendAlert(rule, 'low_csat', { rating: 4 })).toBe(false);
    expect(shouldSendAlert(rule, 'low_csat', { rating: 'x' })).toBe(false);
    expect(shouldSendAlert(rule, 'new_job', {})).toBe(true);
  });
});

describe('buildAlertMessage', () => {
  it('builds a critical emergency message with a safe fallback caller', () => {
    const msg = buildAlertMessage('emergency', { caller_phone: '+15551234567', summary: 'Gas smell in basement' });
    expect(msg.severity).toBe('critical');
    expect(msg.fields[0]).toEqual({ label: 'Caller', value: 'Unknown caller' });
    expect(msg.path).toBe('/dashboard/calls');
  });

  it('truncates long text and formats times in UTC', () => {
    const msg = buildAlertMessage('new_job', { customer_name: 'Ana', address: 'x'.repeat(500), scheduled_datetime: '2026-10-08T14:30:00Z' });
    expect(msg.fields.find((f) => f.label === 'Address')?.value.length).toBe(160);
    expect(msg.fields.find((f) => f.label === 'Scheduled')?.value).toBe('2026-10-08 14:30 UTC');
    expect(msg.path).toBe('/dashboard/jobs');
  });

  it('includes caller context on low CSAT', () => {
    const msg = buildAlertMessage('low_csat', { rating: 2, comment: 'Waited too long' }, { callerName: 'Bo', callerPhone: '+1555' });
    expect(msg.fields.map((f) => f.value)).toEqual(['2/5', 'Waited too long', 'Bo', '+1555']);
  });
});

describe('rendering and escaping', () => {
  it('neutralises Slack mentions and links in customer-supplied text', () => {
    expect(escapeSlack('<!channel> & <https://evil|x>')).toBe('&lt;!channel&gt; &amp; &lt;https://evil|x&gt;');
    const msg = buildAlertMessage('emergency', { caller_name: '<!channel>' });
    const payload = toSlackPayload(msg, 'https://vireek.com');
    expect(JSON.stringify(payload.blocks)).not.toContain('<!channel>');
    expect(JSON.stringify(payload.blocks)).toContain('<https://vireek.com/dashboard/calls|Open in Vireek>');
  });

  it('escapes HTML for Teams', () => {
    expect(escapeHtml('<script>"x"</script>')).toBe('&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
    const html = toTeamsHtml(buildAlertMessage('new_job', { customer_name: '<b>Eve</b>' }), 'https://vireek.com');
    expect(html).not.toContain('<b>Eve</b>');
    expect(html).toContain('href="https://vireek.com/dashboard/jobs"');
  });
});
