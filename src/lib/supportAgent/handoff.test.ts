import { describe, expect, it } from 'vitest';
import { CHAT_MEMORY_KEY, MAX_MESSAGES, MAX_TEXT, clearChat, loadChat, saveChat, sanitizeMessages, type MemoryStore } from './chatMemory';
import { TICKET_DRAFT_KEY, buildTicketDraft, clearTicketDraft, peekTicketDraft, putTicketDraft } from './ticketDraft';
import { BODY_MAX, SUBJECT_MAX, validateTicketInput } from '@/lib/supportTickets';

const fakeStore = (): MemoryStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const ID = '123e4567-e89b-12d3-a456-426614174000';

describe('chatMemory', () => {
  it('round-trips settled messages with meta', () => {
    const s = fakeStore();
    saveChat(s, [
      { id: 'a', role: 'user', text: 'hi' },
      { id: 'b', role: 'assistant', text: 'hello', meta: { answerId: ID, sources: [{ title: 'Pricing', url: '/pricing' }], suggestions: ['x'], handoff: true } },
    ], 1000);
    expect(loadChat(s, 2000)).toEqual([
      { id: 'a', role: 'user', text: 'hi' },
      { id: 'b', role: 'assistant', text: 'hello', meta: { answerId: ID, sources: [{ title: 'Pricing', url: '/pricing' }], suggestions: ['x'], handoff: true } },
    ]);
  });
  it('never persists streaming or error messages; empty result clears the entry', () => {
    const s = fakeStore();
    saveChat(s, [{ id: 'a', role: 'assistant', text: 'partial', streaming: true }, { id: 'b', role: 'assistant', text: 'oops', isError: true }]);
    expect(s.data.has(CHAT_MEMORY_KEY)).toBe(false);
  });
  it('caps count and length', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, text: 'x'.repeat(MAX_TEXT + 500) }));
    const out = sanitizeMessages(many);
    expect(out).toHaveLength(MAX_MESSAGES);
    expect(out[0].text).toHaveLength(MAX_TEXT);
  });
  it('treats storage as hostile: bad shapes, external/javascript links, bad ids', () => {
    const out = sanitizeMessages([
      null, 5, { id: 'x', role: 'system', text: 'no' }, { id: '', role: 'user', text: 'no' },
      { id: 'ok', role: 'assistant', text: 'fine', meta: { answerId: 'not-a-uuid', sources: [{ title: 'e', url: 'https://evil.example' }, { title: 'j', url: 'javascript:alert(1)' }, { title: 'p', url: '//evil.example' }, { title: 'g', url: '/help' }] } },
    ]);
    expect(out).toEqual([{ id: 'ok', role: 'assistant', text: 'fine', meta: { sources: [{ title: 'g', url: '/help' }] } }]);
  });
  it('expires after 2h, survives corrupt JSON, and clears', () => {
    const s = fakeStore();
    saveChat(s, [{ id: 'a', role: 'user', text: 'hi' }], 0);
    expect(loadChat(s, 3 * 60 * 60_000)).toEqual([]);
    expect(s.data.has(CHAT_MEMORY_KEY)).toBe(false);
    s.setItem(CHAT_MEMORY_KEY, '{not json');
    expect(loadChat(s)).toEqual([]);
    saveChat(s, [{ id: 'a', role: 'user', text: 'hi' }]);
    clearChat(s);
    expect(loadChat(s)).toEqual([]);
  });
  it('never throws when storage throws', () => {
    const boom: MemoryStore = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(() => saveChat(boom, [{ id: 'a', role: 'user', text: 'hi' }])).not.toThrow();
    expect(loadChat(boom)).toEqual([]);
    expect(() => clearChat(boom)).not.toThrow();
  });
});

describe('ticketDraft', () => {
  it('always passes the real ticket validation', () => {
    const d = buildTicketDraft({ findings: [{ id: 'stale_app', title: 'x'.repeat(500) }], report: 'r'.repeat(9000), lastQuestion: 'q' });
    expect(d.subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(d.body.length).toBeLessThanOrEqual(BODY_MAX);
    expect(validateTicketInput(d)).toEqual({});
  });
  it('works with no findings, no report and no question', () => {
    const d = buildTicketDraft({ findings: [], report: null, lastQuestion: null });
    expect(validateTicketInput(d)).toEqual({});
    expect(d.subject).toBe('I need help');
  });
  it('picks the account category for sign-in problems, technical otherwise, ignores "healthy"', () => {
    expect(buildTicketDraft({ findings: [{ id: 'invalid_credentials', title: 'Not accepted' }], report: 'r', lastQuestion: null }).category).toBe('account');
    expect(buildTicketDraft({ findings: [{ id: 'stale_app', title: 'Old app' }], report: 'r', lastQuestion: null }).category).toBe('technical');
    expect(buildTicketDraft({ findings: [{ id: 'healthy', title: 'No problems detected' }], report: 'r', lastQuestion: 'my invoices' }).subject).toBe('my invoices');
  });
  it('peek does not remove; clear does; TTL and hostile storage are handled', () => {
    const s = fakeStore();
    const draft = buildTicketDraft({ findings: [], report: 'report text here', lastQuestion: 'help' });
    putTicketDraft(s, draft, 0);
    expect(peekTicketDraft(s, 1000)).toEqual(draft);
    expect(peekTicketDraft(s, 1000)).toEqual(draft);
    expect(peekTicketDraft(s, 16 * 60_000)).toBeNull();
    clearTicketDraft(s);
    expect(peekTicketDraft(s, 1000)).toBeNull();
    s.setItem(TICKET_DRAFT_KEY, JSON.stringify({ at: 0, draft: { subject: 5, body: 'x', category: 'technical' } }));
    expect(peekTicketDraft(s, 1)).toBeNull();
    s.setItem(TICKET_DRAFT_KEY, JSON.stringify({ at: 0, draft: { subject: 's'.repeat(999), body: 'b'.repeat(99999), category: 'hacked' } }));
    const p = peekTicketDraft(s, 1)!;
    expect(p.subject.length).toBe(SUBJECT_MAX);
    expect(p.body.length).toBe(BODY_MAX);
    expect(p.category).toBe('technical');
  });
});
