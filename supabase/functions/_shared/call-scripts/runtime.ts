// supabase/functions/_shared/call-scripts/runtime.ts
//
// Live-call side of Call Scripts. Used ONLY by vapi-webhook's
// assistant-request handler. Contract: this must NEVER break or noticeably
// slow a call — every failure path returns "" (no scripts injected, the
// assistant falls back to its base prompt), and the whole thing is raced
// against a hard timeout.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  buildCallScriptsContext,
  isScenarioKey,
  pickArm,
  type ActiveScriptEntry,
  type Arm,
} from "./logic.ts";

const TIMEOUT_MS = 1200;

interface ScriptRow {
  id: string;
  scenario: string;
  active_version_id: string | null;
  challenger_version_id: string | null;
  challenger_traffic_pct: number;
}
interface VersionRow {
  id: string;
  opening_line: string;
  body: string;
}

async function resolve(
  admin: SupabaseClient,
  userId: string,
  callId: string | null,
  afterHours: boolean,
  isAbandoned: () => boolean,
): Promise<string> {
  const { data: scripts, error } = await admin
    .from("call_scripts")
    .select("id, scenario, active_version_id, challenger_version_id, challenger_traffic_pct")
    .eq("user_id", userId)
    .not("active_version_id", "is", null);
  if (error || !scripts?.length) return "";

  const rows = scripts as ScriptRow[];
  const versionIds = Array.from(
    new Set(rows.flatMap((s) => [s.active_version_id, s.challenger_version_id]).filter((v): v is string => !!v)),
  );
  const { data: versions, error: vErr } = await admin
    .from("call_script_versions")
    .select("id, opening_line, body")
    .in("id", versionIds);
  if (vErr || !versions?.length) return "";
  const byId = new Map((versions as VersionRow[]).map((v) => [v.id, v]));

  const entries: ActiveScriptEntry[] = [];
  const assignments: {
    user_id: string;
    script_id: string;
    version_id: string;
    call_external_id: string;
    arm: Arm;
    after_hours: boolean;
  }[] = [];

  for (const s of rows) {
    if (!isScenarioKey(s.scenario) || !s.active_version_id) continue;
    // Without a call id we cannot attribute the outcome, so never run the
    // challenger blind: serve control only.
    const wantsChallenger =
      !!callId &&
      !!s.challenger_version_id &&
      pickArm(callId, s.id, s.challenger_traffic_pct) === "challenger";
    const challenger = wantsChallenger ? byId.get(s.challenger_version_id as string) : undefined;
    const version = challenger ?? byId.get(s.active_version_id);
    if (!version) continue;
    const arm: Arm = challenger ? "challenger" : "control";
    entries.push({ scenario: s.scenario, opening_line: version.opening_line, body: version.body });
    if (callId) {
      assignments.push({
        user_id: userId,
        script_id: s.id,
        version_id: challenger ? (s.challenger_version_id as string) : s.active_version_id,
        call_external_id: callId,
        arm,
        after_hours: afterHours,
      });
    }
  }

  // If the timeout already fired, the call proceeds WITHOUT scripts, so we
  // must not record an exposure for it.
  if (assignments.length && !isAbandoned()) {
    // ignoreDuplicates: a Vapi retry must keep the FIRST assignment.
    await admin
      .from("call_script_assignments")
      .upsert(assignments, { onConflict: "script_id,call_external_id", ignoreDuplicates: true });
  }

  return buildCallScriptsContext(entries);
}

export async function buildCallScriptsContextVariable(
  admin: SupabaseClient,
  userId: string,
  callId: string | null | undefined,
  afterHours: boolean,
): Promise<string> {
  try {
    let abandoned = false;
    const timeout = new Promise<string>((resolveTimeout) =>
      setTimeout(() => {
        abandoned = true;
        resolveTimeout("");
      }, TIMEOUT_MS),
    );
    return await Promise.race([
      resolve(admin, userId, callId ?? null, afterHours, () => abandoned),
      timeout,
    ]);
  } catch {
    return "";
  }
}
