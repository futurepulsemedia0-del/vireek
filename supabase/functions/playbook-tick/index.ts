// supabase/functions/playbook-tick/index.ts
//
// Scheduler + signal checker for the Playbook Library. Idempotent and safe to run concurrently:
// every state change goes through a SECURITY DEFINER RPC that re-checks status and time under a row lock.
//
//   1. Transitions: scheduled -> active when due, scheduled -> expired if the window was missed,
//      active -> expired (rolled back) at ends_at, stale suggestions -> dismissed.
//   2. Suggestions: for each account, combine REAL signals (weather alerts already recorded by
//      weather-surge-check, 24h call spike, season) and create a "suggested" activation.
//      It only STARTS by itself when the owner pre-approved that playbook key in playbook_settings.
//
// Deploy + schedule (every 10-15 minutes):
//   supabase functions deploy playbook-tick --no-verify-jwt
//   supabase secrets set PLAYBOOK_TICK_CRON_SECRET=<random-string>
//   POST https://<project>.functions.supabase.co/playbook-tick   header X-Cron-Secret: <same string>
// Optional body: { "after": "<user_id>", "limit": 200 } to page through accounts.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { PLAYBOOKS, findPlaybook } from "../_shared/playbooks/catalog.ts";
import { decideTransition, defaultEnabledIds, mayAutoApply, suggestPlaybooks } from "../_shared/playbooks/engine.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const log = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...extra }));

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("PLAYBOOK_TICK_CRON_SECRET");
  const provided = req.headers.get("X-Cron-Secret") ?? "";
  if (!secret || !safeEqual(provided, secret)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  let body: { after?: string; limit?: number } = {};
  try { body = await req.json(); } catch { /* no body is fine */ }
  const now = new Date();
  const counts = { applied: 0, expired: 0, missed: 0, stale: 0, suggested: 0, autoApplied: 0, errors: 0 };

  try {
    // ---- 1. transitions -------------------------------------------------
    const { data: rows, error } = await admin
      .from("playbook_activations")
      .select("id, status, starts_at, ends_at, suggest_expires_at")
      .or(`and(status.eq.scheduled,starts_at.lte.${now.toISOString()}),and(status.eq.active,ends_at.lte.${now.toISOString()}),and(status.eq.suggested,suggest_expires_at.lte.${now.toISOString()})`)
      .limit(500);
    if (error) throw error;

    for (const r of rows ?? []) {
      const t = decideTransition({
        id: r.id as string, status: r.status as never, startsAt: new Date(r.starts_at as string), endsAt: new Date(r.ends_at as string),
        suggestExpiresAt: r.suggest_expires_at ? new Date(r.suggest_expires_at as string) : null,
      }, now);
      try {
        if (t === "apply") {
          const { data } = await admin.rpc("playbook_system_apply", { p_activation_id: r.id, p_allow_suggested: false });
          if ((data as { status?: string })?.status === "active") counts.applied++;
          log("playbook_apply", { id: r.id, result: (data as { status?: string })?.status });
        } else if (t === "expire") {
          await admin.rpc("playbook_system_rollback", { p_activation_id: r.id, p_reason: "expired" });
          counts.missed++;
        } else if (t === "rollback_expired") {
          const { data } = await admin.rpc("playbook_system_rollback", { p_activation_id: r.id, p_reason: "expired" });
          counts.expired++;
          log("playbook_expired", { id: r.id, result: (data as { status?: string })?.status });
        } else if (t === "stale") {
          await admin.rpc("playbook_system_rollback", { p_activation_id: r.id, p_reason: "stale" });
          counts.stale++;
        }
      } catch (e) {
        counts.errors++;
        log("playbook_transition_failed", { id: r.id, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ---- 2. suggestions from real signals ------------------------------
    const limit = Math.min(500, Math.max(1, Number(body.limit) || 200));
    let q = admin.from("business_profile").select("user_id, primary_industry").not("primary_industry", "is", null).order("user_id", { ascending: true }).limit(limit);
    if (body.after) q = q.gt("user_id", body.after);
    const { data: accounts, error: accErr } = await q;
    if (accErr) throw accErr;

    for (const acc of accounts ?? []) {
      const userId = acc.user_id as string;
      try {
        const { data: snap } = await admin.rpc("playbook_signal_snapshot", { p_user_id: userId });
        const s = snap as {
          weather: { eventType: string; headline?: string; expiresAt: string | null }[]; calls24h: number; callsTrailing: number;
          liveKeys: string[]; dismissedKeys: string[]; autoApplyKeys: string[]; suggestionsEnabled: boolean;
        } | null;
        if (!s || !s.suggestionsEnabled) continue;
        const suggestions = suggestPlaybooks({
          trade: acc.primary_industry as string | null, now,
          weather: s.weather.map((w) => ({ eventType: w.eventType, headline: w.headline, expiresAt: w.expiresAt ? new Date(w.expiresAt) : null })),
          calls: { last24h: Number(s.calls24h) || 0, trailingDailyAvg: (Number(s.callsTrailing) || 0) / 7 },
          liveKeys: s.liveKeys, dismissedKeys: s.dismissedKeys,
        }, PLAYBOOKS);
        for (const sg of suggestions) {
          const pb = findPlaybook(sg.key);
          if (!pb) continue;
          const { data: id } = await admin.rpc("playbook_system_suggest", {
            p_user_id: userId, p_key: pb.key, p_version: pb.version, p_definition: pb, p_enabled_items: defaultEnabledIds(pb),
            p_signal: { trigger: sg.trigger, reason: sg.reason, ...sg.signal }, p_suggest_ttl_hours: 48,
          });
          if (!id) continue;
          counts.suggested++;
          if (mayAutoApply(pb.key, s.autoApplyKeys, sg.trigger)) {
            const { data: res } = await admin.rpc("playbook_system_apply", { p_activation_id: id, p_allow_suggested: true });
            if ((res as { status?: string })?.status === "active") counts.autoApplied++;
            log("playbook_auto_applied", { user_id: userId, key: pb.key, result: (res as { status?: string })?.status });
          }
        }
      } catch (e) {
        counts.errors++;
        log("playbook_signal_failed", { user_id: userId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const nextAfter = (accounts ?? []).length === limit ? (accounts![accounts!.length - 1].user_id as string) : null;
    return json({ ok: true, ...counts, next_after: nextAfter });
  } catch (e) {
    log("playbook_tick_failed", { error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Tick failed", ...counts }, 500);
  }
});
