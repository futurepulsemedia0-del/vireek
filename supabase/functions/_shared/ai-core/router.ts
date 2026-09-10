// supabase/functions/_shared/ai-core/router.ts
//
// Vireek AI Core — AI Router.
//
// Walks a task's provider chain (from registry.ts) in priority order,
// skips unconfigured providers without spending a network call, retries
// each configured provider once on a transient error, and falls through
// to the next provider on any failure. Never retries infinitely. If every
// provider fails, throws ONE normalized AiCoreError — callers turn that
// into a clean user-facing message, never a raw stack trace.

import type { NormalizedChatRequest, NormalizedChatResponse, ProviderId, TaskType } from "./types.ts";
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
  /** Observability trail — every provider tried, in order, with outcome.
   *  Safe to log: contains no user content, no secrets. */
  attempts: RouteAttemptLog[];
}

const RETRYABLE_CODES = new Set(["TIMEOUT", "RATE_LIMIT", "PROVIDER_ERROR"]);

async function attemptOnce(
  providerId: ProviderId,
  model: string,
  req: NormalizedChatRequest,
): Promise<{ ok: true; response: NormalizedChatResponse } | { ok: false; code: string }> {
  const adapter = ALL_ADAPTERS[providerId];
  if (!adapter) return { ok: false, code: "NOT_CONFIGURED" };
  try {
    const response = await adapter.chat({ ...req, timeoutMs: req.timeoutMs });
    // The adapter doesn't know its own configured model override from the
    // route table (it only knows its own env default) — stamp it here so
    // observability reflects what the ROUTE actually asked for.
    return { ok: true, response: { ...response, model: response.model || model } };
  } catch (err) {
    if (err instanceof AiCoreError) return { ok: false, code: err.code };
    return { ok: false, code: "PROVIDER_ERROR" };
  }
}

/**
 * Route a chat request for a given task through its configured provider
 * chain. This is the single entry point every edge function should call —
 * never call an adapter directly.
 */
export async function routeChat(
  task: TaskType,
  req: NormalizedChatRequest,
): Promise<RouteChatResult> {
  const route = getRouteForTask(task);
  const attempts: RouteAttemptLog[] = [];

  let isFirstAttempt = true;

  for (const entry of route) {
    const adapter = ALL_ADAPTERS[entry.provider];
    if (!adapter) continue; // provider not registered/available at all — skip silently

    if (!adapter.isConfigured()) {
      // Not logged as an "attempt" — no network call was made, no point
      // cluttering observability with providers that were never set up.
      continue;
    }

    const start = Date.now();
    let result = await attemptOnce(entry.provider, entry.model, req);

    // One controlled retry, only for transient-looking failures, only
    // once — never an infinite loop, never for AUTH/NOT_CONFIGURED/
    // INVALID_RESPONSE (retrying those just wastes the timeout budget).
    if (!result.ok && RETRYABLE_CODES.has(result.code)) {
      result = await attemptOnce(entry.provider, entry.model, req);
    }

    const latencyMs = Date.now() - start;

    if (result.ok) {
      attempts.push({ provider: entry.provider, model: entry.model, ok: true, latencyMs });
      return {
        response: { ...result.response, wasFallback: !isFirstAttempt },
        attempts,
      };
    }

    attempts.push({
      provider: entry.provider,
      model: entry.model,
      ok: false,
      errorCode: result.code,
      latencyMs,
    });
    isFirstAttempt = false;
  }

  throw new AiCoreError(
    "ALL_PROVIDERS_FAILED",
    `All configured providers failed for task "${task}". Attempts: ${JSON.stringify(attempts)}`,
  );
}
