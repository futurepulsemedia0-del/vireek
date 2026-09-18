// supabase/functions/_shared/ai-core/guardrails.ts
//
// Vireek AI Core — Runtime AI Guardrails.
// The single choke point for input/output safety checks on every AI
// call in the system. Only askVireekAi / askVireekAiStream call this —
// nothing else should import it directly.

import type { ChatMessage, TaskType } from "./types.ts";
import { AiCoreError } from "./types.ts";

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_TOTAL_INPUT_CHARS = 12000;

// Prompt-injection / jailbreak attempts in the USER turn.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all|any|the) (previous|prior|above) (instructions?|rules?|prompts?)/i,
  /disregard (all|any|the) (previous|prior|above)/i,
  /you are (now|no longer) (a|an|bound)/i,
  /act as (if you|though you)/i,
  /pretend (you are|to be)/i,
  /reveal (your|the) (system prompt|instructions|prompt)/i,
  /(what|show|print|output) (is|are) your (system prompt|instructions)/i,
  /repeat (the|your) (words|instructions|prompt) above/i,
  /\bDAN\b.{0,20}(mode|prompt)/i,
  /jailbreak/i,
  /developer mode/i,
  /\bsystem\s*:\s*/i,
  /\[\s*system\s*\]/i,
];

// Phrases that, in a MODEL reply, almost always mean the system prompt
// or internal instructions leaked (directly or paraphrased).
const IDENTITY_LEAK_PATTERNS: RegExp[] = [
  /as an ai language model/i,
  /my (system prompt|instructions) (are|is|say)/i,
  /i (was|am) (told|instructed) to/i,
  /non-negotiable rules/i,
  /BASE_IDENTITY/i,
  /TASK_INSTRUCTIONS/i,
];

// Lightweight, high-precision PII safety net (not a full DLP layer).
const PII_PATTERNS: RegExp[] = [
  /\b(?:\d[ -]*?){13,16}\b/, // card-number-shaped digit runs
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-shaped
];

const BLOCKED_REPLY_MESSAGE =
  "I can't help with that request. Let's get back to what I can actually help you with.";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface GuardrailContext {
  task: TaskType;
  jsonMode?: boolean;
}

function logViolation(stage: "input" | "output", rule: string, detail: string, ctx: GuardrailContext): void {
  // Structured so it's greppable in Supabase edge-function logs.
  console.warn(`[guardrails] stage=${stage} task=${ctx.task} rule=${rule} detail=${detail}`);
}

// ---------------------------------------------------------------------
// Input guardrails
// ---------------------------------------------------------------------

/**
 * Runs before every provider call. Throws AiCoreError("GUARDRAIL_BLOCKED")
 * only for outright abuse (oversized request); injection attempts are
 * defanged (quoted) rather than hard-blocked, to avoid false-positive
 * refusals — the identity layer already tells the model to treat
 * embedded instructions as reported speech, not commands.
 */
export function runInputGuardrails(
  messages: ChatMessage[],
  ctx: GuardrailContext,
): ChatMessage[] {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > MAX_TOTAL_INPUT_CHARS) {
    logViolation("input", "max_total_chars", `${total}`, ctx);
    throw new AiCoreError("GUARDRAIL_BLOCKED", "Request too long.");
  }

  return messages.map((m) => {
    if (m.role !== "user") return m;

    let content = m.content;

    if (content.length > MAX_USER_MESSAGE_CHARS) {
      const before = content.length;
      content = content.slice(0, MAX_USER_MESSAGE_CHARS);
      logViolation("input", "truncated", `${before}->${content.length}`, ctx);
    }

    for (const re of INJECTION_PATTERNS) {
      if (re.test(content)) {
        logViolation("input", "injection_attempt", re.source, ctx);
        content = content.replace(re, (hit) => `"${hit}"`);
      }
    }

    return { ...m, content };
  });
}

// ---------------------------------------------------------------------
// Output guardrails
// ---------------------------------------------------------------------

export interface OutputGuardrailResult {
  text: string;
  blocked: boolean;
}

function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : text.trim();
}

function redactPii(text: string): string {
  let out = text;
  for (const re of PII_PATTERNS) {
    out = out.replace(new RegExp(re.source, "g"), "[redacted]");
  }
  return out;
}

/**
 * Runs on the full model reply. For jsonMode tasks it also strips
 * markdown fences and validates the result actually parses as JSON, so
 * a malformed reply never reaches JSON.parse deeper in the call stack.
 */
export function runOutputGuardrails(
  rawText: string,
  ctx: GuardrailContext,
): OutputGuardrailResult {
  let text = rawText;

  for (const re of IDENTITY_LEAK_PATTERNS) {
    if (re.test(text)) {
      logViolation("output", "identity_leak", re.source, ctx);
      return { text: BLOCKED_REPLY_MESSAGE, blocked: true };
    }
  }

  text = redactPii(text);

  if (ctx.jsonMode) {
    const candidate = stripJsonFences(text);
    try {
      JSON.parse(candidate);
      text = candidate;
    } catch {
      logViolation("output", "invalid_json", candidate.slice(0, 120), ctx);
      throw new AiCoreError("GUARDRAIL_BLOCKED", "Model returned malformed JSON.");
    }
  }

  return { text, blocked: false };
}

// ---------------------------------------------------------------------
// Streaming guard — rolling-window scan so a leak can be caught
// mid-stream. Note: this suppresses further forwarded tokens once
// tripped; it can't un-send tokens already forwarded to the client.
// ---------------------------------------------------------------------

export function createStreamGuard(ctx: GuardrailContext) {
  let buffer = "";
  let blocked = false;

  return {
    check(delta: string): { forward: string; abort: boolean } {
      if (blocked) return { forward: "", abort: true };

      buffer = (buffer + delta).slice(-400);
      for (const re of IDENTITY_LEAK_PATTERNS) {
        if (re.test(buffer)) {
          logViolation("output", "identity_leak_stream", re.source, ctx);
          blocked = true;
          return { forward: "", abort: true };
        }
      }
      return { forward: delta, abort: false };
    },
    isBlocked: () => blocked,
  };
}
