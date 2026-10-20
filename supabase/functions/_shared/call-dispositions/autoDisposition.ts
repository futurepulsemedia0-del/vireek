/**
 * AI call dispositions — deterministic, high-confidence auto-tagging.
 *
 * Runs once when a call ends (vapi-webhook, end-of-call-report). It ONLY tags
 * outcomes the call data already proves; anything ambiguous is left for staff
 * (the dashboard shows a one-tap suggestion). No LLM call, no extra latency
 * risk, and it can never throw into the webhook.
 *
 *   spam      <- calls.status = 'spam'
 *   booked    <- calls.booking_outcome = 'booked' OR calls.status = 'booked'
 *   no_answer <- voicemail, or <=10s with no transcript   (+ creates a call-back task)
 *
 * Rows are written with source = 'ai' and ai_outcome = the pick, so Analytics
 * can report how often staff agree. Existing dispositions are never touched
 * (ON CONFLICT DO NOTHING): a human decision always wins.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type AutoOutcome = "spam" | "booked" | "no_answer";

export interface CallFacts {
  status: string | null;
  booking_outcome: string | null;
  is_voicemail: boolean | null;
  duration_seconds: number | null;
  transcript: string | null;
}

export function classifyCallOutcome(c: CallFacts): { outcome: AutoOutcome; confidence: number } | null {
  if (c.status === "spam") return { outcome: "spam", confidence: 0.95 };
  if (c.booking_outcome === "booked" || c.status === "booked") return { outcome: "booked", confidence: 0.9 };
  if (c.is_voicemail || (!(c.transcript ?? "").trim() && (c.duration_seconds ?? 0) <= 10)) {
    return { outcome: "no_answer", confidence: 0.75 };
  }
  return null;
}

export interface AutoTagResult {
  tagged: boolean;
  outcome?: AutoOutcome;
  taskCreated?: boolean;
  reason?: string;
}

export async function autoTagCallDisposition(
  admin: SupabaseClient,
  args: { callId: string; userId: string },
): Promise<AutoTagResult> {
  try {
    const { data: call, error } = await admin
      .from("calls")
      .select("status, booking_outcome, is_voicemail, duration_seconds, transcript, caller_name, caller_phone, customer_id")
      .eq("id", args.callId)
      .eq("user_id", args.userId)
      .maybeSingle();
    if (error || !call) return { tagged: false, reason: "call_not_found" };

    const verdict = classifyCallOutcome(call as CallFacts);
    if (!verdict) return { tagged: false, reason: "not_confident" };

    const { data: inserted, error: insertError } = await admin
      .from("call_dispositions")
      .upsert(
        {
          user_id: args.userId,
          call_id: args.callId,
          outcome: verdict.outcome,
          source: "ai",
          ai_outcome: verdict.outcome,
          ai_confidence: verdict.confidence,
          set_by: null,
        },
        { onConflict: "call_id", ignoreDuplicates: true },
      )
      .select("id");
    if (insertError) return { tagged: false, reason: "insert_failed" };
    if (!inserted || inserted.length === 0) return { tagged: false, reason: "already_tagged" };

    let taskCreated = false;
    if (verdict.outcome === "no_answer") {
      const who = (call.caller_name as string | null)?.trim() || (call.caller_phone as string | null)?.trim() || "caller";
      const due = new Date(Date.now() + 2 * 3_600_000).toISOString();
      const { data: task, error: taskError } = await admin
        .from("tasks")
        .insert({
          user_id: args.userId,
          title: `Call back ${who}`.slice(0, 200),
          description: "Created automatically: the call ended without a conversation.",
          priority: "normal",
          due_at: due,
          customer_id: call.customer_id ?? null,
        })
        .select("id")
        .single();
      if (!taskError && task?.id) {
        await admin.from("call_dispositions").update({ follow_up_task_id: task.id }).eq("id", inserted[0].id);
        taskCreated = true;
      }
    }
    return { tagged: true, outcome: verdict.outcome, taskCreated };
  } catch {
    return { tagged: false, reason: "error" };
  }
}
