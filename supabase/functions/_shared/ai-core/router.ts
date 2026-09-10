// supabase/functions/_shared/ai-core/router.ts
//
// Vireek AI Core — Router. Walks a task's provider chain in priority
// order, skips unconfigured providers, retries once on transient errors,
// falls through to the next provider on ANY failure. Finite — never loops
// forever, and the outer loop always advances regardless of error type.

import type {
  ChatStreamHandler,
  NormalizedChatRequest,
  NormalizedChatResponse,
  ProviderId,
  TaskType,
} from "./types.ts";
import { AiCoreError } from "./types.ts";
import { ALL_ADAPTERS, getRouteForTask } from "./registry.ts";

interface RouteAttemptLog {
  provider: string;
  model: string;
  ok: boolean;
  errorCode?: string;
  latencyMs: number;
}

export interface RouteChatResult {
  response: NormalizedChatResponse;
  attempts: RouteAttemptLog[];
}

// Errors worth one immediate retry on the SAME provider before moving on.
// AUTH / NOT_CONFIGURED are not retried — retrying them wastes a request
// for a guaranteed-repeat failure — the router just advances to the next
// provider in the chain instead.
const RETRYABLE_CODES = new Set(["TIMEOUT", "RATE_LIMIT", "PROVIDER_ERROR"]);

async function attemptOnce(
  providerId: ProviderId,
  model: string,
  req: NormalizedChatRequest,
): Promise<{ ok: true; response: NormalizedChatResponse } | { ok: false; code: string }> {
  const adapter = ALL_ADAPTERS[providerId];
  if (!adapter) return { ok: false, code: "NOT_CONFIGURED" };
  try {
    const response = await adapter.chat(req);
    return { ok: true, response: { ...response, model: response.model || model } };
  } catch (err) {
    if (err instanceof AiCoreError) return { ok: false, code: err.code };
    return { ok: false, code: "PROVIDER_ERROR" };
  }
}

export async function routeChat(task: TaskType, req: NormalizedChatRequest): Promise<RouteChatResult> {
  const route = getRouteForTask(task);
  const attempts: RouteAttemptLog[] = [];
  let isFirstAttempt = true;

  for (const entry of route) {
    const adapter = ALL_ADAPTERS[entry.provider];
    if (!adapter || !adapter.isConfigured()) continue; // no key set -> skip silently, no crash

    const start = Date.now();
    let result = await attemptOnce(entry.provider, entry.model, req);

    if (!result.ok && RETRYABLE_CODES.has(result.code)) {
      result = await attemptOnce(entry.provider, entry.model, req); // single retry, same provider
    }

    const latencyMs = Date.now() - start;

    if (result.ok) {
      attempts.push({ provider: entry.provider, model: entry.model, ok: true, latencyMs });
      return { response: { ...result.response, wasFallback: !isFirstAttempt }, attempts };
    }

    attempts.push({ provider: entry.provider, model: entry.model, ok: false, errorCode: result.code, latencyMs });
    isFirstAttempt = false;
    // falls through to the next provider in `route` regardless of error code
  }

  // Every configured provider failed (or none were configured at all).
  // No secret values or raw provider responses are included here — only
  // provider names, error codes, and latency.
  throw new AiCoreError(
    "ALL_PROVIDERS_FAILED",
    `All configured providers failed for task "${task}". Attempts: ${JSON.stringify(attempts)}`,
  );
}

/**
 * Streaming counterpart to `routeChat`. Walks the same provider chain in
 * the same order, but delivers text to `onDelta` as it arrives instead of
 * waiting for a complete reply.
 *
 * Fallback rule: a provider is only abandoned mid-attempt if it fails
 * BEFORE sending its first chunk (bad key, timeout connecting, non-2xx,
 * etc.) — at that point nothing has reached the caller yet, so moving to
 * the next provider is invisible to the end user. Once a provider has
 * started streaming real content, we're committed to it: there is no way
 * to "unsend" text a person is already reading, so if it dies mid-stream
 * we simply end the stream with whatever was produced (the calling edge
 * function still gets a well-formed result, just possibly shorter than
 * a full answer) instead of throwing away visible progress.
 *
 * A provider with no `chatStream` implementation still participates: its
 * plain `chat()` reply is delivered as a single chunk, so every entry in
 * the chain "streams" from the router's point of view even if not every
 * adapter streams on the wire.
 */
export async function routeChatStream(
  task: TaskType,
  req: NormalizedChatRequest,
  onDelta: ChatStreamHandler,
): Promise<RouteChatResult> {
  const route = getRouteForTask(task);
  const attempts: RouteAttemptLog[] = [];
  let isFirstAttempt = true;

  for (const entry of route) {
    const adapter = ALL_ADAPTERS[entry.provider];
    if (!adapter || !adapter.isConfigured()) continue;

    const start = Date.now();
    let sentAnything = false;
    const guardedOnDelta: ChatStreamHandler = (delta) => {
      if (delta) sentAnything = true;
      onDelta(delta);
    };

    try {
      const response = adapter.chatStream
        ? await adapter.chatStream(req, guardedOnDelta)
        : await adapter.chat(req).then((r) => {
            if (r.text) guardedOnDelta(r.text);
            return r;
          });

      const latencyMs = Date.now() - start;
      attempts.push({ provider: entry.provider, model: entry.model, ok: true, latencyMs });
      return {
        response: { ...response, model: response.model || entry.model, wasFallback: !isFirstAttempt },
        attempts,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const code = err instanceof AiCoreError ? err.code : "PROVIDER_ERROR";
      attempts.push({ provider: entry.provider, model: entry.model, ok: false, errorCode: code, latencyMs });

      if (sentAnything) {
        // Content already reached the caller — end the stream here rather
        // than trying (and failing) to hand off to a different provider.
        return {
          response: {
            text: "",
            provider: entry.provider,
            model: entry.model,
            latencyMs,
            wasFallback: !isFirstAttempt,
          },
          attempts,
        };
      }

      isFirstAttempt = false;
      // Nothing was sent yet for this provider — safe to fall through.
    }
  }

  throw new AiCoreError(
    "ALL_PROVIDERS_FAILED",
    `All configured providers failed for task "${task}". Attempts: ${JSON.stringify(attempts)}`,
  );
}
