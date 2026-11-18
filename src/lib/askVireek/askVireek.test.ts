import { describe, expect, it } from 'vitest';
import { parseMarkdown, safeHref } from './markdown';
import { getAssistantContext, SUGGESTION_KEYS } from './route';
import {
  CONVERSATION_KEY, CONVERSATION_TTL_MS, exportAsText, loadConversation, saveConversation, sanitizeMessage, type KeyValueStore,
} from './storage';
import { buildLiveChatDetail, buildTranscript, liveChatPrefill, ticketHref } from './handoff';
import { isAssistantShortcut } from './shortcut';
import { chatReducer, toHistory, type ChatMessage } from './state';
import { askSiteAssistant, classifyStatus, parseSseBuffer, type SiteAssistantEvent } from './client';

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const key = (over: Partial<Parameters<typeof isAssistantShortcut>[0]> = {}) => ({ key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

describe('markdown safety', () => {
  it('allows only relative, vireek.com https and mailto links', () => {
    expect(safeHref('/pricing')).toEqual({ href: '/pricing', external: false });
    expect(safeHref('https://vireek.com/help?x=1')).toEqual({ href: '/help?x=1', external: false });
    expect(safeHref('mailto:ali@vireek.com')?.external).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', 'https://evil.com', 'https://vireek.com.evil.com/x', 'http://vireek.com', ' /a b', '/\\evil', 'https://user:p@vireek.com/']) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });
  it('renders a poisoned link as plain text and never emits html', () => {
    const [p] = parseMarkdown('See [click](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(JSON.stringify(p)).not.toContain('javascript:');
    expect(p.t).toBe('p');
  });
  it('parses lists, code fences (even unterminated) and bold', () => {
    const b = parseMarkdown('Steps:\n1. Open **Settings**\n2. Save\n\n- a\n- b\n\n```ts\nconst x = 1');
    expect(b.map((x) => x.t)).toEqual(['p', 'ol', 'ul', 'code']);
    expect(b[3]).toMatchObject({ t: 'code', v: 'const x = 1' });
  });
});

describe('route rules', () => {
  it('shows on public pages and the dashboard, hides on staff/wallboard', () => {
    expect(getAssistantContext('/pricing')).toEqual({ surface: 'public', topic: 'pricing' });
    expect(getAssistantContext('/')).toEqual({ surface: 'public', topic: 'general' });
    expect(getAssistantContext('/dashboard/calls').surface).toBe('dashboard');
    expect(getAssistantContext('/home').surface).toBe('dashboard');
    expect(getAssistantContext('/staff/support-inbox').surface).toBe('hidden');
    expect(getAssistantContext('/wallboard').surface).toBe('hidden');
    expect(getAssistantContext('/login').surface).toBe('auth');
  });
  it('every topic has 3-6 suggestions', () => {
    for (const k of Object.values(SUGGESTION_KEYS)) expect(k.length).toBeGreaterThanOrEqual(3), expect(k.length).toBeLessThanOrEqual(6);
  });
});

describe('storage', () => {
  const msg = { id: 'a', role: 'user' as const, text: 'hi', at: 1000 };
  it('round-trips, expires and survives tampering', () => {
    const s = memStore();
    saveConversation([msg], 1000, s);
    expect(loadConversation(2000, s)).toHaveLength(1);
    expect(loadConversation(1000 + CONVERSATION_TTL_MS + 1, s)).toEqual([]);
    expect(s.data.has(CONVERSATION_KEY)).toBe(false);
    s.setItem(CONVERSATION_KEY, '{"v":1,"updatedAt":1,"messages":[{"id":1},"x",{"id":"ok","role":"admin","text":"t"}]}');
    expect(loadConversation(2, s)).toEqual([]);
    s.setItem(CONVERSATION_KEY, 'not json');
    expect(loadConversation(2, s)).toEqual([]);
  });
  it('drops off-site source links and caps size', () => {
    const m = sanitizeMessage({ ...msg, role: 'assistant', sources: [{ title: 'x', url: 'https://evil.com' }, { title: 'ok', url: '/pricing' }] });
    expect(m?.sources).toEqual([{ title: 'ok', url: '/pricing' }]);
    const s = memStore();
    saveConversation(Array.from({ length: 100 }, (_, i) => ({ ...msg, id: `m${i}` })), 5, s);
    expect(loadConversation(6, s)).toHaveLength(40);
  });
  it('exports plain text without error turns', () => {
    expect(exportAsText([msg, { ...msg, id: 'e', role: 'assistant', text: 'boom', isError: true }], { you: 'You', assistant: 'AI' })).toBe('You: hi');
  });
});

describe('handoff', () => {
  const m = (role: 'user' | 'assistant', text: string, i: number) => ({ id: String(i), role, text, at: i });
  it('keeps the newest turns within the size cap', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => m(i % 2 ? 'assistant' : 'user', `turn ${i} ${'x'.repeat(300)}`, i));
    const t = buildTranscript(msgs, 1000, 8);
    expect(t.length).toBeLessThanOrEqual(1000);
    expect(t).toContain('turn 29');
    expect(t).not.toContain('turn 0 ');
  });
  it('prefill carries last question + transcript; tickets route by auth', () => {
    const d = buildLiveChatDetail([m('user', 'Why no calls?', 1), m('assistant', 'Check forwarding.', 2)]);
    expect(liveChatPrefill(d)).toContain('Why no calls?');
    expect(liveChatPrefill(d)).toContain('Ask Vireek: Check forwarding.');
    expect(ticketHref(true)).toBe('/dashboard/support');
    expect(ticketHref(false)).toBe('/contact');
  });
});

describe('keyboard shortcut', () => {
  it('Cmd/Ctrl+/ always; ? only outside editable fields', () => {
    expect(isAssistantShortcut(key({ key: '/', ctrlKey: true }), { tagName: 'TEXTAREA' })).toBe(true);
    expect(isAssistantShortcut(key({ key: '?' }), { tagName: 'DIV' })).toBe(true);
    expect(isAssistantShortcut(key({ key: '?' }), { tagName: 'INPUT' })).toBe(false);
    expect(isAssistantShortcut(key({ key: '?' }), { tagName: 'DIV', isContentEditable: true })).toBe(false);
    expect(isAssistantShortcut(key({ key: '?', isComposing: true }), null)).toBe(false);
    expect(isAssistantShortcut(key({ key: '/', defaultPrevented: true, ctrlKey: true }), null)).toBe(false);
  });
});

describe('chat reducer', () => {
  it('streams deltas into one message, finishes, rates once, retries', () => {
    let s: ChatMessage[] = [];
    s = chatReducer(s, { type: 'user', id: 'u', text: 'q', at: 1 });
    s = chatReducer(s, { type: 'event', id: 'a', event: { answerId: '11111111-1111-1111-1111-111111111111' }, at: 2 });
    s = chatReducer(s, { type: 'event', id: 'a', event: { delta: 'Hel' }, at: 2 });
    s = chatReducer(s, { type: 'event', id: 'a', event: { delta: 'lo' }, at: 2 });
    s = chatReducer(s, { type: 'event', id: 'a', event: { handoff: { reason: 'low_confidence' }, done: true }, at: 3 });
    expect(s[1]).toMatchObject({ text: 'Hello', streaming: false, handoff: true, handoffReason: 'low_confidence' });
    s = chatReducer(s, { type: 'rate', id: 'a', rating: 1 });
    s = chatReducer(s, { type: 'rate', id: 'a', rating: -1 });
    expect(s[1].rating).toBe(1);
    s = chatReducer(s, { type: 'user', id: 'u2', text: 'q2', at: 4 });
    s = chatReducer(s, { type: 'fail', id: 'b', text: 'oops', at: 5 });
    expect(toHistory(s).map((m) => m.content)).toEqual(['q', 'Hello', 'q2']);
    s = chatReducer(s, { type: 'drop-error' });
    expect(s[s.length - 1].id).toBe('u2');
  });
});

describe('sse client', () => {
  it('parses events, validates ids/handoff/sources, keeps partial tail', () => {
    const buf = 'data: {"answerId":"11111111-1111-1111-1111-111111111111"}\n\ndata: {"sources":[{"title":"P","url":"/pricing"},{"title":"x","url":"//evil"}]}\n\ndata: {"handoff":{"reason":"weird"}}\n\ndata: {"delta":"ab';
    const { events, rest } = parseSseBuffer(buf);
    expect(events[0].answerId).toBeTruthy();
    expect(events[1].sources).toEqual([{ title: 'P', url: '/pricing' }]);
    expect(events[2].handoff?.reason).toBe('low_confidence');
    expect(rest).toContain('"delta":"ab');
    expect(parseSseBuffer('data: {"answerId":"<script>"}\n').events[0].answerId).toBeUndefined();
  });
  it('classifies statuses', () => {
    expect([classifyStatus(429), classifyStatus(400), classifyStatus(500)]).toEqual(['rate_limited', 'invalid', 'error']);
  });
  const run = async (fetchImpl: typeof fetch, isOnline = () => true) => {
    const events: SiteAssistantEvent[] = []; const fails: string[] = [];
    await askSiteAssistant({ message: 'q', history: [], page: '/pricing', baseUrl: 'http://x', anonKey: 'k', fetchImpl, isOnline, onEvent: (e) => events.push(e), onFailure: (k) => fails.push(k) });
    return { events, fails };
  };
  it('reports offline, 429 and network errors without throwing; streams otherwise', async () => {
    expect((await run((() => { throw new Error('no'); }) as never, () => false)).fails).toEqual(['offline']);
    expect((await run((async () => new Response('{"error":"slow"}', { status: 429, headers: { 'content-type': 'application/json' } })) as never)).fails).toEqual(['rate_limited']);
    expect((await run((async () => { throw new TypeError('net'); }) as never)).fails).toEqual(['error']);
    const body = new Response('data: {"delta":"hi"}\n\ndata: {"done":true}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const ok = await run((async () => body) as never);
    expect(ok.events.map((e) => e.delta ?? 'done')).toEqual(['hi', 'done']);
  });
});
