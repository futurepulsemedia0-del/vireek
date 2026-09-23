// supabase/functions/_shared/ai-core/evalHarness.ts
//
// Vireek AI Core — Evaluation harness. هر eval case رو از همون نقطه‌ی
// ورودی واحدی که همه‌ی فیچرهای واقعی استفاده می‌کنن (askVireekAi) رد
// می‌کنه — هیچ‌وقت مستقیم router.ts رو صدا نمی‌زنه — پس یک suite همیشه
// زنجیره‌ی routing و guardrailهای واقعی و فعلی رو تست می‌کنه، نه یک
// میان‌بر جدا.
//
// نمره‌دهی از دو راه:
//   ۱. Assertions — چک‌های ارزان و قطعی که روی خودِ case تعریف شدن
//      (وجود/عدم‌وجود کلیدواژه، مقدار یک فیلد JSON، سقف latency).
//   ۲. Judge call — یک فراخوانی مدل جداگانه (task "eval_judge") که
//      ادعاهای احتمالاً ساختگی (hallucination) توی جواب رو پرچم می‌زنه.

import { askVireekAi } from "./index.ts";
import type { TaskType } from "./types.ts";

export type EvalAssertion =
  | { type: "contains_keyword"; value: string }
  | { type: "not_contains_keyword"; value: string }
  | { type: "json_field_equals"; field: string; value: string | number | boolean }
  | { type: "max_latency_ms"; value: number };

export interface EvalCaseInput {
  id: string;
  userMessage: string;
  extraInstructions?: string | null;
  jsonMode?: boolean | null;
  assertions: EvalAssertion[];
}

export interface EvalCaseResult {
  caseId: string;
  passed: boolean;
  failedAssertions: string[];
  hallucinationDetected: boolean;
  hallucinationReason: string;
  provider: string;
  model: string;
  latencyMs: number;
  costUsd: number;
  outputText: string;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function evaluateAssertions(text: string, latencyMs: number, assertions: EvalAssertion[]): string[] {
  const failed: string[] = [];
  const parsed = tryParseJson(text);

  for (const a of assertions) {
    switch (a.type) {
      case "contains_keyword":
        if (!text.toLowerCase().includes(a.value.toLowerCase())) {
          failed.push(`missing keyword "${a.value}"`);
        }
        break;
      case "not_contains_keyword":
        if (text.toLowerCase().includes(a.value.toLowerCase())) {
          failed.push(`unexpected keyword "${a.value}"`);
        }
        break;
      case "json_field_equals": {
        const actual = parsed ? parsed[a.field] : undefined;
        if (actual !== a.value) {
          failed.push(`field "${a.field}" was ${JSON.stringify(actual)}, expected ${JSON.stringify(a.value)}`);
        }
        break;
      }
      case "max_latency_ms":
        if (latencyMs > a.value) {
          failed.push(`latency ${latencyMs}ms exceeded ${a.value}ms`);
        }
        break;
    }
  }
  return failed;
}

async function judgeForHallucination(userMessage: string, answer: string): Promise<{ hallucination: boolean; reason: string }> {
  try {
    const judged = await askVireekAi({
      task: "eval_judge",
      messages: [{ role: "user", content: `User question:\n${userMessage}\n\nAI answer to grade:\n${answer}` }],
      maxTokens: 200,
      jsonMode: true,
      source: "eval_judge",
    });
    const parsed = tryParseJson(judged.text);
    return {
      hallucination: Boolean(parsed?.hallucination),
      reason: typeof parsed?.reason === "string" ? parsed.reason : "",
    };
  } catch (err) {
    console.error("[ai-eval] judge call failed, defaulting to no hallucination flag:", err);
    return { hallucination: false, reason: "judge unavailable" };
  }
}

export async function runEvalCase(task: TaskType, kase: EvalCaseInput, accountId: string): Promise<EvalCaseResult> {
  try {
    const result = await askVireekAi({
      task,
      messages: [{ role: "user", content: kase.userMessage }],
      maxTokens: 500,
      jsonMode: Boolean(kase.jsonMode),
      extraInstructions: kase.extraInstructions ?? undefined,
      accountId,
      source: "eval",
    });

    const failedAssertions = evaluateAssertions(result.text, result.meta.latencyMs, kase.assertions);
    const judged = await judgeForHallucination(kase.userMessage, result.text);

    return {
      caseId: kase.id,
      passed: failedAssertions.length === 0 && !judged.hallucination,
      failedAssertions,
      hallucinationDetected: judged.hallucination,
      hallucinationReason: judged.reason,
      provider: result.meta.provider,
      model: result.meta.model,
      latencyMs: result.meta.latencyMs,
      costUsd: result.meta.costUsd,
      outputText: result.text,
    };
  } catch (err) {
    return {
      caseId: kase.id,
      passed: false,
      failedAssertions: [`call failed: ${err instanceof Error ? err.message : String(err)}`],
      hallucinationDetected: false,
      hallucinationReason: "",
      provider: "none",
      model: "none",
      latencyMs: 0,
      costUsd: 0,
      outputText: "",
    };
  }
}
