import { describe, it, expect } from 'vitest';
import {
  channelKey,
  draftsDirty,
  draftsToPayload,
  eventLabel,
  oauthResultFromParams,
  rulesToDrafts,
  splitChannelKey,
  timeAgo,
  validateDrafts,
  type ChatRule,
} from './chatIntegrations';

const rule = (over: Partial<ChatRule>): ChatRule => ({
  provider: 'slack',
  eventType: 'emergency',
  enabled: true,
  channelId: 'C123',
  channelName: 'dispatch',
  containerId: null,
  containerName: null,
  threshold: null,
  ...over,
});

describe('channel keys', () => {
  it('round-trips Slack and Teams channels', () => {
    expect(channelKey({ id: 'C1', containerId: null })).toBe('C1');
    expect(splitChannelKey('C1')).toEqual({ channelId: 'C1', containerId: null });
    const key = channelKey({ id: '19:abc@thread.tacv2', containerId: 'team-guid' });
    expect(splitChannelKey(key)).toEqual({ channelId: '19:abc@thread.tacv2', containerId: 'team-guid' });
  });
});

describe('rulesToDrafts', () => {
  it('always yields the four alert types in order with safe defaults', () => {
    const drafts = rulesToDrafts('slack', [rule({ eventType: 'missed_call', channelId: 'C9' })]);
    expect(drafts.map((d) => d.eventType)).toEqual(['emergency', 'new_job', 'missed_call', 'low_csat']);
    expect(drafts[0].enabled).toBe(false);
    expect(drafts[2].channelKey).toBe('C9');
    expect(drafts[3].threshold).toBe(3);
  });

  it("ignores the other provider's rules", () => {
    const drafts = rulesToDrafts('teams', [rule({ provider: 'slack' })]);
    expect(drafts.every((d) => !d.enabled && d.channelKey === '')).toBe(true);
  });
});

describe('validateDrafts / draftsDirty', () => {
  it('requires a channel for every enabled alert', () => {
    const drafts = rulesToDrafts('slack', []);
    drafts[1].enabled = true;
    expect(Object.keys(validateDrafts(drafts))).toEqual(['new_job']);
    drafts[1].channelKey = 'C5';
    expect(validateDrafts(drafts)).toEqual({});
  });

  it('detects changes, and only counts the CSAT threshold for the CSAT row', () => {
    const saved = rulesToDrafts('slack', [rule({})]);
    const draft = rulesToDrafts('slack', [rule({})]);
    expect(draftsDirty(draft, saved)).toBe(false);
    draft[0].threshold = 1; // emergency row: threshold is irrelevant
    expect(draftsDirty(draft, saved)).toBe(false);
    draft[3].threshold = 2;
    expect(draftsDirty(draft, saved)).toBe(true);
  });
});

describe('draftsToPayload', () => {
  it('splits Teams keys and only sends a threshold for low CSAT', () => {
    const drafts = rulesToDrafts('teams', []);
    drafts[0] = { ...drafts[0], enabled: true, channelKey: 'team-1::chan-1', channelName: 'Dispatch', containerName: 'Ops' };
    const payload = draftsToPayload(drafts);
    expect(payload[0]).toEqual({
      eventType: 'emergency', enabled: true, channelId: 'chan-1', channelName: 'Dispatch', containerId: 'team-1', containerName: 'Ops', threshold: null,
    });
    expect(payload[1].channelId).toBeNull();
    expect(payload[3].threshold).toBe(3);
  });
});

describe('oauthResultFromParams', () => {
  it('reads success and error redirects', () => {
    expect(oauthResultFromParams(new URLSearchParams('slack=connected'))).toEqual({ provider: 'slack', ok: true, reason: null });
    expect(oauthResultFromParams(new URLSearchParams('teams=error&reason=denied'))).toEqual({ provider: 'teams', ok: false, reason: 'denied' });
    expect(oauthResultFromParams(new URLSearchParams('foo=bar'))).toBeNull();
  });
});

describe('labels and time', () => {
  it('labels events, falling back for unknown types', () => {
    expect(eventLabel('low_csat')).toBe('Low CSAT');
    expect(eventLabel('some_new_event')).toBe('some new event');
  });

  it('formats relative time', () => {
    const now = new Date('2026-10-08T12:00:00.000Z');
    expect(timeAgo('2026-10-08T11:59:30.000Z', now)).toBe('just now');
    expect(timeAgo('2026-10-08T11:15:00.000Z', now)).toBe('45m ago');
    expect(timeAgo('2026-10-08T07:00:00.000Z', now)).toBe('5h ago');
    expect(timeAgo('2026-10-05T12:00:00.000Z', now)).toBe('3d ago');
  });
});
