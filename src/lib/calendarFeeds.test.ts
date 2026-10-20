// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildCalendar, buildEvent, calendarEtag, clampDuration, escapeText, etagMatches, feedCalendarName, feedFileName,
  feedWindow, foldLine, icsDate, isExcludedStatus, isValidFeedToken, jobWindow, parseFeedPath, shouldRecordAccess,
  type FeedJob,
} from '../../supabase/functions/_shared/calendar-feed/engine';
import {
  buildFeedRows, describeFeed, feedErrorMessage, feedHttpsUrl, feedWebcalUrl, formatRelativeTime, googleSubscribeUrl,
  maskFeedUrl, outlookSubscribeUrl, parseOverview, type CalendarFeed,
} from '@/lib/calendarFeeds';

const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);
const NOW = new Date('2027-03-01T12:00:00.000Z');
const TECH = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const job = (o: Partial<FeedJob> = {}): FeedJob => ({
  id: '11111111-2222-3333-4444-555555555555', customer_name: 'Ana Silva', customer_phone: '+1 555 0100',
  service_type: 'AC repair', address: '12 Oak St, Austin', scheduled_datetime: '2027-03-02T15:00:00.000Z',
  duration_minutes: 90, assigned_technician_id: TECH, job_status: 'scheduled', notes: null, ...o,
});

const opts = { detail: 'full' as const, scope: 'technician' as const, appOrigin: 'https://vireek.com/', stamp: NOW };
const unfold = (s: string) => s.replace(/\r\n /g, '');

const feed = (o: Partial<CalendarFeed> = {}): CalendarFeed => ({
  id: 'f1', user_id: 'u1', scope: 'business', team_member_id: null, token: TOKEN, enabled: true, detail_level: 'full',
  created_at: '2027-02-01T00:00:00Z', rotated_at: null, last_accessed_at: null, access_count: 0, ...o,
});

describe('tokens and paths', () => {
  it('accepts only 64 lowercase hex characters', () => {
    expect(isValidFeedToken(TOKEN)).toBe(true);
    expect(isValidFeedToken(TOKEN.toUpperCase())).toBe(false);
    expect(isValidFeedToken(TOKEN.slice(1))).toBe(false);
    expect(isValidFeedToken(`${TOKEN}0`)).toBe(false);
    expect(isValidFeedToken('../etc/passwd')).toBe(false);
    expect(isValidFeedToken(null)).toBe(false);
  });
  it('extracts the token from supported paths and rejects the rest', () => {
    expect(parseFeedPath(`/calendar-feed/${TOKEN}.ics`)).toBe(TOKEN);
    expect(parseFeedPath(`/${TOKEN}.ICS`)).toBe(TOKEN);
    expect(parseFeedPath(`/calendar-feed/${TOKEN}`)).toBe(TOKEN);
    expect(parseFeedPath('/calendar-feed/')).toBeNull();
    expect(parseFeedPath('/calendar-feed/nope.ics')).toBeNull();
    expect(parseFeedPath(`/a/b/${TOKEN}.ics`)).toBeNull();
  });
});

describe('ICS text rules', () => {
  it('escapes backslash, semicolon, comma and newlines, and strips control characters', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    expect(escapeText('x\r\ny')).toBe('x\\ny');
    expect(escapeText('bad\u0000\u0007name')).toBe('badname');
  });
  it('cannot be used to inject extra properties', () => {
    const lines = buildEvent(job({ customer_name: 'Eve\r\nATTENDEE:mailto:evil@x.com' }), opts)!;
    expect(lines.some((l) => l.startsWith('ATTENDEE'))).toBe(false);
    expect(lines.find((l) => l.startsWith('SUMMARY'))).toContain('\\nATTENDEE:mailto:evil@x.com');
  });
  it('folds long lines at 75 octets without splitting multi-byte characters', () => {
    const long = `SUMMARY:${'é'.repeat(80)}`;
    const folded = foldLine(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(unfold(folded)).toBe(long);
    expect(foldLine('SHORT')).toBe('SHORT');
  });
  it('formats UTC date-times', () => {
    expect(icsDate(new Date('2027-03-02T15:00:00.000Z'))).toBe('20270302T150000Z');
  });
});

describe('job windows', () => {
  it('clamps durations and defaults to 60', () => {
    expect(clampDuration(null)).toBe(60);
    expect(clampDuration(5)).toBe(15);
    expect(clampDuration(99999)).toBe(720);
    expect(jobWindow(job())?.end.toISOString()).toBe('2027-03-02T16:30:00.000Z');
    expect(jobWindow(job({ scheduled_datetime: null }))).toBeNull();
    expect(jobWindow(job({ scheduled_datetime: 'garbage' }))).toBeNull();
  });
  it('covers 30 days back and 180 days ahead', () => {
    const w = feedWindow(NOW);
    expect(w.from.toISOString()).toBe('2027-01-30T12:00:00.000Z');
    expect(w.to.toISOString()).toBe('2027-08-28T12:00:00.000Z');
  });
  it('excludes cancelled and no-show jobs', () => {
    expect(isExcludedStatus('cancelled')).toBe(true);
    expect(isExcludedStatus('Canceled')).toBe(true);
    expect(isExcludedStatus('no_show')).toBe(true);
    expect(isExcludedStatus('scheduled')).toBe(false);
    expect(buildEvent(job({ job_status: 'cancelled' }), opts)).toBeNull();
    expect(buildEvent(job({ scheduled_datetime: null }), opts)).toBeNull();
  });
});

describe('events', () => {
  it('builds a full-detail event with location, description and a deep link', () => {
    const lines = buildEvent(job({ notes: 'Gate code 1234; dog inside' }), opts)!;
    const text = unfold(lines.join('\r\n'));
    expect(lines[0]).toBe('BEGIN:VEVENT');
    expect(lines[lines.length - 1]).toBe('END:VEVENT');
    expect(text).toContain('UID:11111111-2222-3333-4444-555555555555@feeds.vireek.com');
    expect(text).toContain('DTSTART:20270302T150000Z');
    expect(text).toContain('DTEND:20270302T163000Z');
    expect(text).toContain('SUMMARY:AC repair — Ana Silva');
    expect(text).toContain('LOCATION:12 Oak St\\, Austin');
    expect(text).toContain('Phone: +1 555 0100');
    expect(text).toContain('Gate code 1234\\; dog inside');
    expect(text).toContain('URL:https://vireek.com/dashboard/jobs/11111111-2222-3333-4444-555555555555');
  });
  it('"busy" detail leaks no customer data', () => {
    const text = buildEvent(job({ notes: 'secret note', customer_phone: '+1 777 0199' }), { ...opts, detail: 'busy' })!.join('\n');
    expect(text).toContain('SUMMARY:Vireek job');
    for (const leak of ['Ana', 'Silva', '777', 'Oak', 'secret', 'DESCRIPTION', 'LOCATION', 'URL:']) expect(text).not.toContain(leak);
    expect(text).toContain('DTSTART:20270302T150000Z');
  });
  it('shows the technician only on the business feed', () => {
    expect(buildEvent(job(), { ...opts, scope: 'business', technicianName: 'Tom Tech' })!.join('\n')).toContain('Technician: Tom Tech');
    expect(buildEvent(job(), { ...opts, scope: 'technician', technicianName: 'Tom Tech' })!.join('\n')).not.toContain('Technician:');
  });
  it('truncates very long notes', () => {
    const text = buildEvent(job({ notes: 'x'.repeat(5000) }), opts)!.join('');
    expect(text.length).toBeLessThan(2500);
  });
});

describe('calendar', () => {
  const build = (jobs: FeedJob[]) =>
    buildCalendar({ name: 'Tom, Tech — Acme (Vireek)', jobs, event: opts });

  it('produces a valid, CRLF-terminated VCALENDAR with refresh hints', () => {
    const ics = build([job()]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).toContain('X-WR-CALNAME:Tom\\, Tech — Acme (Vireek)');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT15M');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
  it('sorts events by start time and omits excluded jobs', () => {
    const ics = build([
      job({ id: 'late', scheduled_datetime: '2027-03-05T10:00:00Z' }),
      job({ id: 'gone', job_status: 'cancelled' }),
      job({ id: 'early', scheduled_datetime: '2027-03-03T10:00:00Z' }),
    ]);
    expect(ics.indexOf('UID:early@')).toBeLessThan(ics.indexOf('UID:late@'));
    expect(ics).not.toContain('UID:gone@');
  });
  it('is empty-calendar safe', () => {
    const ics = build([]);
    expect(ics).not.toContain('BEGIN:VEVENT');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
  it('keeps the ETag stable when only DTSTAMP changes, and changes it when a job changes', async () => {
    const a = buildCalendar({ name: 'n', jobs: [job()], event: { ...opts, stamp: NOW } });
    const b = buildCalendar({ name: 'n', jobs: [job()], event: { ...opts, stamp: new Date(NOW.getTime() + 600_000) } });
    const c = buildCalendar({ name: 'n', jobs: [job({ scheduled_datetime: '2027-03-02T16:00:00Z' })], event: opts });
    expect(a).not.toBe(b);
    expect(await calendarEtag(a)).toBe(await calendarEtag(b));
    expect(await calendarEtag(a)).not.toBe(await calendarEtag(c));
    expect(await calendarEtag(a)).toMatch(/^"[0-9a-f]{32}"$/);
  });
  it('matches If-None-Match per RFC 7232 weak comparison', () => {
    const tag = '"abc"';
    expect(etagMatches('"abc"', tag)).toBe(true);
    expect(etagMatches('W/"abc"', tag)).toBe(true);
    expect(etagMatches('"x", "abc"', tag)).toBe(true);
    expect(etagMatches('*', tag)).toBe(true);
    expect(etagMatches('"other"', tag)).toBe(false);
    expect(etagMatches(null, tag)).toBe(false);
  });
  it('names calendars and files safely', () => {
    expect(feedCalendarName('technician', 'Acme HVAC', 'Tom Tech')).toBe('Tom Tech — Acme HVAC (Vireek)');
    expect(feedCalendarName('business', 'Acme HVAC', null)).toBe('Acme HVAC jobs (Vireek)');
    expect(feedCalendarName('business', null, null)).toBe('Business jobs (Vireek)');
    expect(feedFileName('Tom Tech — Acme/HVAC (Vireek)')).toBe('tom-tech-acmehvac-vireek.ics');
    expect(feedFileName('###')).toBe('vireek-calendar.ics');
  });
  it('throttles access recording', () => {
    expect(shouldRecordAccess(null, NOW)).toBe(true);
    expect(shouldRecordAccess(new Date(NOW.getTime() - 60_000).toISOString(), NOW)).toBe(false);
    expect(shouldRecordAccess(new Date(NOW.getTime() - 6 * 60_000).toISOString(), NOW)).toBe(true);
    expect(shouldRecordAccess('garbage', NOW)).toBe(true);
  });
});

describe('client helpers', () => {
  it('builds subscription URLs for each calendar app', () => {
    const https = feedHttpsUrl('https://proj.supabase.co/', TOKEN);
    expect(https).toBe(`https://proj.supabase.co/functions/v1/calendar-feed/${TOKEN}.ics`);
    expect(feedWebcalUrl(https)).toBe(`webcal://proj.supabase.co/functions/v1/calendar-feed/${TOKEN}.ics`);
    expect(googleSubscribeUrl(https)).toBe(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedWebcalUrl(https))}`);
    const personal = new URL(outlookSubscribeUrl(https, 'Tom & Co'));
    expect(personal.host).toBe('outlook.live.com');
    expect(personal.searchParams.get('url')).toBe(https);
    expect(personal.searchParams.get('name')).toBe('Tom & Co');
    expect(new URL(outlookSubscribeUrl(https, 'x', 'work')).host).toBe('outlook.office.com');
  });
  it('masks the secret but keeps the shape', () => {
    const masked = maskFeedUrl(feedHttpsUrl('https://p.supabase.co', TOKEN));
    expect(masked).toContain('/aaaa');
    expect(masked).toContain('bbbb.ics');
    expect(masked).not.toContain(TOKEN);
  });
  it('formats relative times', () => {
    expect(formatRelativeTime(null, NOW)).toBe('never');
    expect(formatRelativeTime(NOW.toISOString(), NOW)).toBe('just now');
    expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago');
    expect(formatRelativeTime(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW)).toBe('3 h ago');
    expect(formatRelativeTime(new Date(NOW.getTime() - 86_400_000).toISOString(), NOW)).toBe('1 day ago');
  });
  it('describes feed state', () => {
    expect(describeFeed(null).label).toBe('Not set up');
    expect(describeFeed(feed({ enabled: false })).label).toBe('Paused');
    expect(describeFeed(feed()).label).toBe('Waiting for first sync');
    const live = describeFeed(feed({ last_accessed_at: new Date(NOW.getTime() - 120_000).toISOString() }), NOW);
    expect(live).toMatchObject({ tone: 'ok', label: 'Active', detail: 'Last synced 2 min ago' });
  });
  it('maps RPC errors to actionable copy', () => {
    expect(feedErrorMessage({ code: '42501' }, 'x')).toContain("doesn't allow");
    expect(feedErrorMessage({ message: 'feed_not_found' }, 'x')).toContain('no longer exists');
    expect(feedErrorMessage({ code: '500' }, 'fallback')).toBe('fallback');
    expect(feedErrorMessage(null, 'fallback')).toBe('fallback');
  });
});

describe('overview parsing and rows', () => {
  const raw = {
    can_manage: true, my_member_id: null,
    members: [{ id: 'm2', name: 'Zed', email: 'z@x.com', role: 'technician' }, { id: 'm1', name: null, email: 'amy@x.com', role: 'technician' }, { bad: true }],
    feeds: [
      { ...feed(), scope: 'business' },
      { ...feed({ id: 'f2', scope: 'technician', team_member_id: 'm1', token: 'c'.repeat(64) }) },
      { id: 'f3', token: 'short', scope: 'business' },
      null,
    ],
  };
  it('drops malformed rows and tolerates garbage', () => {
    const o = parseOverview(raw);
    expect(o.feeds.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(o.members.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(parseOverview(null)).toEqual({ can_manage: false, my_member_id: null, members: [], feeds: [] });
  });
  it('gives managers a business row plus a sorted row per member', () => {
    const rows = buildFeedRows(parseOverview(raw));
    expect(rows.map((r) => r.key)).toEqual(['business', 'tech-m1', 'tech-m2']);
    expect(rows[0].feed?.id).toBe('f1');
    expect(rows[1].title).toBe('amy@x.com');
    expect(rows[1].feed?.id).toBe('f2');
    expect(rows[2].feed).toBeNull();
  });
  it('gives a technician only his own row, even before a feed exists', () => {
    const o = parseOverview({ can_manage: false, my_member_id: 'm9', members: [], feeds: [] });
    expect(buildFeedRows(o)).toEqual([
      { key: 'tech-m9', scope: 'technician', title: 'My schedule', subtitle: 'Jobs assigned to you', memberId: 'm9', feed: null },
    ]);
    expect(buildFeedRows(parseOverview({ can_manage: false, my_member_id: null }))).toEqual([]);
  });
});
