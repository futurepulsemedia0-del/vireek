// supabase/functions/_shared/ai-core/sse.ts
//
// NEW FILE — small shared helper for reading a Server-Sent-Events HTTP
// response body line-by-line. Every streaming-capable provider (Gemini,
// the OpenAI-compatible ones, Cloudflare) speaks SSE on the wire, so this
// is the one place that turns "a fetch Response" into "a sequence of raw
// `data: ...` payload strings" — providers only ever deal with their own
// JSON payload shape, never with chunk boundaries or partial lines.
//
// Save this as: supabase/functions/_shared/ai-core/sse.ts (new file,
// nothing to delete — just add it next to router.ts).

/**
 * Reads an SSE response body and yields each event's raw payload (the
 * text after "data: "), in order. Skips blank keep-alive lines and the
 * terminal "[DONE]" sentinel some providers send. Handles chunks that
 * split a line (or an event) across multiple network reads.
 */
export async function* readSseEvents(res: Response): AsyncGenerator<string> {
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Last element may be an incomplete line — keep it in the buffer
      // until more bytes arrive.
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
