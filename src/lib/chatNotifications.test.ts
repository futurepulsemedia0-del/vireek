import { describe, it, expect } from 'vitest';
import {
  CHAT_EVENTS,
  CHAT_EVENT_TYPES,
  connectionHealth,
  deliveryTone,
  eventLabel,
  needsTeamsInstall,
  oauthReasonMessage,
  routeFor,
  summarizeRouting,
  type ChatConnection,
  type ChatRoute,
} from './chatNotifications';
import { CHAT_EVENT_TYPES as SERVER_EVENT_TYPES, EVENT_META } from '../../supabase/functions/_shared/chat-notify/events';

const conn = (over: Partial<ChatConnection> = {}): ChatConnection => ({
  id: 'c1', provider: 'slack', external_id: 'T1', external_name: 'Acme', status: 'connected', last_error: null, ...over,
});
const route = (over: Partial<ChatRoute> = {}): ChatRoute => ({
  id: 'r1', connection_id: 'c1', event_type: 'new_job', channel_id: 'C1', channel_name: 'jobs',
  enabled: true, actions_enabled: true, include_contact_details: true, csat_threshold: 2, ...over,
});

describe('chat notification catalogue', () => {
  it('stays in lock-step with the server-side event types and buttons', () => {
    expect([...CHAT_EVENT_TYPES]).toEqual([...SERVER_EVENT_TYPES]);
    for (const e of CHAT_EVENTS) expect(e.buttons).toEqual(EVENT_META[e.id].actions);
  });
  it('labels known and unknown events', () => {
    expect(eventLabel('low_csat')).toBe('Low CSAT');
    expect(eventLabel('mystery')).toBe('mystery');
  });
});

describe('routing helpers', () => {
  it('finds a route by connection and event', () => {
    const routes = [route(), route({ id: 'r2', connection_id: 'c2' })];
    expect(routeFor(routes, 'c1', 'new_job')?.id).toBe('r1');
    expect(routeFor(routes, 'c1', 'missed_call')).toBeUndefined();
  });
  it('counts only enabled routes that have a channel', () => {
    const routes = [route(), route({ id: 'r2', event_type: 'missed_call', enabled: false }), route({ id: 'r3', event_type: 'low_csat', channel_id: '' })];
    expect(summarizeRouting(routes, 'c1')).toEqual({ active: 1, total: 6 });
  });
});

describe('status helpers', () => {
  it('maps connection state to label + tone', () => {
    expect(connectionHealth(undefined)).toEqual({ label: 'Not connected', tone: 'neutral' });
    expect(connectionHealth(conn({ status: 'error' })).tone).toBe('danger');
    expect(connectionHealth(conn()).tone).toBe('success');
  });
  it('maps delivery status to tone', () => {
    expect(deliveryTone('sent')).toBe('success');
    expect(deliveryTone('failed')).toBe('danger');
    expect(deliveryTone('pending')).toBe('warning');
    expect(deliveryTone('skipped')).toBe('neutral');
  });
  it('explains OAuth failures with a safe fallback', () => {
    expect(oauthReasonMessage('workspace_in_use')).toContain('another Vireek account');
    expect(oauthReasonMessage('???')).toContain('Could not complete');
    expect(oauthReasonMessage(null)).toContain('Could not complete');
  });
  it('flags a connected Teams tenant with no installed channels', () => {
    expect(needsTeamsInstall(conn({ provider: 'teams' }), 0)).toBe(true);
    expect(needsTeamsInstall(conn({ provider: 'teams' }), 3)).toBe(false);
    expect(needsTeamsInstall(conn({ provider: 'slack' }), 0)).toBe(false);
    expect(needsTeamsInstall(undefined, 0)).toBe(false);
  });
});
