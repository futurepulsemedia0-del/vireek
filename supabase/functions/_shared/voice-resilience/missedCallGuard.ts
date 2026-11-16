// supabase/functions/_shared/voice-resilience/missedCallGuard.ts
//
// Guarantees that a call served by the degraded path (ladder L2-L4, or a per-call engine failure) leaves a
// `calls` lead row and an owner alert EVEN IF the caller hangs up before leaving a voicemail and Twilio never
// delivers a transcription. Before this module the `calls` row was only created in voice-front-door's
// `vm-transcript` branch (or for emergencies), so a silent hang-up or a failed transcription lost the lead.
//
// Pure over injected ports (no Deno / npm imports) so vitest and the chaos harness can run it. NEVER throws:
// the degraded path must not itself become a new way to hang up on a caller.
//
// Idempotency: the row key is `twilio:<CallSid>` (same namespace voice-front-door already uses). The port MUST
// insert-if-absent (ignore duplicates) so a later, richer `vm-transcript` upsert is never clobbered by this
// placeholder and a Twilio webhook retry never creates a second row.

export type MissedCallReason = "engine_unavailable" | "engine_no_answer" | "level_forced" | "forward_failed";

export interface MissedCallRow {
  user_id: string;
  vapi_call_id: string;
  status: "new_lead";
  source_channel: "voice_fallback";
  caller_phone: string | null;
  summary: string;
  is_voicemail: false;
  is_emergency: false;
}

export interface MissedCallPorts {
  /** Insert-if-absent keyed by vapi_call_id. Must reject (throw) on a real failure. */
  insertCallIfAbsent(row: MissedCallRow): Promise<void>;
  /** Alert the owner by the best available channel. Resolve true if ANY channel accepted it. */
  alertOwner(ownerId: string, title: string, body: string): Promise<boolean>;
}

export interface MissedCallResult {
  recorded: boolean;
  alerted: boolean;
}

const SUMMARY: Record<MissedCallReason, string> = {
  engine_unavailable: "Incoming call while the AI assistant was unavailable. Caller was offered voicemail; no message may have been left.",
  engine_no_answer: "Incoming call: the AI assistant did not answer. Caller was offered voicemail; no message may have been left.",
  level_forced: "Incoming call during a manually reduced service level. Caller was offered voicemail; no message may have been left.",
  forward_failed: "Incoming call: forwarding to the team failed. Caller was offered voicemail; no message may have been left.",
};

export async function ensureMissedCallRecord(
  ports: MissedCallPorts,
  input: { ownerId: string; callSid: string; callerPhone: string | null; reason: MissedCallReason },
): Promise<MissedCallResult> {
  if (!input.callSid || !input.ownerId) return { recorded: false, alerted: false };

  const row: MissedCallRow = {
    user_id: input.ownerId,
    vapi_call_id: `twilio:${input.callSid}`,
    status: "new_lead",
    source_channel: "voice_fallback",
    caller_phone: input.callerPhone,
    summary: SUMMARY[input.reason],
    is_voicemail: false,
    is_emergency: false,
  };

  let recorded = false;
  for (let attempt = 0; attempt < 2 && !recorded; attempt++) {
    try {
      await ports.insertCallIfAbsent(row);
      recorded = true;
    } catch (error) {
      console.error(JSON.stringify({ event: "missed_call_record_failed", attempt: attempt + 1, tenant_id: input.ownerId, call_id: row.vapi_call_id, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  let alerted = false;
  try {
    alerted = await ports.alertOwner(
      input.ownerId,
      "Missed call",
      `A call came in while your AI assistant was degraded${input.callerPhone ? ` (from ${input.callerPhone})` : ""}. Check voicemail and call back.`,
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "missed_call_alert_failed", tenant_id: input.ownerId, call_id: row.vapi_call_id, error: error instanceof Error ? error.message : String(error) }));
  }
  return { recorded, alerted };
}
