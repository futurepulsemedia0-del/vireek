import { beforeEach, describe, expect, it, vi } from 'vitest';
import sitemapXml from '../../public/sitemap.xml?raw';
import appSource from '../App.tsx?raw';

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const insert = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc, functions: { invoke }, from: vi.fn(() => ({ insert })) } }));

import {
  buildEventIcs,
  buildEventsJsonLd,
  buildGoogleCalendarUrl,
  escapeIcsText,
  eventLocationLabel,
  fetchPublicEvents,
  filterByKind,
  foldIcsLine,
  formatEventWhen,
  getEventDayBadge,
  getEventPageUrl,
  groupEventsByMonth,
  isSafeHttpsUrl,
  registerForEvent,
  spotsLabel,
  splitEvents,
  subscribeToEventUpdates,
  validateRegistration,
  type PublicEvent,
  type RegistrationValues,
} from './events';

function makeEvent(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    slug: 'live-demo-oct',
    title: 'Live Demo: Never Miss Another Call',
    description: 'A 30-minute walkthrough, then live Q&A.',
    kind: 'demo',
    starts_at: '2026-10-14T17:00:00Z',
    ends_at: '2026-10-14T17:45:00Z',
    timezone: 'America/New_York',
    format: 'online',
    location_label: null,
    host_name: 'Ali Moradi, Founder',
    recording_url: null,
    registration_status: 'open',
    spots_left: null,
    ...overrides,
  };
}

const VALID: RegistrationValues = { name: 'Dana Smith', email: 'dana@example.com', marketingOptIn: false };

/** Every <url> must open and close once, never nest, and hold exactly one <loc>. */
function sitemapProblems(xml: string): string[] {
  const problems: string[] = [];
  let depth = 0;
  let locs = 0;
  for (const tag of xml.match(/<\/?url>|<loc>/g) ?? []) {
    if (tag === '<url>') {
      if (depth !== 0) problems.push('nested or unclosed <url>');
      depth = 1;
      locs = 0;
    } else if (tag === '<loc>') {
      locs += 1;
    } else {
      if (depth !== 1) problems.push('</url> without <url>');
      if (locs !== 1) problems.push(`<url> block with ${locs} <loc>`);
      depth = 0;
    }
  }
  if (depth !== 0) problems.push('unclosed <url> at end of file');
  return problems;
}

describe('site registration', () => {
  it('keeps sitemap.xml well-formed', () => {
    expect(sitemapProblems(sitemapXml)).toEqual([]);
  });
  it('lists /events in the sitemap', () => {
    expect(sitemapXml).toContain('<loc>https://vireek.com/events</loc>');
  });
  it('registers the /events route', () => {
    expect(appSource).toMatch(/path="\/events"/);
    expect(appSource).toContain("import('@/pages/EventsPage')");
  });
});

describe('formatting in a fixed timezone', () => {
  it('formats a same-day session', () => {
    expect(formatEventWhen('2026-10-14T17:00:00Z', '2026-10-14T17:45:00Z', 'UTC')).toBe('Wed, Oct 14 · 5:00 PM – 5:45 PM UTC');
    expect(formatEventWhen('2026-10-14T17:00:00Z', '2026-10-14T17:45:00Z', 'America/New_York')).toBe('Wed, Oct 14 · 1:00 PM – 1:45 PM EDT');
  });
  it('spells out the end date when a session crosses midnight', () => {
    expect(formatEventWhen('2026-10-14T23:30:00Z', '2026-10-15T00:30:00Z', 'UTC')).toBe('Wed, Oct 14 · 11:30 PM – Thu, Oct 15, 12:30 AM UTC');
  });
  it('builds the date badge', () => {
    expect(getEventDayBadge('2026-10-14T17:00:00Z', 'UTC')).toEqual({ month: 'OCT', day: '14' });
  });
});

describe('splitEvents / filterByKind / groupEventsByMonth', () => {
  const oct14 = makeEvent({ slug: 'oct-14' });
  const oct20 = makeEvent({ slug: 'oct-20', starts_at: '2026-10-20T17:00:00Z', ends_at: '2026-10-20T18:00:00Z', kind: 'workshop' });
  const nov3 = makeEvent({ slug: 'nov-3', starts_at: '2026-11-03T17:00:00Z', ends_at: '2026-11-03T18:00:00Z' });
  const sep1 = makeEvent({ slug: 'sep-1', starts_at: '2026-09-01T17:00:00Z', ends_at: '2026-09-01T18:00:00Z', registration_status: 'ended' });
  const aug1 = makeEvent({ slug: 'aug-1', starts_at: '2026-08-01T17:00:00Z', ends_at: '2026-08-01T18:00:00Z', registration_status: 'ended' });

  it('splits by server status, upcoming ascending and past newest first', () => {
    const { upcoming, past } = splitEvents([nov3, aug1, oct14, sep1, oct20]);
    expect(upcoming.map((e) => e.slug)).toEqual(['oct-14', 'oct-20', 'nov-3']);
    expect(past.map((e) => e.slug)).toEqual(['sep-1', 'aug-1']);
  });
  it('filters by kind', () => {
    expect(filterByKind([oct14, oct20, nov3], 'workshop').map((e) => e.slug)).toEqual(['oct-20']);
    expect(filterByKind([oct14, oct20, nov3], 'all')).toHaveLength(3);
  });
  it('groups consecutive events by month', () => {
    const groups = groupEventsByMonth([oct14, oct20, nov3], 'UTC');
    expect(groups.map((g) => [g.key, g.label, g.events.length])).toEqual([
      ['2026-10', 'October 2026', 2],
      ['2026-11', 'November 2026', 1],
    ]);
  });
});

describe('labels', () => {
  it('describes where a session happens', () => {
    expect(eventLocationLabel({ format: 'online', location_label: null })).toBe('Online');
    expect(eventLocationLabel({ format: 'in_person', location_label: 'Austin, TX' })).toBe('Austin, TX');
    expect(eventLocationLabel({ format: 'in_person', location_label: null })).toBe('In person');
    expect(eventLocationLabel({ format: 'hybrid', location_label: 'Austin, TX' })).toBe('Austin, TX + online');
  });
  it('only shows scarcity when it is real and small', () => {
    expect(spotsLabel('open', null)).toBeNull();
    expect(spotsLabel('open', 50)).toBeNull();
    expect(spotsLabel('open', 10)).toBe('10 spots left');
    expect(spotsLabel('open', 1)).toBe('1 spot left');
    expect(spotsLabel('full', 0)).toBe('Full');
    expect(spotsLabel('closed', null)).toBe('Registration closed');
    expect(spotsLabel('ended', null)).toBe('Ended');
  });
  it('accepts only https urls', () => {
    expect(isSafeHttpsUrl('https://zoom.us/j/123')).toBe(true);
    expect(isSafeHttpsUrl('http://zoom.us/j/123')).toBe(false);
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpsUrl(null)).toBe(false);
  });
});

describe('calendar links and files', () => {
  const event = makeEvent({ title: 'Live Demo, Q&A; Part 1' });

  it('builds a Google Calendar link in UTC', () => {
    const url = buildGoogleCalendarUrl(event, getEventPageUrl(event.slug));
    expect(url.startsWith('https://calendar.google.com/calendar/render?')).toBe(true);
    expect(url).toContain('dates=20261014T170000Z%2F20261014T174500Z');
    expect(url).toContain('action=TEMPLATE');
  });

  it('escapes ICS text', () => {
    expect(escapeIcsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const folded = foldIcsLine('DESCRIPTION:' + 'é'.repeat(80));
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe('DESCRIPTION:' + 'é'.repeat(80));
  });

  it('builds a valid ICS document', () => {
    const ics = buildEventIcs(event, getEventPageUrl(event.slug), new Date('2026-10-08T12:00:00Z'));
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('UID:live-demo-oct@vireek.com');
    expect(ics).toContain('DTSTAMP:20261008T120000Z');
    expect(ics).toContain('DTSTART:20261014T170000Z');
    expect(ics).toContain('DTEND:20261014T174500Z');
    expect(ics).toContain('SUMMARY:Live Demo\\, Q&A\\; Part 1');
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it('includes the join link only when it is provided', () => {
    const without = buildEventIcs(event, getEventPageUrl(event.slug), new Date('2026-10-08T12:00:00Z'));
    const withJoin = buildEventIcs(event, getEventPageUrl(event.slug), new Date('2026-10-08T12:00:00Z'), 'https://zoom.us/j/123');
    expect(without).not.toContain('zoom.us');
    expect(withJoin.replace(/\r\n /g, '')).toContain('Join: https://zoom.us/j/123');
  });
});

describe('buildEventsJsonLd', () => {
  it('describes upcoming sessions and skips ended ones', () => {
    const schema = buildEventsJsonLd([makeEvent(), makeEvent({ slug: 'old', registration_status: 'ended' })]);
    expect(schema).toHaveLength(1);
    expect(schema[0]).toMatchObject({
      '@type': 'Event',
      name: 'Live Demo: Never Miss Another Call',
      eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
      startDate: '2026-10-14T17:00:00.000Z',
      offers: { price: '0', availability: 'https://schema.org/InStock' },
    });
  });
  it('marks full events sold out and omits offers when registration is closed', () => {
    const [full] = buildEventsJsonLd([makeEvent({ registration_status: 'full' })]);
    const [closed] = buildEventsJsonLd([makeEvent({ registration_status: 'closed' })]);
    expect(full.offers).toMatchObject({ availability: 'https://schema.org/SoldOut' });
    expect(closed.offers).toBeUndefined();
  });
  it('uses a place for in-person and both for hybrid sessions', () => {
    const [inPerson] = buildEventsJsonLd([makeEvent({ format: 'in_person', location_label: 'Austin, TX' })]);
    const [hybrid] = buildEventsJsonLd([makeEvent({ format: 'hybrid', location_label: 'Austin, TX' })]);
    expect(inPerson.location).toMatchObject({ '@type': 'Place', name: 'Austin, TX' });
    expect(hybrid.eventAttendanceMode).toBe('https://schema.org/MixedEventAttendanceMode');
    expect(Array.isArray(hybrid.location)).toBe(true);
  });
});

describe('validateRegistration', () => {
  it('passes a complete form', () => {
    expect(validateRegistration(VALID)).toEqual({});
  });
  it('flags a bad name or email', () => {
    expect(validateRegistration({ ...VALID, name: 'D' }).name).toBeDefined();
    expect(validateRegistration({ ...VALID, name: 'x'.repeat(101) }).name).toBeDefined();
    expect(validateRegistration({ ...VALID, email: '' }).email).toBeDefined();
    expect(validateRegistration({ ...VALID, email: 'nope' }).email).toBeDefined();
  });
});

describe('fetchPublicEvents', () => {
  beforeEach(() => rpc.mockReset());

  it('returns cleaned events and drops malformed rows', async () => {
    rpc.mockResolvedValue({
      data: [
        { ...makeEvent(), recording_url: 'http://insecure.example.com', spots_left: 4 },
        { ...makeEvent({ slug: 'bad-date' }), starts_at: 'not a date' },
        { ...makeEvent({ slug: 'bad-kind' }), kind: 'party' },
        null,
      ],
      error: null,
    });
    const result = await fetchPublicEvents();
    expect(rpc).toHaveBeenCalledWith('list_public_events');
    expect(result.state).toBe('ok');
    if (result.state === 'ok') {
      expect(result.events.map((e) => e.slug)).toEqual(['live-demo-oct']);
      expect(result.events[0].recording_url).toBeNull();
      expect(result.events[0].spots_left).toBe(4);
    }
  });
  it('treats an empty or missing list as no events', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await fetchPublicEvents()).toEqual({ state: 'ok', events: [] });
  });
  it('returns error when the request fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchPublicEvents()).toEqual({ state: 'error' });
  });
});

describe('registerForEvent', () => {
  beforeEach(() => invoke.mockReset());

  it('rejects an invalid form without calling the server', async () => {
    expect(await registerForEvent('live-demo-oct', { ...VALID, email: 'bad' })).toEqual({ ok: false, reason: 'invalid' });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('sends trimmed values and returns the join link', async () => {
    invoke.mockResolvedValue({ data: { status: 'registered', join_url: 'https://zoom.us/j/123', email_sent: true }, error: null });
    const result = await registerForEvent('live-demo-oct', { name: ' Dana Smith ', email: ' dana@example.com ', marketingOptIn: true });
    expect(result).toEqual({ ok: true, alreadyRegistered: false, joinUrl: 'https://zoom.us/j/123', emailSent: true });
    expect(invoke).toHaveBeenCalledWith('event-register', {
      body: { event_slug: 'live-demo-oct', name: 'Dana Smith', email: 'dana@example.com', marketing_opt_in: true, website: '' },
    });
  });
  it('reports a duplicate registration and drops unsafe join links', async () => {
    invoke.mockResolvedValue({ data: { status: 'already_registered', join_url: 'http://zoom.us/j/123', email_sent: false }, error: null });
    expect(await registerForEvent('live-demo-oct', VALID)).toEqual({ ok: true, alreadyRegistered: true, joinUrl: null, emailSent: false });
  });
  it('maps known server reasons', async () => {
    for (const reason of ['full', 'closed', 'rate_limited', 'not_found'] as const) {
      invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ reason }) } } });
      expect(await registerForEvent('live-demo-oct', VALID)).toEqual({ ok: false, reason });
    }
  });
  it('falls back to a generic error', async () => {
    invoke.mockResolvedValue({ data: { status: 'weird' }, error: null });
    expect(await registerForEvent('live-demo-oct', VALID)).toEqual({ ok: false, reason: 'error' });
    invoke.mockResolvedValue({ data: null, error: new Error('network') });
    expect(await registerForEvent('live-demo-oct', VALID)).toEqual({ ok: false, reason: 'error' });
  });
});

describe('subscribeToEventUpdates', () => {
  beforeEach(() => insert.mockReset());

  it('rejects a malformed email without calling the server', async () => {
    expect(await subscribeToEventUpdates('nope')).toBe('invalid');
    expect(insert).not.toHaveBeenCalled();
  });
  it('subscribes with the events source', async () => {
    insert.mockResolvedValue({ error: null });
    expect(await subscribeToEventUpdates(' Dana@Example.com ')).toBe('ok');
    expect(insert).toHaveBeenCalledWith({ email: 'dana@example.com', source: 'events' });
  });
  it('treats an existing subscriber as success but surfaces real errors', async () => {
    insert.mockResolvedValue({ error: { code: '23505' } });
    expect(await subscribeToEventUpdates('dana@example.com')).toBe('ok');
    insert.mockResolvedValue({ error: { code: '500' } });
    expect(await subscribeToEventUpdates('dana@example.com')).toBe('error');
  });
});
