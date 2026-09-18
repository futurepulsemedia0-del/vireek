// supabase/functions/_shared/ai-core/promiseExtraction.ts
//
// Promise Tracker — pulls concrete commitments the business (Sarah or a
// human) made to the caller out of a completed call transcript.
//
// Deliberately hybrid: the LLM only judges WHAT was promised and roughly
// WHEN in relative terms ("tomorrow morning," "within the hour") — it
// never outputs a timestamp itself, since an LLM computing "now + X" is
// exactly the kind of arithmetic-dressed-as-language task that quietly
// drifts wrong. The caller (vapi-webhook) turns due_hours_estimate into
// a real due_at using the call's actual end time. Same split used in
// Price Book Enforcement: AI extracts meaning, code does the math.
//
// Called once per call from vapi-webhook's end-of-call-report handler,
// alongside (not instead of) analyzeCallIntelligence. Never throws — a
// failure here must not block the underlying calls-row upsert.

import { askVireekAi } from "./index.ts";

export interface ExtractedPromise {
  promise_text: string;
  category: "callback" | "arrival_time" | "pricing" | "follow_up" | "documentation" | "other";
  due_description: string | null;
  due_hours_estimate: number | null;
}

const VALID_CATEGORIES = new Set(["callback", "arrival_time", "pricing", "follow_up", "documentation", "other"]);

export async function extractPromises(transcript: string): Promise<ExtractedPromise[]> {
  if (!transcript || transcript.trim().length < 20) return [];

  try {
    const result = await askVireekAi({
      task: "promise_extraction",
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.1,
      messages: [{ role: "user", content: `Transcript:\n${transcript.slice(0, 8000)}` }],
    });

    const parsed = JSON.parse(result.text);
    const rawPromises = Array.isArray(parsed.promises) ? parsed.promises : [];

    return rawPromises
      .slice(0, 5)
      .map((p: unknown): ExtractedPromise | null => {
        if (typeof p !== "object" || p === null) return null;
        const obj = p as Record<string, unknown>;
        const promiseText = typeof obj.promise_text === "string" ? obj.promise_text.trim().slice(0, 300) : "";
        if (!promiseText) return null;

        const hoursRaw = obj.due_hours_estimate;
        const hours = typeof hoursRaw === "number" && Number.isFinite(hoursRaw) && hoursRaw >= 0 && hoursRaw <= 24 * 30
          ? hoursRaw
          : null;

        return {
          promise_text: promiseText,
          category: VALID_CATEGORIES.has(obj.category as string) ? (obj.category as ExtractedPromise["category"]) : "other",
          due_description: typeof obj.due_description === "string" ? obj.due_description.trim().slice(0, 100) : null,
          due_hours_estimate: hours,
        };
      })
      .filter((p: ExtractedPromise | null): p is ExtractedPromise => p !== null);
  } catch (err) {
    console.error("extractPromises failed:", err);
    return []; // caller just skips promise tracking for this call
  }
}

/**
 * Deterministic — no AI. Turns an LLM's rough relative estimate into a
 * real timestamp anchored to when the call actually ended.
 */
export function computeDueAt(callEndedAt: Date, hoursEstimate: number | null): string | null {
  if (hoursEstimate === null) return null;
  return new Date(callEndedAt.getTime() + hoursEstimate * 3600_000).toISOString();
}
