import { describe, it, expect } from 'vitest';
import {
  addAttachments, buildStoragePath, filterTickets, formatDuration, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES,
  resolveMime, safeFileName, slaState, sortTickets, ticketRef, ticketState, validateTicketInput, type Ticket,
} from './supportTickets';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const ticket = (o: Partial<Ticket> = {}): Ticket => ({
  id: 't1', ticket_number: 1042, subject: 'Invoices not syncing', category: 'technical', priority: 'normal',
  status: 'open', awaiting_customer: false, first_response_at: null, resolved_at: null,
  sla_first_response_due_at: iso(NOW + 6 * H), sla_resolution_due_at: iso(NOW + 70 * H),
  created_at: iso(NOW - 2 * H), last_message_at: iso(NOW - H), visitor_id: 'u1', ...o,
});

describe('ticketRef / ticketState', () => {
  it('formats the reference', () => {
    expect(ticketRef(1042)).toBe('VK-1042');
    expect(ticketRef(null)).toBe('VK-…');
  });
  it('maps status + awaiting_customer to one state', () => {
    expect(ticketState({ status: 'open', awaiting_customer: false })).toBe('open');
    expect(ticketState({ status: 'active', awaiting_customer: false })).toBe('in_progress');
    expect(ticketState({ status: 'active', awaiting_customer: true })).toBe('waiting_on_you');
    expect(ticketState({ status: 'closed', awaiting_customer: true })).toBe('resolved');
  });
});

describe('formatDuration', () => {
  it('uses the two most useful units', () => {
    expect(formatDuration(20_000)).toBe('<1m');
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration(3 * H + 20 * 60_000)).toBe('3h 20m');
    expect(formatDuration(2 * H)).toBe('2h');
    expect(formatDuration(52 * H)).toBe('2d 4h');
  });
});

describe('slaState', () => {
  it('counts down to first response while unanswered', () => {
    const s = slaState(ticket(), NOW);
    expect(s).toMatchObject({ phase: 'first_response', tone: 'ok', label: 'First response due in 6h' });
  });
  it('warns in the last quarter of the window', () => {
    const t = ticket({ created_at: iso(NOW - 7 * H), sla_first_response_due_at: iso(NOW + 1 * H) });
    expect(slaState(t, NOW).tone).toBe('warning');
  });
  it('flags a breach with how late it is', () => {
    const t = ticket({ sla_first_response_due_at: iso(NOW - 65 * 60_000) });
    expect(slaState(t, NOW)).toMatchObject({ tone: 'breached', label: 'First response overdue by 1h 5m' });
  });
  it('switches to the resolution clock after the first reply', () => {
    const t = ticket({ first_response_at: iso(NOW - H), status: 'active' });
    expect(slaState(t, NOW).phase).toBe('resolution');
  });
  it('pauses (no countdown) while waiting on the customer', () => {
    const t = ticket({ first_response_at: iso(NOW - H), status: 'active', awaiting_customer: true });
    expect(slaState(t, NOW)).toMatchObject({ phase: 'paused', remainingMs: null });
  });
  it('reports whether a resolved ticket met its SLA', () => {
    const base = { status: 'closed' as const, sla_resolution_due_at: iso(NOW) };
    expect(slaState(ticket({ ...base, resolved_at: iso(NOW - H) }), NOW).label).toBe('Resolved within SLA');
    expect(slaState(ticket({ ...base, resolved_at: iso(NOW + H) }), NOW).tone).toBe('breached');
  });
  it('shows nothing for legacy rows without deadlines', () => {
    const t = ticket({ sla_first_response_due_at: null });
    expect(slaState(t, NOW)).toMatchObject({ phase: 'none', label: '' });
  });
});

describe('filter + sort', () => {
  const open = ticket({ id: 'a', last_message_at: iso(NOW - 5 * H) });
  const newer = ticket({ id: 'b', last_message_at: iso(NOW - H) });
  const done = ticket({ id: 'c', status: 'closed', last_message_at: iso(NOW) });
  it('splits open and resolved', () => {
    expect(filterTickets([open, done], 'open').map((t) => t.id)).toEqual(['a']);
    expect(filterTickets([open, done], 'resolved').map((t) => t.id)).toEqual(['c']);
    expect(filterTickets([open, done], 'all')).toHaveLength(2);
  });
  it('puts unresolved first, newest activity first', () => {
    expect(sortTickets([done, open, newer]).map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('validateTicketInput', () => {
  it('accepts a valid ticket', () => {
    expect(validateTicketInput({ subject: 'Sync broken', body: 'Invoices stopped syncing today.' })).toEqual({});
  });
  it('rejects short or oversized fields', () => {
    expect(validateTicketInput({ subject: 'ab', body: 'short' })).toHaveProperty('subject');
    expect(validateTicketInput({ subject: 'ok subject', body: 'short' })).toHaveProperty('body');
    expect(validateTicketInput({ subject: 'x'.repeat(121), body: 'y'.repeat(20) })).toHaveProperty('subject');
    expect(validateTicketInput({ subject: 'fine', body: 'y'.repeat(5001) })).toHaveProperty('body');
  });
});

describe('attachments', () => {
  const f = (name: string, size = 1000, type = 'image/png') => ({ name, size, type });
  it('accepts valid files and rejects the rest with a reason', () => {
    const r = addAttachments([], [f('a.png'), f('big.png', MAX_ATTACHMENT_BYTES + 1), f('x.exe', 10, 'application/x-msdownload'), f('e.png', 0)]);
    expect(r.accepted.map((x) => x.name)).toEqual(['a.png']);
    expect(r.rejected.map((x) => x.name)).toEqual(['big.png', 'x.exe', 'e.png']);
  });
  it('rejects duplicates and enforces the count limit', () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => f(`f${i}.png`));
    expect(addAttachments(existing, [f('extra.png')]).rejected[0].reason).toMatch(/Limit/);
    expect(addAttachments([f('a.png')], [f('a.png')]).rejected[0].reason).toBe('Already added.');
  });
  it('falls back to the extension when the browser gives no type', () => {
    expect(resolveMime(f('photo.HEIC', 10, ''))).toBe('image/heic');
    expect(addAttachments([], [f('photo.heic', 10, '')]).accepted).toHaveLength(1);
  });
  it('sanitises names and builds the policy-required path', () => {
    expect(safeFileName('../../etc/pass wd?.PDF')).toBe('pass_wd.pdf');
    expect(safeFileName('???')).toBe('file');
    expect(buildStoragePath('own', 'conv', 'My Report.pdf', 'uid')).toBe('own/conv/uid-My_Report.pdf');
  });
});
