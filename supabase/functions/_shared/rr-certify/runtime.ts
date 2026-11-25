// supabase/functions/_shared/rr-certify/runtime.ts
//
// Thin I/O wrapper around src/lib/rrCertify (pure). Used by the remote-resolution edge function.
// Contract: for mode 'off' it does NOTHING (no reads beyond the flag + settings, no writes).
// Failure policy: shadow/off -> errors are swallowed and the existing decision stands;
//                 enforce     -> errors FAIL CLOSED (a remote attempt becomes a dispatch).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { effectiveAction, gateDecision, segmentKey, type CalibrationSnapshot, type ExistingAction, type GateResult } from "../../../../src/lib/rrCertify/index.ts";

export interface GateRun {
  mode: "off" | "shadow" | "enforce";
  action: ExistingAction;
  gate: GateResult | null;
}

export async function runRrCertify(
  admin: SupabaseClient,
  a: {
    userId: string; caseId: string; turn: number; category: string; score: number; threshold: number;
    existing: ExistingAction; safetyHold: boolean; safetyReasons: string[];
  },
): Promise<GateRun> {
  const unchanged: GateRun = { mode: "off", action: a.existing, gate: null };
  let mode: GateRun["mode"] = "off";
  try {
    const { data: on } = await admin.rpc("flag_evaluate", { p_key: "rre_certify", p_tenant: a.userId });
    if (on !== true) return unchanged;
    const { data: s } = await admin.from("rr_certify_settings").select("mode").eq("user_id", a.userId).maybeSingle();
    mode = (s?.mode === "shadow" || s?.mode === "enforce") ? s.mode : "off";
    if (mode === "off") return unchanged;

    const { data: snapRow } = await admin.from("rr_certify_snapshots").select("id, snapshot")
      .eq("user_id", a.userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const snapshot = snapRow ? ({ ...(snapRow.snapshot as CalibrationSnapshot), id: snapRow.id as string }) : null;
    const { data: drift } = await admin.from("rr_certify_drift").select("status").eq("user_id", a.userId).maybeSingle();

    const gate = gateDecision({
      existingAllowsRemote: a.existing === "troubleshoot",
      safetyHold: a.safetyHold, safetyReasons: a.safetyReasons,
      score: a.score, segment: segmentKey(a.category), snapshot, driftAlarm: drift?.status === "alarm",
    });
    await admin.rpc("rr_certify_log_decision", {
      p_case_id: a.caseId, p_turn: a.turn, p_score: Math.round(a.score), p_category: a.category, p_existing: a.existing,
      p_would: gate.action, p_reason: gate.reason, p_lambda: gate.lambda, p_segment_status: gate.segmentStatus,
      p_snapshot_id: snapshot?.id ?? null, p_threshold: a.threshold, p_mode: mode,
    });
    return { mode, action: effectiveAction(mode, a.existing, gate), gate };
  } catch (err) {
    console.error(JSON.stringify({ event: "rr_certify_error", error: err instanceof Error ? err.message : String(err), mode }));
    if (mode === "enforce" && a.existing === "troubleshoot") return { mode, action: "dispatch", gate: null };
    return { mode, action: a.existing, gate: null };
  }
}
