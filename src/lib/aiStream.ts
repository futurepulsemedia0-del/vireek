// src/lib/aiStream.ts
//
// NEW FILE — shared helper for calling one of our streaming Edge
// Functions (`demo-chat`, `site-assistant`) and getting text back as it's
// generated instead of waiting for the whole reply.
//
// `supabase.functions.invoke()` always waits for and parses a full JSON
// response, so it can't be used for this — this helper talks to the same
// Edge Function URL directly with `fetch`, using the exact auth headers
// the Supabase client would send, and reads the response body as it
// arrives.
//
// Save this as: src/lib/aiStream.ts (new file, add it next to
// src/lib/supabase.ts — nothing to delete).

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface StreamChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface StreamAiChatOptions {
  /** Edge Function name, e.g. "demo-chat" or "site-assistant". */
  functionName: string;
  message: string;
  history: StreamChatMessage[];
  /** Extra fields merged into the POST body alongside message/history — e.g. onboarding-concierge's `known` snapshot. */
  extraBody?: Record<string, unknown>;
  /** Called once per chunk of reply text, in order, as it arrives. */
  onDelta: (delta: string) => void;
  /** Called once, before any delta, if the server sends a structured `fields` payload (used by onboarding-concierge). */
  onFields?: (fields: Record<string, unknown>) => void;
  /** Called once the stream ends normally. */
  onDone?: (meta: { provider?: string; model?: string }) => void;
  /** Called if the server (or the network) reports a failure. */
  onError: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * POSTs to a streaming Edge Function and forwards each Server-Sent-Event
 * chunk to `onDelta` as it arrives. Resolves once the stream is fully
 * read (whether it ended in success or a reported error) — errors are
 * delivered via `onError`, not by throwing, except for outright network
 * failures which are also funneled into `onError` so callers only need
 * one failure path.
 */
export async function streamAiChat({
  functionName,
  message,
  history,
  extraBody,
  onDelta,
  onFields,
  onDone,
  onError,
  signal,
}: StreamAiChatOptions): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ message, history, ...extraBody }),
    });
  } catch {
    onError("I'm having trouble responding right now — please try again in a moment.");
    return;
  }

  // Pre-flight failures (validation, rate limit) come back as plain JSON,
  // not a stream — handle that shape before assuming an SSE body.
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream')) {
    let errorMessage = 'Something went wrong. Please try again.';
    try {
      const data = await res.json();
      if (typeof data?.error === 'string') errorMessage = data.error;
    } catch {
      // keep the generic fallback
    }
    onError(errorMessage);
    return;
  }

  if (!res.body) {
    onError('Something went wrong. Please try again.');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawError = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;

        let parsed: { delta?: string; done?: boolean; error?: string; provider?: string; model?: string; fields?: Record<string, unknown> };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        if (parsed.error) {
          sawError = true;
          onError(parsed.error);
        } else if (parsed.fields) {
          onFields?.(parsed.fields);
        } else if (typeof parsed.delta === 'string' && parsed.delta) {
          onDelta(parsed.delta);
        } else if (parsed.done) {
          onDone?.({ provider: parsed.provider, model: parsed.model });
        }
      }
    }
  } catch {
    if (!sawError) onError("I'm having trouble responding right now — please try again in a moment.");
  } finally {
    reader.releaseLock();
  }
}
