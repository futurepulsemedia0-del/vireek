import { describe, it, expect } from 'vitest';
import {
  oauthReasonMessage,
  formatRelativeSync,
  describeConnection,
  connectionTitle,
  sortConnections,
} from './microsoftCalendar';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('oauthReasonMessage', () => {
  it('returns the specific copy for a known reason', () => {
    expect(oauthReasonMessage('access_denied')).toMatch(/cancelled/i);
    expect(oauthReasonMessage('admin_consent_required')).toMatch(/administrator/i);
    expect(oauthReasonMessage('invalid_state')).toMatch(/expired/i);
  });

  it('falls back to a generic message for unknown, empty or missing reasons', () => {
    const generic = 'Could not connect Microsoft 365 — please try again.';
    expect(oauthReasonMessage('something_new')).toBe(generic);
    expect(oauthReasonMessage('')).toBe(generic);
    expect(oauthReasonMessage(null)).toBe(generic);
    expect(oauthReasonMessage(undefined)).toBe(generic);
  });
});

describe('formatRelativeSync', () => {
  it('handles missing and invalid timestamps', () => {
    expect(formatRelativeSync(null, NOW)).toBe('Not synced yet');
    expect(formatRelativeSync(undefined, NOW)).toBe('Not synced yet');
    expect(formatRelativeSync('not-a-date', NOW)).toBe('Not synced yet');
  });

  it('says "just now" under a minute, including timestamps in the future', () => {
    expect(formatRelativeSync(ago(30 * SEC), NOW)).toBe('Synced just now');
    expect(formatRelativeSync(ago(-5 * MIN), NOW)).toBe('Synced just now');
  });

  it('formats minutes, hours and days', () => {
    expect(formatRelativeSync(ago(5 * MIN), NOW)).toBe('Synced 5 min ago');
    expect(formatRelativeSync(ago(3 * HOUR), NOW)).toBe('Synced 3 h ago');
    expect(formatRelativeSync(ago(2 * DAY), NOW)).toBe('Synced 2 d ago');
  });
});

describe('describeConnection', () => {
  const base = {
    status: 'connected' as const,
    last_synced_at: ago(10 * MIN),
    last_error_code: null,
    consecutive_failures: 0,
  };

  it('reports a healthy connection with the last sync time', () => {
    expect(describeConnection(base, NOW)).toEqual({
      tone: 'ok',
      label: 'Connected',
      detail: 'Synced 10 min ago',
    });
  });

  it('reports a retrying connection when recent attempts failed', () => {
    const d = describeConnection({ ...base, consecutive_failures: 2 }, NOW);
    expect(d.tone).toBe('warn');
    expect(d.label).toBe('Retrying');
    expect(d.detail).toContain('(2)');
  });

  it('asks to reconnect when the token was revoked', () => {
    for (const code of ['token_revoked', 'provider_auth_failed']) {
      const d = describeConnection({ ...base, status: 'error', last_error_code: code }, NOW);
      expect(d.tone).toBe('error');
      expect(d.label).toBe('Needs reconnect');
      expect(d.detail).toMatch(/revoked or expired/i);
    }
  });

  it('asks to reconnect after repeated generic errors', () => {
    const d = describeConnection({ ...base, status: 'error', last_error_code: 'boom' }, NOW);
    expect(d.tone).toBe('error');
    expect(d.detail).toMatch(/repeated errors/i);
  });

  it('reports a disconnected connection as a warning', () => {
    expect(describeConnection({ ...base, status: 'disconnected' }, NOW)).toEqual({
      tone: 'warn',
      label: 'Disconnected',
      detail: 'Not syncing.',
    });
  });
});

describe('connectionTitle', () => {
  it('uses a fixed title for the office calendar', () => {
    expect(connectionTitle({ scope: 'office', team_member: null })).toBe('Office calendar');
  });

  it('prefers the trimmed technician name', () => {
    expect(
      connectionTitle({ scope: 'technician', team_member: { member_name: '  Sam Lee ', member_email: 'sam@x.com' } }),
    ).toBe('Sam Lee');
  });

  it('falls back to the email, then to a generic label', () => {
    expect(
      connectionTitle({ scope: 'technician', team_member: { member_name: '   ', member_email: 'sam@x.com' } }),
    ).toBe('sam@x.com');
    expect(connectionTitle({ scope: 'technician', team_member: null })).toBe('Technician calendar');
    expect(
      connectionTitle({ scope: 'technician', team_member: { member_name: null, member_email: null } }),
    ).toBe('Technician calendar');
  });
});

describe('sortConnections', () => {
  const tech = (name: string) => ({
    scope: 'technician' as const,
    team_member: { member_name: name, member_email: null },
  });
  const office = { scope: 'office' as const, team_member: null };

  it('puts the office first, then technicians alphabetically', () => {
    const sorted = sortConnections([tech('Zed'), tech('Amy'), office, tech('Mia')]);
    expect(sorted.map((c) => connectionTitle(c))).toEqual(['Office calendar', 'Amy', 'Mia', 'Zed']);
  });

  it('does not mutate the input array', () => {
    const input = [tech('Zed'), office];
    const copy = [...input];
    sortConnections(input);
    expect(input).toEqual(copy);
  });
});
