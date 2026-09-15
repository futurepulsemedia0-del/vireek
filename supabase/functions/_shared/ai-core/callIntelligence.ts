// supabase/functions/_shared/ai-core/callIntelligence.ts
//
// Post-call analysis: turns a raw transcript into structured business
// intelligence (call_score, lead_score, intent, booking_outcome, missed
// opportunity, recommended follow-up) and finally gives real values to
// `calls.sentiment`, which was in the schema and wired into
// CallsPage.tsx's filter/sort/display but never actually set by anything
// until now.
//
// Called once per call from vapi-webhook's end-of-call-report handler.
// Never throws — a failure here must not block the underlying calls-row
// upsert, since this is enrichment, not the source of truth for the call.

import { askVireekAi } from "./index.ts";

export interface CallIntelligence {
  call_score: number;
  sentiment: "positive" | "neutral" | "negative";
  lead_score: number;
  intent: string;
  booking_outcome: "booked" | "not_booked" | "already_scheduled" | "not_applicable";
  missed_opportunity_reason: string | null;
  recommended_follow_up: string | null;
  objections_raised: string[];
}

const VALID_SENTIMENT = new Set(["positive", "neutral", "negative"]);
const VALID_OUTCOME = new Set(["booked", "not_booked", "already_scheduled", "not_applicable"]);

function clampScore(n: unknown): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return 50;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export async function analyzeCallIntelligence(
  transcript: string,
  summary: string | null,
): Promise<CallIntelligence | null> {
  if (!transcript || transcript.trim().length < 20) return null; // too short to judge meaningfully

  try {
    const result = await askVireekAi({
      task: "call_intelligence",
      jsonMode: true,
      maxTokens: 500,
      temperature: 0.2,
      messages: [
        { role: "user", content: `Call summary: ${summary ?? "(none)"}\n\nTranscript:\n${transcript.slice(0, 8000)}` },
      ],
    });

    const parsed = JSON.parse(result.text);

    return {
      call_score: clampScore(parsed.call_score),
      sentiment: VALID_SENTIMENT.has(parsed.sentiment) ? parsed.sentiment : "neutral",
      lead_score: clampScore(parsed.lead_score),
      intent: typeof parsed.intent === "string" ? parsed.intent.slice(0, 100) : "unknown",
      booking_outcome: VALID_OUTCOME.has(parsed.booking_outcome) ? parsed.booking_outcome : "not_applicable",
      missed_opportunity_reason: typeof parsed.missed_opportunity_reason === "string" ? parsed.missed_opportunity_reason.slice(0, 500) : null,
      recommended_follow_up: typeof parsed.recommended_follow_up === "string" ? parsed.recommended_follow_up.slice(0, 500) : null,
      objections_raised: Array.isArray(parsed.objections_raised)
        ? parsed.objections_raised.filter((o: unknown) => typeof o === "string").slice(0, 10)
        : [],
    };
  } catch (err) {
    console.error("analyzeCallIntelligence failed:", err);
    return null; // caller keeps whatever it already had
  }
}
