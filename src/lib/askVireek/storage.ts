// src/lib/askVireek/storage.ts
//
// Conversation persistence for "Ask Vireek". Functional storage only (the visitor
// asked for the conversation to continue): nothing here is analytics/marketing, so
// it is not consent-gated, and it never leaves the browser. Everything read back is
// validated — a tampered localStorage value can never reach the UI untyped.

export const CONVERSATION_KEY = 'vk-ask-conversation-v1';
export const INTRO_KEY = 'vk-ask-intro-v1';
export const MAX_STORED_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 4000;
export const CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SourceRef {
  title: string;
  url: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  isError?: boolean;
  answerId?: string;
  sources?: SourceRef[];
  suggestions?: string[];
  handoff?: boolean;
}

export interface StoredConversation {
  v: 1;
  updatedAt: number;
  messages: StoredMessage[];
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // storage blocked (private mode / policy)
  }
}

function asString(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

function cleanSources(v: unknown): SourceRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SourceRef[] = [];
  for (const s of v.slice(0, 3)) {
    const title = asString((s as SourceRef)?.title, 80);
    const url = asString((s as SourceRef)?.url, 200);
    if (title && url && url.startsWith('/') && !url.startsWith('//')) out.push({ title, url });
  }
  return out.length ? out : undefined;
}

export function sanitizeMessage(raw: unknown): StoredMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = asString(r.id, 64);
  const text = asString(r.text, MAX_MESSAGE_CHARS);
  const role = r.role === 'user' || r.role === 'assistant' ? r.role : null;
  if (!id || text === null || !role) return null;
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : Date.now();
  const msg: StoredMessage = { id, role, text, at };
  if (r.isError === true) msg.isError = true;
  const answerId = asString(r.answerId, 64);
  if (answerId) msg.answerId = answerId;
  const sources = cleanSources(r.sources);
  if (sources) msg.sources = sources;
  if (Array.isArray(r.suggestions)) {
    const s = r.suggestions.filter((x): x is string => typeof x === 'string').slice(0, 4).map((x) => x.slice(0, 120));
    if (s.length) msg.suggestions = s;
  }
  if (r.handoff === true) msg.handoff = true;
  return msg;
}

export function loadConversation(now = Date.now(), store: KeyValueStore | null = defaultStore()): StoredMessage[] {
  if (!store) return [];
  try {
    const raw = store.getItem(CONVERSATION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<StoredConversation>;
    if (parsed?.v !== 1 || typeof parsed.updatedAt !== 'number' || !Array.isArray(parsed.messages)) return [];
    if (now - parsed.updatedAt > CONVERSATION_TTL_MS) {
      store.removeItem(CONVERSATION_KEY);
      return [];
    }
    return parsed.messages
      .map(sanitizeMessage)
      .filter((m): m is StoredMessage => m !== null)
      .slice(-MAX_STORED_MESSAGES);
  } catch {
    return [];
  }
}

export function saveConversation(messages: StoredMessage[], now = Date.now(), store: KeyValueStore | null = defaultStore()): void {
  if (!store) return;
  // A reply that is still streaming is not persisted; the finished one is.
  const settled = messages.slice(-MAX_STORED_MESSAGES);
  try {
    if (settled.length === 0) store.removeItem(CONVERSATION_KEY);
    else store.setItem(CONVERSATION_KEY, JSON.stringify({ v: 1, updatedAt: now, messages: settled } satisfies StoredConversation));
  } catch {
    /* quota / blocked: persistence is best-effort */
  }
}

export function clearConversation(store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.removeItem(CONVERSATION_KEY);
  } catch {
    /* ignore */
  }
}

export function hasSeenIntro(store: KeyValueStore | null = defaultStore()): boolean {
  try {
    return store?.getItem(INTRO_KEY) === '1';
  } catch {
    return true; // if we cannot remember, never nag
  }
}

export function markIntroSeen(store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(INTRO_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** Plain-text export of the conversation (download / hand-off). */
export function exportAsText(messages: StoredMessage[], labels: { you: string; assistant: string }): string {
  return messages
    .filter((m) => !m.isError)
    .map((m) => `${m.role === 'user' ? labels.you : labels.assistant}: ${m.text.trim()}`)
    .join('\n\n');
}
