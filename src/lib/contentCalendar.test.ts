import { describe, it, expect } from 'vitest';
import {
  EMPTY_DRAFT,
  addMonths,
  buildEntries,
  buildIcs,
  campaignEvents,
  detectWeekStart,
  canTransition,
  charCount,
  duplicateDraft,
  filterCampaigns,
  filterItems,
  groupByDay,
  isDraggable,
  isOverdue,
  isoToLocalInput,
  localInputToIso,
  monthGrid,
  moveToDay,
  parseDateKey,
  parseTags,
  rangeLabel,
  selectableStatuses,
  shiftAnchor,
  summarize,
  toDateKey,
  toRowPayload,
  transitionPatch,
  validateDraft,
  visibleRange,
  weekDays,
  NO_FILTERS,
  type ContentItem,
  type ItemDraft,
} from './contentCalendar';

// Local-time constructors keep these tests timezone-agnostic.
const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 9, 26, 12, 0); // Mon 26 Oct 2026, 12:00 local

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'i1',
    user_id: 'owner',
    title: 'Fall tune-up promo',
    body: 'Book your tune-up',
    channel: 'facebook',
    content_type: 'post',
    status: 'draft',
    scheduled_at: null,
    published_at: null,
    tags: [],
    link_url: null,
    notes: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const draft = (over: Partial<ItemDraft> = {}): ItemDraft => ({ ...EMPTY_DRAFT, title: 'Hello', ...over });

describe('dates', () => {
  it('parses strict date keys only', () => {
    expect(toDateKey(parseDateKey('2026-02-28') as Date)).toBe('2026-02-28');
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('2026-2-3')).toBeNull();
    expect(parseDateKey('nope')).toBeNull();
    expect(parseDateKey(null)).toBeNull();
  });

  it('clamps month arithmetic instead of overflowing', () => {
    expect(toDateKey(addMonths(new Date(2026, 0, 31), 1))).toBe('2026-02-28');
    expect(toDateKey(addMonths(new Date(2028, 0, 31), 1))).toBe('2028-02-29');
    expect(toDateKey(addMonths(new Date(2026, 11, 15), 1))).toBe('2027-01-15');
    expect(toDateKey(addMonths(new Date(2026, 0, 15), -1))).toBe('2025-12-15');
  });

  it('builds a 6x7 month grid honouring week start', () => {
    const sun = monthGrid(new Date(2026, 9, 15), 0);
    expect(sun).toHaveLength(42);
    expect(sun[0].date.getDay()).toBe(0);
    expect(sun.filter((d) => d.inMonth)).toHaveLength(31);
    const mon = monthGrid(new Date(2026, 9, 15), 1);
    expect(mon[0].date.getDay()).toBe(1);
    expect(mon.some((d) => d.key === '2026-10-01')).toBe(true);
  });

  it('computes week days, ranges, navigation and labels', () => {
    const days = weekDays(new Date(2026, 9, 28), 0);
    expect(days.map(toDateKey)).toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
    const w = visibleRange('week', new Date(2026, 9, 28), 0);
    expect(toDateKey(w.start)).toBe('2026-10-25');
    expect(toDateKey(w.end)).toBe('2026-11-01');
    const a = visibleRange('agenda', new Date(2026, 9, 28), 0);
    expect(toDateKey(a.start)).toBe('2026-10-01');
    expect(toDateKey(a.end)).toBe('2026-11-01');
    expect(toDateKey(shiftAnchor('week', new Date(2026, 9, 28), 1))).toBe('2026-11-04');
    expect(toDateKey(shiftAnchor('month', new Date(2026, 9, 31), 1))).toBe('2026-11-30');
    expect(rangeLabel('month', new Date(2026, 9, 28))).toContain('2026');
    expect(rangeLabel('week', new Date(2026, 9, 28))).toMatch(/Oct 25.*31, 2026/);
  });

  it('round-trips datetime-local values and rejects garbage', () => {
    const iso = at(2026, 11, 3, 14, 30);
    expect(isoToLocalInput(iso)).toBe('2026-11-03T14:30');
    expect(localInputToIso('2026-11-03T14:30')).toBe(iso);
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('2026-13-40T99:99')).toBeNull();
    expect(isoToLocalInput(null)).toBe('');
  });

  it('keeps time of day when moving to another day, defaulting to 09:00', () => {
    const moved = new Date(moveToDay(at(2026, 10, 27, 15, 45), new Date(2026, 10, 2)));
    expect([moved.getFullYear(), moved.getMonth(), moved.getDate(), moved.getHours(), moved.getMinutes()]).toEqual([2026, 10, 2, 15, 45]);
    const def = new Date(moveToDay(null, new Date(2026, 10, 2)));
    expect([def.getDate(), def.getHours(), def.getMinutes()]).toEqual([2, 9, 0]);
  });
});

describe('week start detection', () => {
  it('never throws and only returns Sunday or Monday', () => {
    expect([0, 1]).toContain(detectWeekStart('en-US'));
    expect([0, 1]).toContain(detectWeekStart('de-DE'));
    expect(detectWeekStart('not a locale!!')).toBe(0);
  });
});

describe('status workflow', () => {
  it('only allows legal transitions and treats published as final', () => {
    expect(canTransition('draft', 'in_review')).toBe(true);
    expect(canTransition('idea', 'published')).toBe(false);
    expect(canTransition('published', 'draft')).toBe(false);
    expect(canTransition('cancelled', 'draft')).toBe(true);
    expect(selectableStatuses('published')).toEqual(['published']);
    expect(selectableStatuses(null)).toContain('scheduled');
    expect(selectableStatuses(null)).not.toContain('published');
  });

  it('builds transition patches with published_at, and blocks scheduling without a future time', () => {
    const pub = transitionPatch({ status: 'scheduled', scheduled_at: at(2026, 10, 27) }, 'published', NOW);
    expect(pub).toEqual({ ok: true, patch: { status: 'published', published_at: NOW.toISOString() } });
    expect(transitionPatch({ status: 'draft', scheduled_at: null }, 'scheduled', NOW).ok).toBe(false);
    expect(transitionPatch({ status: 'draft', scheduled_at: at(2026, 10, 1) }, 'scheduled', NOW).ok).toBe(false);
    expect(transitionPatch({ status: 'draft', scheduled_at: at(2026, 11, 1) }, 'scheduled', NOW).ok).toBe(true);
    expect(transitionPatch({ status: 'idea', scheduled_at: null }, 'published', NOW).ok).toBe(false);
  });

  it('flags only live scheduled/approved items in the past as overdue', () => {
    expect(isOverdue(item({ status: 'scheduled', scheduled_at: at(2026, 10, 20) }), NOW)).toBe(true);
    expect(isOverdue(item({ status: 'approved', scheduled_at: at(2026, 10, 20) }), NOW)).toBe(true);
    expect(isOverdue(item({ status: 'published', scheduled_at: at(2026, 10, 20) }), NOW)).toBe(false);
    expect(isOverdue(item({ status: 'scheduled', scheduled_at: at(2026, 10, 30) }), NOW)).toBe(false);
    expect(isDraggable('scheduled')).toBe(true);
    expect(isDraggable('published')).toBe(false);
  });
});

describe('validation', () => {
  it('requires a title and enforces per-channel limits', () => {
    expect(validateDraft(draft({ title: '  ' })).title).toBeTruthy();
    expect(validateDraft(draft({ channel: 'x', body: 'a'.repeat(280) })).body).toBeUndefined();
    expect(validateDraft(draft({ channel: 'x', body: 'a'.repeat(281) })).body).toMatch(/280/);
    expect(validateDraft(draft({ channel: 'facebook', body: 'a'.repeat(5001) })).body).toBeTruthy();
  });

  it('counts characters like Postgres (code points), so emoji do not double count', () => {
    expect(charCount('👍👍')).toBe(2);
    expect(validateDraft(draft({ channel: 'x', body: '👍'.repeat(280) })).body).toBeUndefined();
  });

  it('validates links and tags', () => {
    expect(validateDraft(draft({ link_url: 'javascript:alert(1)' })).link_url).toBeTruthy();
    expect(validateDraft(draft({ link_url: 'example.com' })).link_url).toBeTruthy();
    expect(validateDraft(draft({ link_url: 'https://example.com/offer' })).link_url).toBeUndefined();
    expect(validateDraft(draft({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(',') })).tags).toBeTruthy();
    expect(validateDraft(draft({ tags: 'a'.repeat(31) })).tags).toBeTruthy();
    expect(parseTags('#Spring, spring ,  Sale\n#sale, ')).toEqual(['Spring', 'Sale']);
  });

  it('requires a future time to schedule, but lets an overdue item keep its time', () => {
    expect(validateDraft(draft({ status: 'scheduled' }), NOW).scheduled_at).toMatch(/date and time/);
    expect(validateDraft(draft({ status: 'scheduled', scheduled_at: at(2026, 10, 1) }), NOW).scheduled_at).toMatch(/future/);
    expect(validateDraft(draft({ status: 'scheduled', scheduled_at: at(2026, 11, 1) }), NOW).scheduled_at).toBeUndefined();
    const past = at(2026, 10, 1);
    expect(validateDraft(draft({ status: 'scheduled', scheduled_at: past }), NOW, { status: 'scheduled', scheduled_at: past }).scheduled_at).toBeUndefined();
    expect(validateDraft(draft({ scheduled_at: 'garbage' }), NOW).scheduled_at).toBeTruthy();
  });

  it('builds a clean row payload', () => {
    const p = toRowPayload(draft({ title: '  Hi  ', tags: '#a, b', link_url: ' ', notes: '', status: 'published' }), NOW);
    expect(p).toMatchObject({ title: 'Hi', tags: ['a', 'b'], link_url: null, notes: null, status: 'published', published_at: NOW.toISOString() });
    expect(toRowPayload(draft({ status: 'draft' }), NOW).published_at).toBeNull();
    expect(toRowPayload(draft({ status: 'published' }), NOW, '2026-01-01T00:00:00Z').published_at).toBe('2026-01-01T00:00:00Z');
  });

  it('duplicates as an unscheduled draft and keeps the title within the limit', () => {
    const d = duplicateDraft(item({ status: 'published', scheduled_at: at(2026, 10, 1), title: 'x'.repeat(160) }));
    expect(d.status).toBe('draft');
    expect(d.scheduled_at).toBeNull();
    expect(charCount(d.title)).toBeLessThanOrEqual(160);
  });
});

describe('grouping, filtering and overlay', () => {
  const items = [
    item({ id: 'a', title: 'Beta', channel: 'instagram', status: 'scheduled', scheduled_at: at(2026, 10, 27, 15), tags: ['spring'] }),
    item({ id: 'b', title: 'Alpha', channel: 'facebook', status: 'draft', scheduled_at: at(2026, 10, 27, 9) }),
    item({ id: 'c', title: 'Idea', channel: 'email', status: 'idea', scheduled_at: null }),
  ];

  it('groups by local day, sorted by time, skipping unscheduled', () => {
    const map = groupByDay(buildEntries(items, []));
    expect([...map.keys()]).toEqual(['2026-10-27']);
    expect(map.get('2026-10-27')?.map((e) => (e.kind === 'content' ? e.item.id : ''))).toEqual(['b', 'a']);
  });

  it('filters by channel, status and search (title, body, tags)', () => {
    expect(filterItems(items, { ...NO_FILTERS, channels: new Set(['instagram']) }).map((i) => i.id)).toEqual(['a']);
    expect(filterItems(items, { ...NO_FILTERS, status: 'draft' }).map((i) => i.id)).toEqual(['b']);
    expect(filterItems(items, { ...NO_FILTERS, query: 'SPRING' }).map((i) => i.id)).toEqual(['a']);
    expect(filterItems(items, NO_FILTERS)).toHaveLength(3);
  });

  it('maps campaigns onto the calendar and applies filters to them', () => {
    const events = campaignEvents([
      { id: 'k1', name: 'Fall newsletter', status: 'scheduled', scheduled_at: at(2026, 10, 28, 10), started_at: null },
      { id: 'k2', name: 'Old', status: 'sent', scheduled_at: null, started_at: at(2026, 9, 1) },
      { id: 'k3', name: 'Undated draft', status: 'draft', scheduled_at: null, started_at: null },
      { id: 'k4', name: 'Cancelled', status: 'cancelled', scheduled_at: at(2026, 10, 30), started_at: null },
    ]);
    expect(events.map((e) => e.id)).toEqual(['k1', 'k2']);
    expect(filterCampaigns(events, NO_FILTERS)).toHaveLength(2);
    expect(filterCampaigns(events, { ...NO_FILTERS, channels: new Set(['facebook']) })).toHaveLength(0);
    expect(filterCampaigns(events, { ...NO_FILTERS, channels: new Set(['email']) })).toHaveLength(2);
    expect(filterCampaigns(events, { ...NO_FILTERS, status: 'draft' })).toHaveLength(0);
    expect(filterCampaigns(events, { ...NO_FILTERS, query: 'fall' }).map((e) => e.id)).toEqual(['k1']);
  });
});

describe('summarize', () => {
  it('reports upcoming, overdue, unscheduled and empty days', () => {
    const items = [
      item({ id: 'up', status: 'scheduled', scheduled_at: at(2026, 10, 28) }),
      item({ id: 'late', status: 'approved', scheduled_at: at(2026, 10, 20) }),
      item({ id: 'idea', status: 'idea', scheduled_at: null }),
      item({ id: 'pub', status: 'published', scheduled_at: at(2026, 10, 27) }),
      item({ id: 'gone', status: 'cancelled', scheduled_at: at(2026, 10, 29) }),
    ];
    const s = summarize(items, [], NOW);
    expect(s.upcoming7).toBe(1);
    expect(s.overdue.map((i) => i.id)).toEqual(['late']);
    expect(s.unscheduled.map((i) => i.id)).toEqual(['idea']);
    expect(s.gapDays).toHaveLength(12); // 14 days − Oct 27 (published) − Oct 28 (scheduled)
    expect(s.gapDays).not.toContain('2026-10-28');
    expect(s.gapDays).toContain('2026-10-29'); // cancelled does not count as planned
  });

  it('counts an email campaign as planned content', () => {
    const events = campaignEvents([{ id: 'k', name: 'N', status: 'scheduled', scheduled_at: at(2026, 10, 30), started_at: null }]);
    expect(summarize([], events, NOW).gapDays).not.toContain('2026-10-30');
  });
});

describe('ics export', () => {
  it('emits valid events, escapes text, skips cancelled/unscheduled and folds long lines', () => {
    const ics = buildIcs(
      [
        item({ id: 'a', title: 'Spring, sale; now', body: 'Line1\nLine2', status: 'scheduled', scheduled_at: '2026-11-03T14:30:00.000Z', link_url: 'https://x.test' }),
        item({ id: 'b', status: 'cancelled', scheduled_at: '2026-11-03T14:30:00.000Z' }),
        item({ id: 'c', status: 'draft', scheduled_at: null }),
        item({ id: 'd', title: 'é'.repeat(80), status: 'scheduled', scheduled_at: '2026-11-04T09:00:00.000Z' }),
      ],
      { now: new Date('2026-10-26T12:00:00Z'), calendarName: 'Acme' },
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('DTSTART:20261103T143000Z');
    expect(ics).toContain('DTEND:20261103T150000Z');
    expect(ics).toContain('SUMMARY:[Facebook] Spring\\, sale\\; now');
    expect(ics).toContain('X-WR-CALNAME:Acme');
    expect(ics).not.toContain('UID:b@');
    const enc = new TextEncoder();
    for (const line of ics.split('\r\n')) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
  });
});
