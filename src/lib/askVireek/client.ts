// src/lib/askVireek/client.ts
//
// Typed streaming client for the public `site-assistant` Edge Function.
// Dedicated (instead of widening src/lib/aiStream.ts, which other features share)
// because the assistant needs HTTP status classes (rate limit / offline), the
// answer id for feedback, source links, follow-ups and the hand-off signal.
//
// Wire format (one JSON object per SSE "data:" line):
//   {answerId} {sources:[{title,url}]} {delta} {suggestions:[..]}
//   {handoff:{reason}} {done:true,...} {error:"..."}

import type { SourceRef } from './storage';

export type HandoffReason = 'user_requested_human' | 'low_confidence' | 'frustrated' | 'account_action';
export type FailureKind = 'offline' | 'rate_limited' | 'invalid' | 'error';

export interface SiteAssistantEvent {
  answerId?: string;
  sources?: SourceRef[];
  delta?: string;
  suggestions?: string[];
  handoff?: { reason: HandoffReason };
  done?: boolean;
  error?: string;
}

const HANDOFF_REASONS: readonly string[] = ['user_requested_human', 'low_confidence', 'frustrated', 'account_action'];

/** Splits a streamed buffer into complete events plus the unfinished tail. */
export function parseSseBuffer(buffer: string): { events: SiteAssistantEvent[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events: SiteAssistantEvent[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const o = JSON.parse(payload) as Record<string, unknown>;
      const ev: SiteAssistantEvent = {};
      if (typeof o.answerId === 'string' && /^[0-9a-f-]{36}$/i.test(o.answerId)) ev.answerId = o.answerId;
      if (typeof o.delta === 'string') ev.delta = o.delta;
      if (typeof o.error === 'string') ev.error = o.error;
      if (o.done === true) ev.done = true;
      if (Array.isArray(o.sources)) {
        ev.sources = o.sources
          .filter((s): s is SourceRef => typeof (s as SourceRef)?.title === 'string' && typeof (s as SourceRef)?.url === 'string')
          .filter((s) => s.url.startsWith('/') && !s.url.startsWith('//'))
          .slice(0, 3)
          .map((s) => ({ title: s.title.slice(0, 80), url: s.url.slice(0, 200) }));
      }
      if (Array.isArray(o.suggestions)) ev.suggestions = o.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4);
      const h = o.handoff as { reason?: unknown } | undefined;
      if (h && typeof h === 'object') {
        ev.handoff = { reason: HANDOFF_REASONS.includes(String(h.reason)) ? (h.reason as HandoffReason) : 'low_confidence' };
      }
      events.push(ev);
    } catch {
      /* partial / non-JSON line: ignore */
    }
  }
  return { events, rest };
}

export function classifyStatus(status: number): FailureKind {
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 413) return 'invalid';
  return 'error';
}

export interface AskOptions {
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Current pathname — lets the server tailor suggestions and tone to the page. */
  page: string;
  signal?: AbortSignal;
  onEvent: (e: SiteAssistantEvent) => void;
  onFailure: (kind: FailureKind, message?: string) => void;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  anonKey?: string;
  isOnline?: () => boolean;
}

export async function askSiteAssistant(opts: AskOptions): Promise<void> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? (import.meta.env.VITE_SUPABASE_URL as string);
  const anonKey = opts.anonKey ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string);
  const online = opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  if (!online()) {
    opts.onFailure('offline');
    return;
  }

  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/functions/v1/site-assistant`, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}`, apikey: anonKey },
      body: JSON.stringify({ message: opts.message, history: opts.history, page: opts.page }),
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    opts.onFailure(online() ? 'error' : 'offline');
    return;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
    let message: string | undefined;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      /* keep generic */
    }
    opts.onFailure(res.ok ? 'error' : classifyStatus(res.status), message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;
      for (const ev of parsed.events) {
        if (ev.error) {
          failed = true;
          opts.onFailure('error', ev.error);
        } else opts.onEvent(ev);
      }
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError' && !failed) opts.onFailure(online() ? 'error' : 'offline');
  } finally {
    reader.releaseLock();
  }
}
