// supabase/functions/portal-poll/index.ts
// Cron (every 5-15 min): polls submissions that have a verified API adapter. POST {} with header X-Cron-Secret: $PORTAL_POLL_CRON_SECRET.
// Fails closed (missing secret -> 500). Global kill switch is read FIRST. Backoff + jitter + stop conditions come from pollSchedule.ts.
// No vendor adapter is registered by default: the registry ships with the MOCK adapter only, enabled solely when PORTAL_ENABLE_MOCK=1.
// A profile with no adapter is STOPPED (poll_stopped event), not retried forever. [VERIFY] every real adapter before registering it.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { MockPortalAdapter } from "../_shared/portal/mockAdapter.ts";
import type { PortalAdapter } from "../_shared/portal/adapter.ts";
import { nextPollDelayMs, pollStopReason } from "../_shared/portal/pollSchedule.ts";
import { normalizeStatus } from "../_shared/portal/statusNormalizer.ts";
import { isPortalState, isTerminal, type PortalState } from "../_shared/portal/stateMachine.ts";
import { safeError } from "../_shared/portal/redact.ts";

type Row = Record<string, unknown>;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const mock = new MockPortalAdapter();

function adapterFor(portalType: string): PortalAdapter | null {
  if (Deno.env.get("PORTAL_ENABLE_MOCK") === "1" && portalType === "other") return mock;
  return null; // no real vendor adapter is verified
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("PORTAL_POLL_CRON_SECRET");
  if (!secret) return json({ error: "PORTAL_POLL_CRON_SECRET is not configured" }, 500);
  if (req.headers.get("X-Cron-Secret") !== secret) return json({ error: "unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const stats = { claimed: 0, updated: 0, unchanged: 0, stopped: 0, errors: 0, halted: false };

  const { data: g } = await admin.from("portal_global_settings").select("global_kill").eq("id", true).maybeSingle();
  if ((g as Row | null)?.global_kill) return json({ ok: true, ...stats, halted: true });

  const { data: claimed, error } = await admin.rpc("portal_claim_due_polls", { p_limit: 50 });
  if (error) return json({ error: "claim_failed" }, 500);
  for (const s of (claimed as Row[]) ?? []) {
    stats.claimed++;
    try {
      const { data: p } = await admin.from("customer_portal_profiles").select("portal_type").eq("id", s.profile_id as string).maybeSingle();
      const adapter = adapterFor(String((p as Row | null)?.portal_type ?? ""));
      const stop = pollStopReason({ attempts: Number(s.poll_attempts), consecutiveErrors: Number(s.consecutive_poll_errors), createdAtMs: Date.parse(String(s.created_at)), terminal: isTerminal(s.state as PortalState) }, Date.now());
      if (!adapter || stop || !s.external_ref) {
        await admin.rpc("portal_record_poll", { p_id: s.id, p_ok: true, p_delay_seconds: 0, p_stop: true, p_error: !adapter ? "no_adapter" : stop ?? "no_reference" });
        stats.stopped++; continue;
      }
      const res = await adapter.getStatus(String(s.external_ref));
      if (!res.ok) {
        const delay = Math.round(nextPollDelayMs(Number(s.consecutive_poll_errors) + 1) / 1000);
        await admin.rpc("portal_record_poll", { p_id: s.id, p_ok: false, p_delay_seconds: delay, p_error: res.error ?? "poll_failed" }); stats.errors++; continue;
      }
      const { data: ver } = await admin.from("portal_profile_versions").select("config").eq("profile_id", s.profile_id as string).eq("version", s.profile_version as number).maybeSingle();
      const map = (((ver as Row | null)?.config as Row | undefined)?.status_map ?? {}) as Record<string, string>;
      const n = res.rawStatus ? normalizeStatus(res.rawStatus, map) : null;
      if (n?.kind === "state" && isPortalState(n.state) && n.state !== s.state) {
        const { error: te } = await admin.rpc("portal_apply_transition", { p_submission_id: s.id, p_to: n.state, p_actor_kind: "portal", p_details: { raw_status: n.raw, reason: res.rejectionReason }, p_dedupe_key: `poll:${s.id}:${n.state}` });
        if (te) throw new Error(te.code ?? "transition_failed"); stats.updated++;
      } else stats.unchanged++;
      await admin.rpc("portal_record_poll", { p_id: s.id, p_ok: true, p_delay_seconds: Math.round(nextPollDelayMs(0) / 1000) });
    } catch (e) {
      stats.errors++;
      await admin.rpc("portal_record_poll", { p_id: s.id, p_ok: false, p_delay_seconds: Math.round(nextPollDelayMs(Number(s.consecutive_poll_errors) + 1) / 1000), p_error: safeError(e) });
    }
  }
  return json({ ok: true, ...stats });
});
