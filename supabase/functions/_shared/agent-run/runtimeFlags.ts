// supabase/functions/_shared/agent-run/runtimeFlags.ts
//
// Per-tenant, per-agent rollout flag for the agent run runtime.
// DEFAULT IS OFF: when the flag is missing, the DB errors, or the global kill switch is set,
// callers MUST use their legacy path (behavior unchanged). Fail-closed toward legacy, never toward "new".

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export async function isAgentRuntimeEnabled(
  admin: SupabaseClient,
  userId: string,
  agentSource: string,
): Promise<boolean> {
  const denoEnv = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env;
  if (denoEnv?.get("AGENT_RUNTIME_DISABLED") === "1") return false; // global kill switch
  try {
    const { data, error } = await admin
      .from("agent_runtime_flags")
      .select("enabled")
      .eq("user_id", userId)
      .eq("agent_source", agentSource)
      .maybeSingle();
    if (error) return false;
    return data?.enabled === true;
  } catch {
    return false;
  }
}
