// supabase/functions/ai-disclosure-drift-scan/index.ts
//
// Detects drift between business_profile.ai_disclosure_script and the LIVE
// Vapi assistant's first message, records it, and alerts the owner.
//
// Two callers, same function:
//   - Scheduled (service-role key as Bearer): scans every account with a linked assistant.
//   - Dashboard "Check now" (user JWT): scans ONLY the caller's own account, and only
//     if they may manage the business profile (ai_disclosure_can_view()).
//
// Required secrets: VAPI_PRIVATE_KEY (already used by outbound-dialer),
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY.
//
// Schedule hourly with pg_cron/pg_net (see the note in the migration) or any
// external scheduler: POST with `Authorization: Bearer <service role key>`.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { compareDisclosureToFirstMessage } from "../_shared/ai-disclosure/drift.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const VAPI_ASSISTANT_URL = "https://api.vapi.ai/assistant";
const MAX_ACCOUNTS_PER_RUN = 200;
const CONCURRENCY = 5;
const REPEAT_ROW_AFTER_MS = 24 * 60 * 60 * 1000;

type Status = "in_sync" | "drift" | "no_first_message" | "unreachable" | "not_configured";

interface Target {
  user_id: string;
  vapi_assistant_id: string | null;
  ai_disclosure_script: string | null;
}

interface CheckResult {
  user_id: string;
  status: Status;
  reason: string;
  similarity: number | null;
  live_first_message: string | null;
}

async function fetchLiveFirstMessage(
  assistantId: string,
  key: string,
): Promise<{ ok: true; firstMessage: string | null; mode: string | null } | { ok: false; reason: string }> {
  try {
    const res = await fetch(`${VAPI_ASSISTANT_URL}/${encodeURIComponent(assistantId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return { ok: false, reason: "assistant_not_found" };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "vapi_auth_failed" };
    if (!res.ok) return { ok: false, reason: `vapi_http_${res.status}` };
    const body = (await res.json()) as { firstMessage?: unknown; firstMessageMode?: unknown };
    return {
      ok: true,
      firstMessage: typeof body.firstMessage === "string" ? body.firstMessage : null,
      mode: typeof body.firstMessageMode === "string" ? body.firstMessageMode : null,
    };
  } catch {
    return { ok: false, reason: "vapi_unreachable" };
  }
}

async function checkOne(target: Target, vapiKey: string | undefined): Promise<CheckResult> {
  const base = { user_id: target.user_id, similarity: null as number | null, live_first_message: null as string | null };
  if (!target.vapi_assistant_id) return { ...base, status: "not_configured", reason: "no_vapi_assistant_linked" };
  if (!vapiKey) return { ...base, status: "unreachable", reason: "vapi_key_missing" };

  const live = await fetchLiveFirstMessage(target.vapi_assistant_id, vapiKey);
  if (!live.ok) return { ...base, status: "unreachable", reason: live.reason };
  if (live.mode && live.mode !== "assistant-speaks-first") {
    return { ...base, status: "no_first_message", reason: `first_message_mode_${live.mode}` };
  }
  const cmp = compareDisclosureToFirstMessage(target.ai_disclosure_script ?? "", live.firstMessage);
  return {
    ...base,
    status: cmp.status,
    reason: cmp.reason,
    similarity: cmp.similarity,
    live_first_message: live.firstMessage ? live.firstMessage.slice(0, 2000) : null,
  };
}

async function persist(admin: SupabaseClient, target: Target, r: CheckResult, source: "scheduled" | "manual") {
  // Store a row only when something changed, or once a day, so hourly scans don't flood the table.
  const { data: last } = await admin
    .from("ai_disclosure_drift_checks")
    .select("status, reason, checked_at")
    .eq("user_id", r.user_id)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const changed = !last || last.status !== r.status || last.reason !== r.reason;
  const stale = last ? Date.now() - Date.parse(last.checked_at as string) > REPEAT_ROW_AFTER_MS : true;
  if (changed || stale || source === "manual") {
    await admin.from("ai_disclosure_drift_checks").insert({
      user_id: r.user_id,
      trigger_source: source,
      vapi_assistant_id: target.vapi_assistant_id,
      status: r.status,
      reason: r.reason,
      expected_text: target.ai_disclosure_script,
      live_first_message: r.live_first_message,
      similarity: r.similarity,
    });
  }
  if (r.status === "drift" || r.status === "no_first_message") {
    await admin.rpc("ai_disclosure_raise_alert", {
      p_user_id: r.user_id,
      p_type: "ai_disclosure_drift",
      p_title: "Your assistant's greeting no longer matches your AI disclosure",
      p_message:
        "The first message on your live Vapi assistant does not start with your AI disclosure. Calls may go out without it. Open the Disclosure Ledger to see the exact wording to paste.",
      p_action_url: "/dashboard/ai-disclosure-ledger",
      p_dedupe_minutes: 24 * 60,
    });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY") || undefined;
    if (!supabaseUrl || !serviceKey) return json({ error: "Server not configured." }, 500);

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    let query = admin
      .from("business_profile")
      .select("user_id, vapi_assistant_id, ai_disclosure_script")
      .limit(MAX_ACCOUNTS_PER_RUN);
    let source: "scheduled" | "manual" = "scheduled";

    if (bearer && bearer === serviceKey) {
      query = query.not("vapi_assistant_id", "is", null);
    } else {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
        auth: { persistSession: false },
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return json({ error: "Not authenticated." }, 401);
      const [{ data: ownerId }, { data: allowed }] = await Promise.all([
        userClient.rpc("get_account_owner_id"),
        userClient.rpc("ai_disclosure_can_view"),
      ]);
      if (!ownerId || allowed !== true) return json({ error: "Not allowed." }, 403);
      query = query.eq("user_id", ownerId as string);
      source = "manual";
    }

    const { data: targets, error } = await query;
    if (error) throw error;

    const results: CheckResult[] = [];
    const list = (targets ?? []) as Target[];
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const chunk = list.slice(i, i + CONCURRENCY);
      const done = await Promise.all(
        chunk.map(async (t) => {
          const r = await checkOne(t, vapiKey);
          try { await persist(admin, t, r, source); } catch (e) {
            console.error(JSON.stringify({ event: "ai_disclosure_drift_persist_failed", error: String(e) }));
          }
          return r;
        }),
      );
      results.push(...done);
    }

    const summary = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    return json({ checked: results.length, summary, result: source === "manual" ? results[0] ?? null : undefined });
  } catch (err) {
    console.error(JSON.stringify({ event: "ai_disclosure_drift_scan_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Internal server error." }, 500);
  }
});
