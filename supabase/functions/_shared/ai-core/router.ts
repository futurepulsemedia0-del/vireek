// supabase/functions/_shared/ai-core/router.ts
//
// Vireek AI Core — AI Router. Walks a task's provider chain in priority
// order, skips unconfigured providers, retries once on transient errors,
// falls through to the next provider. Never infinite loops.

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
    return { ok: true, response: { ...response, model: response.model || model } };
  } catch (err) {
    if (err instanceof AiCoreError) return { ok: false, code: err.code };
    return { ok: false, code: "PROVIDER_ERROR" };
  }
}

export async function routeChat(
  task: TaskType,
  req: NormalizedChatRequest,
): Promise<RouteChatResult> {
  const route = getRouteForTask(task);
  const attempts: RouteAttemptLog[] = [];
  let isFirstAttempt = true;

  for (const entry of route) {
    const adapter = ALL_ADAPTERS[entry.provider];
    if (!adapter) continue;
    if (!adapter.isConfigured()) continue;

    const start = Date.now();
    let result = await attemptOnce(entry.provider, entry.model, req);

    if (!result.ok && RETRYABLE_CODES.has(result.code)) {
      result = await attemptOnce(entry.provider, entry.model, req);
    }

    const latencyMs = Date.now() - start;

    if (result.ok) {
      attempts.push({ provider: entry.provider, model: entry.model, ok: true, latencyMs });
      return { response: { ...result.response, wasFallback: !isFirstAttempt }, attempts };
    }

    attempts.push({ provider: entry.provider, model: entry.model, ok: false, errorCode: result.code, latencyMs });
    isFirstAttempt = false;
  }

  throw new AiCoreError(
    "ALL_PROVIDERS_FAILED",
    `All configured providers failed for task "${task}". Attempts: ${JSON.stringify(attempts)}`,
  );
}
