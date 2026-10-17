import { describe, it, expect } from 'vitest';
import {
  buildDefaults,
  buildEmbedSnippet,
  friendlySaveError,
  getWidgetStatus,
  hasErrors,
  normalizeDomain,
  normalizeSettings,
  parseDomains,
  readableTextColor,
  scheduleSummary,
  settingsEqual,
  validateSettings,
  type ChatWidgetSettings,
} from './chatWidget';

const base = (over: Partial<ChatWidgetSettings> = {}): ChatWidgetSettings => ({ ...buildDefaults(), timezone: 'America/New_York', ...over });

describe('domains', () => {
  it('normalizes URLs and hosts', () => {
    expect(normalizeDomain('https://www.Example.com/path?x=1')).toBe('example.com');
    expect(normalizeDomain('shop.example.co.uk:8080')).toBe('shop.example.co.uk');
    expect(normalizeDomain('localhost')).toBe('localhost');
  });
  it('rejects junk', () => {
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('-bad-.com')).toBeNull();
  });
  it('parses lists, dedupes and reports invalid entries', () => {
    expect(parseDomains('a.com, www.a.com\nb.org;;oops!')).toEqual({ domains: ['a.com', 'b.org'], invalid: ['oops!'] });
  });
});

describe('validateSettings', () => {
  it('accepts defaults', () => {
    expect(hasErrors(validateSettings(base()))).toBe(false);
  });
  it('flags bad color, empty copy, bad timezone', () => {
    const e = validateSettings(base({ brand_color: 'blue', title: ' ', greeting: '', timezone: 'Mars/Base' }));
    expect(Object.keys(e).sort()).toEqual(['brand_color', 'greeting', 'timezone', 'title']);
  });
  it('requires a valid weekly schedule when scheduled', () => {
    expect(validateSettings(base({ hours_mode: 'scheduled', schedule: {} })).schedule).toBeTruthy();
    expect(validateSettings(base({ hours_mode: 'scheduled', schedule: { '1': { open: '18:00', close: '09:00' } } })).schedule).toBeTruthy();
    expect(validateSettings(base({ hours_mode: 'scheduled', schedule: { '1': { open: '09:00', close: '17:00' } } })).schedule).toBeUndefined();
  });
  it('requires an assignee for assigned routing', () => {
    expect(validateSettings(base({ routing_mode: 'assigned_member' })).assigned_team_member_id).toBeTruthy();
    expect(validateSettings(base({ routing_mode: 'assigned_member', assigned_team_member_id: 'x' })).assigned_team_member_id).toBeUndefined();
  });
});

describe('getWidgetStatus', () => {
  const scheduled = base({ hours_mode: 'scheduled', schedule: { '1': { open: '09:00', close: '18:00' } } });
  it('is always online in always mode', () => {
    expect(getWidgetStatus(base())).toEqual({ online: true, visible: true, canSend: true });
  });
  it('evaluates in the widget time zone (Mon 14:00 UTC = 10:00 New York)', () => {
    expect(getWidgetStatus(scheduled, new Date('2027-03-01T15:00:00Z')).online).toBe(true);
    expect(getWidgetStatus(scheduled, new Date('2027-03-01T23:30:00Z')).online).toBe(false); // 18:30 NY
    expect(getWidgetStatus(scheduled, new Date('2027-03-02T15:00:00Z')).online).toBe(false); // Tuesday closed
  });
  it('applies the offline behavior', () => {
    const off = new Date('2027-03-02T15:00:00Z');
    expect(getWidgetStatus({ ...scheduled, offline_behavior: 'hide' }, off)).toEqual({ online: false, visible: false, canSend: false });
    expect(getWidgetStatus({ ...scheduled, offline_behavior: 'show_message' }, off)).toEqual({ online: false, visible: true, canSend: false });
    expect(getWidgetStatus({ ...scheduled, offline_behavior: 'collect_lead' }, off)).toEqual({ online: false, visible: true, canSend: true });
  });
});

describe('helpers', () => {
  it('picks readable text color', () => {
    expect(readableTextColor('#FFFFFF')).toBe('#111827');
    expect(readableTextColor('#111827')).toBe('#FFFFFF');
    expect(readableTextColor('#3448E8')).toBe('#FFFFFF');
  });
  it('summarizes schedules', () => {
    expect(scheduleSummary({ '1': { open: '09:00', close: '18:30' } })).toBe('Mon 9am–6:30pm');
    expect(scheduleSummary({})).toBe('Closed every day');
  });
  it('normalizes partial rows and compares settings', () => {
    const n = normalizeSettings({ title: 'Hi', allowed_domains: undefined });
    expect(n.title).toBe('Hi');
    expect(n.allowed_domains).toEqual([]);
    expect(settingsEqual(n, { ...n })).toBe(true);
    expect(settingsEqual(n, { ...n, enabled: !n.enabled })).toBe(false);
  });
  it('builds an escaped embed snippet', () => {
    const s = buildEmbedSnippet({ origin: 'https://vireek.com/', publicKey: 'cw_abc', supabaseUrl: 'https://x.supabase.co/', supabaseAnonKey: 'k"<' });
    expect(s).toContain('src="https://vireek.com/chat-widget.js"');
    expect(s).toContain('data-key="cw_abc"');
    expect(s).toContain('data-api="https://x.supabase.co"');
    expect(s).toContain('data-anon="k&quot;&lt;"');
  });
  it('maps error codes to friendly copy', () => {
    expect(friendlySaveError(new Error('CHAT_WIDGET_INVALID_ASSIGNEE: x'))).toContain('team member');
    expect(friendlySaveError({ message: 'new row violates row-level security policy' })).toContain('permission');
    expect(friendlySaveError(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
