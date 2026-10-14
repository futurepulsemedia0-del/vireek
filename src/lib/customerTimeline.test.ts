import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_NOTE,
  buildFeed,
  buildLinkFilter,
  buildStoragePath,
  checkAttachments,
  countByKind,
  dayLabel,
  emailVariants,
  formatBytes,
  formatDuration,
  groupByDay,
  lineItemsTotalCents,
  mapCall,
  mapEmail,
  mapInvoice,
  mapJob,
  mapNote,
  mapOutboundSms,
  mapPayment,
  mapQuote,
  mapReview,
  mapSms,
  matchesQuery,
  noteErrorMessage,
  phoneVariants,
  pinnedNotes,
  safeFileName,
  snippet,
  sortEvents,
  uniqueById,
  validateNoteBody,
  type CustomerNote,
  type TimelineEvent,
} from '@/lib/customerTimeline';

// Wednesday 14 Oct 2026, 12:00 local.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m, d, h, min).toISOString();

function note(over: Partial<CustomerNote> = {}): CustomerNote {
  return {
    id: 'n1',
    user_id: 'owner',
    customer_id: 'c1',
    author_id: 'u1',
    author_name: 'Dana',
    body: 'Gate code is 4471. Dog in backyard.',
    pinned: false,
    pinned_at: null,
    edited_at: null,
    created_at: at(2026, 9, 10),
    updated_at: at(2026, 9, 10),
    attachments: [],
    ...over,
  };
}

function event(over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'call:1',
    kind: 'call',
    at: at(2026, 9, 12),
    title: 'Phone call',
    detail: null,
    meta: [],
    tone: 'neutral',
    direction: null,
    amountCents: null,
    href: null,
    note: null,
    ...over,
  };
}

describe('formatting helpers', () => {
  it('formats durations and bytes', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(200)).toBe('3m 20s');
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(null)).toBeNull();
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('snippet collapses whitespace and clamps with an ellipsis', () => {
    expect(snippet('  a \n\n b  ')).toBe('a b');
    expect(snippet('   ')).toBeNull();
    expect(snippet(null)).toBeNull();
    const long = snippet('x'.repeat(500), 50) as string;
    expect(long).toHaveLength(50);
    expect(long.endsWith('…')).toBe(true);
  });

  it('totals line items defensively', () => {
    expect(lineItemsTotalCents([{ quantity: 2, unit_price_cents: 5000 }], 10)).toBe(11000);
    expect(lineItemsTotalCents([{ quantity: 'x', unit_price_cents: 5000 }, { quantity: 1, unit_price_cents: 100 }], 0)).toBe(100);
    expect(lineItemsTotalCents(null, 8)).toBe(0);
    expect(lineItemsTotalCents([{ quantity: 1, unit_price_cents: 1000 }], null)).toBe(1000);
  });
});

describe('customer link matching', () => {
  it('builds every plausible phone variant for US numbers', () => {
    const v = phoneVariants('(555) 123-4567');
    expect(v).toContain('+15551234567');
    expect(v).toContain('15551234567');
    expect(v).toContain('5551234567');
    expect(phoneVariants('+1 555 123 4567')).toContain('5551234567');
    expect(phoneVariants('+44 20 7946 0958')).toContain('+442079460958');
    expect(phoneVariants('123')).toEqual([]);
    expect(phoneVariants(null)).toEqual([]);
  });

  it('only accepts well-formed emails and never lets metacharacters through', () => {
    expect(emailVariants('Jane@Example.com')).toEqual(['Jane@Example.com', 'jane@example.com']);
    expect(emailVariants('bad,email@x.com')).toEqual([]);
    expect(emailVariants('a)@b.co')).toEqual([]);
    expect(emailVariants('')).toEqual([]);
  });

  it('builds a link filter that guards unlinked rows', () => {
    const f = buildLinkFilter({
      customerIdColumn: 'customer_id',
      customerId: 'abc',
      phoneColumn: 'customer_phone',
      phones: ['+15551234567'],
      emailColumn: 'customer_email',
      emails: ['a@b.co'],
    });
    expect(f).toBe(
      'customer_id.eq.abc,and(customer_id.is.null,customer_phone.in.("+15551234567")),and(customer_id.is.null,customer_email.in.("a@b.co"))',
    );
  });

  it('supports tables without customer_id (invoices) and returns null when nothing links', () => {
    expect(
      buildLinkFilter({ jobColumn: 'job_id', jobIds: ['j1', 'j2'], phoneColumn: 'customer_phone', phones: ['5551234567'] }),
    ).toBe('job_id.in.(j1,j2),customer_phone.in.("5551234567")');
    expect(buildLinkFilter({ phoneColumn: 'customer_phone', phones: [] })).toBeNull();
  });

  it('uniqueById keeps the first occurrence', () => {
    expect(uniqueById([{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'a', v: 3 }])).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 2 }]);
  });
});

describe('row mappers', () => {
  it('maps calls with tone, duration and emergency flag', () => {
    const e = mapCall({
      id: 'c1',
      call_datetime: at(2026, 9, 12),
      summary: 'No heat',
      status: 'new_lead',
      sentiment: 'negative',
      duration_seconds: 200,
      is_emergency: true,
    });
    expect(e.id).toBe('call:c1');
    expect(e.title).toBe('Emergency call');
    expect(e.tone).toBe('bad');
    expect(e.meta).toEqual(['3m 20s', 'Negative sentiment', 'New lead']);
    expect(mapCall({ id: 'c2', call_datetime: at(2026, 9, 12), summary: null, status: null, sentiment: 'positive', duration_seconds: null, is_emergency: false }).tone).toBe('good');
  });

  it('maps inbound/outbound SMS and automated SMS', () => {
    expect(mapSms({ id: 's1', direction: 'inbound', body: 'On my way?', created_at: at(2026, 9, 12) }).title).toBe('SMS received');
    const auto = mapOutboundSms({ id: 'o1', body: 'Reminder', status: 'failed', sent_at: null, created_at: at(2026, 9, 11) });
    expect(auto.id).toBe('sms:auto:o1');
    expect(auto.tone).toBe('bad');
    expect(auto.at).toBe(at(2026, 9, 11));
    expect(auto.direction).toBe('outbound');
  });

  it('maps email with and without a subject', () => {
    expect(mapEmail({ id: 'e1', direction: 'inbound', subject: 'Invoice question', body_text: 'Hi\n\nthere', created_at: at(2026, 9, 12) })).toMatchObject({
      title: 'Email received: Invoice question',
      detail: 'Hi there',
    });
    expect(mapEmail({ id: 'e2', direction: 'outbound', subject: '  ', body_text: null, created_at: at(2026, 9, 12) }).title).toBe('Email sent');
  });

  it('maps jobs, using the scheduled time when present', () => {
    const e = mapJob({ id: 'j1', service_type: 'Furnace repair', job_status: 'completed', invoice_status: 'paid', scheduled_datetime: at(2026, 9, 1), created_at: at(2026, 8, 28) });
    expect(e.at).toBe(at(2026, 9, 1));
    expect(e.tone).toBe('good');
    expect(e.meta).toEqual(['Completed', 'Invoice paid']);
    expect(e.href).toBe('/dashboard/jobs/j1');
    expect(mapJob({ id: 'j2', service_type: null, job_status: 'cancelled', invoice_status: 'not_sent', scheduled_datetime: null, created_at: at(2026, 8, 28) })).toMatchObject({
      title: 'Service call',
      tone: 'bad',
      at: at(2026, 8, 28),
    });
  });

  it('emits a second event when a quote is accepted or declined', () => {
    const base = { id: 'q1', line_items: [{ quantity: 1, unit_price_cents: 20000 }], tax_percent: 0, sent_at: at(2026, 9, 2), created_at: at(2026, 9, 1) };
    const accepted = mapQuote({ ...base, status: 'accepted', responded_at: at(2026, 9, 3) });
    expect(accepted.map((e) => e.title)).toEqual(['Quote sent', 'Quote accepted']);
    expect(accepted[1].tone).toBe('good');
    expect(accepted[0].amountCents).toBe(20000);
    expect(mapQuote({ ...base, status: 'draft', sent_at: null, responded_at: null })[0]).toMatchObject({ title: 'Quote drafted', at: at(2026, 9, 1) });
    expect(mapQuote({ ...base, status: 'sent', responded_at: null })).toHaveLength(1);
    expect(mapQuote({ ...base, status: 'declined', responded_at: null })).toHaveLength(1);
  });

  it('expands invoices into sent / viewed / paid / void milestones', () => {
    const inv = mapInvoice({
      id: 'i1',
      job_id: 'j1',
      invoice_number: 'INV-0007',
      status: 'paid',
      line_items: [{ quantity: 2, unit_price_cents: 5000 }],
      tax_percent: 10,
      payment_method: 'card',
      sent_at: at(2026, 9, 4),
      viewed_at: at(2026, 9, 5),
      paid_at: at(2026, 9, 6),
      created_at: at(2026, 9, 3),
      updated_at: at(2026, 9, 6),
    });
    expect(inv.map((e) => e.title)).toEqual(['Invoice INV-0007 sent', 'Invoice INV-0007 viewed', 'Invoice INV-0007 paid']);
    expect(inv[2]).toMatchObject({ amountCents: 11000, tone: 'good', meta: ['Card'], href: '/dashboard/jobs/j1' });
    const voided = mapInvoice({ id: 'i2', job_id: null, invoice_number: null, status: 'void', line_items: [], tax_percent: 0, payment_method: null, sent_at: null, viewed_at: null, paid_at: null, created_at: at(2026, 9, 3), updated_at: at(2026, 9, 7) });
    expect(voided.map((e) => e.title)).toEqual(['Invoice sent', 'Invoice voided']);
    expect(voided[0].amountCents).toBeNull();
    expect(voided[0].href).toBeNull();
  });

  it('maps payments across methods and statuses without exposing more than brand/last4', () => {
    const card = mapPayment({ id: 'p1', job_id: 'j1', method: 'card_present', status: 'succeeded', amount_cents: 15000, card_brand: 'visa', card_last4: '4242', check_number: null, note: null, received_at: at(2026, 9, 6) });
    expect(card).toMatchObject({ title: 'Card payment received', tone: 'good', amountCents: 15000, meta: ['Visa •••• 4242'] });
    expect(mapPayment({ id: 'p2', job_id: 'j1', method: 'check', status: 'voided', amount_cents: 100, card_brand: null, card_last4: null, check_number: '1002', note: 'Bounced', received_at: at(2026, 9, 6) })).toMatchObject({
      title: 'Check payment voided',
      tone: 'warn',
      meta: ['Check #1002'],
    });
  });

  it('maps review requests and ratings', () => {
    const done = mapReview({ id: 'r1', status: 'completed', rating: 5, sent_at: at(2026, 9, 7), completed_at: at(2026, 9, 8) });
    expect(done.map((e) => e.title)).toEqual(['Review requested', 'Review received — ★★★★★']);
    expect(done[1].tone).toBe('good');
    expect(mapReview({ id: 'r2', status: 'completed', rating: 2, sent_at: at(2026, 9, 7), completed_at: at(2026, 9, 8) })[1].tone).toBe('bad');
    expect(mapReview({ id: 'r3', status: 'sent', rating: null, sent_at: at(2026, 9, 7), completed_at: null })).toHaveLength(1);
    expect(mapReview({ id: 'r4', status: 'declined', rating: null, sent_at: at(2026, 9, 7), completed_at: null })[1].title).toBe('Review declined');
  });

  it('maps notes and flags edits', () => {
    const e = mapNote(note({ edited_at: at(2026, 9, 11) }));
    expect(e).toMatchObject({ id: 'note:n1', kind: 'note', title: 'Note by Dana', meta: ['Edited'] });
    expect(mapNote(note({ author_name: null })).title).toBe('Note by a team member');
  });
});

describe('feed building', () => {
  const events: TimelineEvent[] = [
    event({ id: 'call:1', kind: 'call', at: at(2026, 9, 12), title: 'Phone call', detail: 'Furnace is making a loud noise' }),
    event({ id: 'sms:1', kind: 'sms', at: at(2026, 9, 13), title: 'SMS received', detail: 'Can you come Friday?' }),
    event({ id: 'job:1', kind: 'job', at: at(2026, 9, 20), title: 'Furnace repair' }),
    mapNote(note({ id: 'n1', created_at: at(2026, 9, 10) })),
    mapNote(note({ id: 'n2', pinned: true, pinned_at: at(2026, 9, 11), created_at: at(2026, 9, 9), body: 'VIP — always call first' })),
  ];

  it('sorts newest first, sinks invalid dates and is stable on ties', () => {
    const sorted = sortEvents([
      event({ id: 'b', at: at(2026, 9, 1) }),
      event({ id: 'a', at: at(2026, 9, 1) }),
      event({ id: 'bad', at: 'not-a-date' }),
      event({ id: 'new', at: at(2026, 9, 2) }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['new', 'a', 'b', 'bad']);
  });

  it('filters by kind (empty = all) and by multi-term search across fields', () => {
    expect(buildFeed(events, { kinds: [], query: '' })).toHaveLength(5);
    expect(buildFeed(events, { kinds: ['call', 'sms'], query: '' }).map((e) => e.id)).toEqual(['sms:1', 'call:1']);
    expect(buildFeed(events, { kinds: [], query: 'furnace loud' }).map((e) => e.id)).toEqual(['call:1']);
    expect(buildFeed(events, { kinds: [], query: 'dana' }).map((e) => e.kind)).toEqual(['note', 'note']);
    expect(buildFeed(events, { kinds: [], query: 'nothing matches this' })).toEqual([]);
  });

  it('keeps pinned notes out of the feed when asked, and orders the pinned panel by pin time', () => {
    expect(buildFeed(events, { kinds: [], query: '', excludePinnedNotes: true }).some((e) => e.id === 'note:n2')).toBe(false);
    const notes = [note({ id: 'a', pinned: true, pinned_at: at(2026, 9, 1) }), note({ id: 'b', pinned: true, pinned_at: at(2026, 9, 5) }), note({ id: 'c' })];
    expect(pinnedNotes(notes).map((n) => n.id)).toEqual(['b', 'a']);
    expect(pinnedNotes(notes, 'zzz')).toEqual([]);
  });

  it('searches attachment file names on notes', () => {
    const withFile = mapNote(note({ attachments: [{ id: 'a1', note_id: 'n1', storage_path: 'x', file_name: 'warranty-card.pdf', mime_type: 'application/pdf', size_bytes: 10, created_at: at(2026, 9, 10) }] }));
    expect(matchesQuery(withFile, 'warranty')).toBe(true);
    expect(matchesQuery(withFile, 'invoice')).toBe(false);
  });

  it('counts events per kind', () => {
    const counts = countByKind(events);
    expect(counts.note).toBe(2);
    expect(counts.call).toBe(1);
    expect(counts.invoice).toBe(0);
  });
});

describe('day grouping', () => {
  it('labels today, yesterday, this year and older years', () => {
    expect(dayLabel(new Date(2026, 9, 14, 8), NOW)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 13, 23), NOW)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 8, 2), NOW)).toMatch(/Sep 2/);
    expect(dayLabel(new Date(2025, 8, 2), NOW)).toBe('Sep 2, 2025');
  });

  it('groups by local day, puts future events under Upcoming and keeps order', () => {
    const sorted = sortEvents([
      event({ id: 'future', at: at(2026, 9, 16) }),
      event({ id: 't2', at: at(2026, 9, 14, 11) }),
      event({ id: 't1', at: at(2026, 9, 14, 8) }),
      event({ id: 'y', at: at(2026, 9, 13, 20) }),
    ]);
    const groups = groupByDay(sorted, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Upcoming', 'Today', 'Yesterday']);
    expect(groups[1].events.map((e) => e.id)).toEqual(['t2', 't1']);
  });
});

describe('notes and attachments', () => {
  it('validates note bodies', () => {
    expect(validateNoteBody('  ')).toBe('Write a note or attach a file.');
    expect(validateNoteBody('  ', true)).toBe('Add a short note to go with the files.');
    expect(validateNoteBody('x'.repeat(8001))).toMatch(/limited to 8,000/);
    expect(validateNoteBody('Call before arriving')).toBeNull();
  });

  it('rejects unsupported, empty, oversized, duplicate and excess files', () => {
    const ok = { name: 'photo.jpg', size: 1000, type: 'image/jpeg' };
    const { accepted, errors } = checkAttachments(
      [],
      [
        ok,
        { name: 'virus.exe', size: 10, type: 'application/x-msdownload' },
        { name: 'empty.pdf', size: 0, type: 'application/pdf' },
        { name: 'huge.pdf', size: MAX_ATTACHMENT_BYTES + 1, type: 'application/pdf' },
        ok,
      ],
    );
    expect(accepted).toEqual([ok]);
    expect(errors).toHaveLength(4);

    const existing = Array.from({ length: MAX_ATTACHMENTS_PER_NOTE - 1 }, (_, i) => ({ name: `f${i}.pdf`, size: i + 1, type: 'application/pdf' }));
    const capped = checkAttachments(existing, [ok, { name: 'two.png', size: 5, type: 'image/png' }]);
    expect(capped.accepted).toHaveLength(1);
    expect(capped.errors[0]).toMatch(/Up to 10 files/);
  });

  it('sanitises file names and builds owner-scoped storage paths', () => {
    expect(safeFileName('../../etc/passwd')).toBe('etcpasswd');
    expect(safeFileName('My Invoice (final).pdf')).toBe('My-Invoice-final.pdf');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('a'.repeat(300)).length).toBeLessThanOrEqual(120);
    const path = buildStoragePath({ ownerId: 'own', customerId: 'cus', noteId: 'not', fileId: 'f1', fileName: 'Photo 1.JPG' });
    expect(path).toBe('own/cus/not/f1-Photo-1.JPG');
    expect(path.startsWith('own/')).toBe(true);
  });

  it('maps database errors to friendly messages', () => {
    expect(noteErrorMessage({ message: 'too_many_pinned_notes' })).toMatch(/pin up to 5/);
    expect(noteErrorMessage({ code: '42501', message: 'x' })).toMatch(/permission/);
    expect(noteErrorMessage({ code: '42P01', message: 'relation "customer_notes" does not exist' })).toMatch(/migration/);
    expect(noteErrorMessage(null)).toMatch(/try again/);
  });
});
