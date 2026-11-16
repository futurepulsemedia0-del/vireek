// src/lib/supportAgent/chatMemory.ts
//
// Conversation memory for the Ask tab. Survives closing the panel, route changes and a refresh,
// and ends with the browser tab (sessionStorage — never localStorage, so nothing outlives the visit
// and no cross-session consent question arises). Pure: the storage object is injected.
// Everything read back is treated as untrusted: shape-validated, size-capped, and source links
// are forced to site-relative paths so tampered storage can never inject an external or
// javascript: link.

export interface StoredMeta {
  answerId?: string;
  sources?: { title: string; url: string }[];
  suggestions?: string[];
  handoff?: boolean;
}
export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  meta?: StoredMeta;
}
/** What the UI holds; transient/failed messages are never persisted. */
export type LiveMessage = StoredMessage & { streaming?: boolean; isError?: boolean };

export interface MemoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** sessionStorage, or an inert store when the browser blocks it (SSR / strict privacy modes throw on access). */
export function getSessionStore(): MemoryStore {
  try {
    return window.sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  }
}

export const CHAT_MEMORY_KEY = 'vk_agent_chat_v1';
export const MAX_MESSAGES = 20;
export const MAX_TEXT = 2_000;
const TTL_MS = 2 * 60 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isSafePath = (u: unknown): u is string => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && u.length <= 200;
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

function sanitizeMeta(raw: unknown): StoredMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const out: StoredMeta = {};
  if (typeof m.answerId === 'string' && UUID_RE.test(m.answerId)) out.answerId = m.answerId;
  if (Array.isArray(m.sources)) {
    const sources = m.sources
      .filter((s): s is { title: unknown; url: unknown } => !!s && typeof s === 'object')
      .filter((s) => isSafePath(s.url))
      .slice(0, 3)
      .map((s) => ({ title: str(s.title, 80) || String(s.url), url: String(s.url) }));
    if (sources.length) out.sources = sources;
  }
  if (Array.isArray(m.suggestions)) {
    const suggestions = m.suggestions.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 120)).slice(0, 3);
    if (suggestions.length) out.suggestions = suggestions;
  }
  if (m.handoff === true) out.handoff = true;
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeMessages(raw: unknown): StoredMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredMessage[] = [];
  for (const item of raw.slice(-MAX_MESSAGES)) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.id !== 'string' || !m.id) continue;
    const text = str(m.text, MAX_TEXT);
    if (!text) continue;
    const meta = m.role === 'assistant' ? sanitizeMeta(m.meta) : undefined;
    out.push({ id: m.id.slice(0, 64), role: m.role, text, ...(meta ? { meta } : {}) });
  }
  return out;
}

export function loadChat(store: MemoryStore, now: number = Date.now()): StoredMessage[] {
  try {
    const raw = store.getItem(CHAT_MEMORY_KEY);
    if (!raw) return [];
    const env = JSON.parse(raw) as { v?: number; at?: number; messages?: unknown };
    if (env?.v !== 1 || typeof env.at !== 'number' || now - env.at > TTL_MS) {
      store.removeItem(CHAT_MEMORY_KEY);
      return [];
    }
    return sanitizeMessages(env.messages);
  } catch {
    return [];
  }
}

/** Persists only settled messages (not streaming, not errors). An empty result clears the entry. */
export function saveChat(store: MemoryStore, messages: readonly LiveMessage[], now: number = Date.now()): void {
  try {
    const settled = sanitizeMessages(messages.filter((m) => !m.streaming && !m.isError));
    if (!settled.length) {
      store.removeItem(CHAT_MEMORY_KEY);
      return;
    }
    store.setItem(CHAT_MEMORY_KEY, JSON.stringify({ v: 1, at: now, messages: settled }));
  } catch {
    /* storage full or blocked: memory is a convenience, never an error */
  }
}

export function clearChat(store: MemoryStore): void {
  try { store.removeItem(CHAT_MEMORY_KEY); } catch { /* ignore */ }
}
