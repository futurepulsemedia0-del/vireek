// supabase/functions/sanctions-admin/index.ts
//
// Staff API for the sanctions review queue (POST { action, ... }). Staff = is_vireek_staff(caller), verified server-side on EVERY
// call; there is no owner-facing action (owners must never be able to probe screening state).
// Actions: overview | cases | case_events | decide | settings_update
//
// All writes to the sanctions_* tables use the service role through the RPCs / a validated settings patch, and every staff
// action is written to audit_log. Subject PII (name / country / DOB) is returned to staff only.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadProviderFromEnv } from "../_shared/sanctions/providers.ts";
import { resolveConfig } from "../_shared/sanctions/config.ts";
import { UUID_RE, parseCaseFilter, parseDecideRequest, parseSettingsPatch } from "../_shared/sanctions/admin.ts";
import { createSupabaseStore, type SupabaseLike } from "../_shared/sanctions/store.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not authenticated" }, 401);

  const { data: isStaff } = await admin.rpc("is_vireek_staff", { uid: user.id });
  if (isStaff !== true) return json({ error: "Forbidden" }, 403);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (!body || !action) return json({ error: "action is required" }, 400);

  const audit = (subjectUserId: string | null, act: string, meta: Record<string, unknown>) =>
    admin.from("audit_log").insert({ user_id: subjectUserId ?? user.id, actor_id: user.id, actor_email: user.email ?? null, action: act, target_table: "sanctions", target_id: subjectUserId ?? user.id, metadata: meta });

  try {
    switch (action) {
      case "overview": {
        const since = new Date(Date.now() - 86_400_000).toISOString();
        const [settings, open, escalated, held, blocked, recent] = await Promise.all([
          admin.from("sanctions_settings").select("mode, review_threshold, provider_timeout_ms, restricted_countries, reason, updated_at").eq("id", true).maybeSingle(),
          admin.from("sanctions_review_cases").select("id", { count: "exact", head: true }).eq("status", "open"),
          admin.from("sanctions_review_cases").select("id", { count: "exact", head: true }).eq("status", "escalated"),
          admin.from("sanctions_account_state").select("account_owner_id", { count: "exact", head: true }).eq("status", "held"),
          admin.from("sanctions_account_state").select("account_owner_id", { count: "exact", head: true }).eq("status", "blocked"),
          admin.from("sanctions_screenings").select("decision, mode").gte("created_at", since).limit(20000),
        ]);
        const by: Record<string, number> = { clear: 0, review: 0, error: 0 };
        let shadowWouldDeny = 0;
        for (const r of recent.data ?? []) {
          by[r.decision] = (by[r.decision] ?? 0) + 1;
          if (r.mode === "shadow" && r.decision !== "clear") shadowWouldDeny++;
        }
        const cfg = resolveConfig(settings.data ?? null, { get: (k) => Deno.env.get(k) });
        const loaded = loadProviderFromEnv({ get: (k) => Deno.env.get(k) }, cfg.providerTimeoutMs);
        return json({
          settings: settings.data,
          effectiveMode: cfg.mode,
          failedClosed: cfg.failedClosed,
          forcedEnforce: cfg.forcedEnforce,
          providerConfigured: "provider" in loaded,
          providerProblem: "error" in loaded ? loaded.error.code : null,
          hashSecretConfigured: Boolean(Deno.env.get("FRAUD_HASH_PEPPER")),
          openCases: open.count ?? 0,
          escalatedCases: escalated.count ?? 0,
          heldAccounts: held.count ?? 0,
          blockedAccounts: blocked.count ?? 0,
          screenings24h: by,
          shadowWouldDeny24h: shadowWouldDeny,
        });
      }
      case "cases": {
        const filter = parseCaseFilter(body);
        let q = admin.from("sanctions_review_cases")
          .select("id, account_owner_id, checkpoint, status, top_score, matches, subject, resolution, decided_by, decided_at, created_at, updated_at")
          .order("created_at", { ascending: false }).limit(100);
        q = filter === "active" ? q.in("status", ["open", "escalated"]) : q.eq("status", filter);
        const { data, error } = await q;
        if (error) throw error;
        return json({ cases: data });
      }
      case "case_events": {
        const id = String(body.case_id ?? "");
        if (!UUID_RE.test(id)) return json({ error: "Bad request" }, 400);
        const { data, error } = await admin.from("sanctions_case_events").select("id, actor_id, action, note, created_at").eq("case_id", id).order("created_at", { ascending: true }).limit(200);
        if (error) throw error;
        return json({ events: data });
      }
      case "decide": {
        const p = parseDecideRequest(body);
        if (!p.ok) return json({ error: p.error }, 400);
        const { data: c } = await admin.from("sanctions_review_cases").select("account_owner_id").eq("id", p.value.caseId).maybeSingle();
        const { data, error } = await admin.rpc("sanctions_decide_case", { p_case: p.value.caseId, p_actor: user.id, p_decision: p.value.decision, p_note: p.value.note });
        if (error) {
          const m = error.message ?? "";
          if (/not found/i.test(m)) return json({ error: "Case not found" }, 404);
          if (/already/i.test(m)) return json({ error: "Case already decided" }, 409);
          return json({ error: "Could not record the decision" }, 500);
        }
        await audit(c?.account_owner_id ?? null, `sanctions.case.${p.value.decision}`, { case_id: p.value.caseId });
        return json({ ok: true, result: data });
      }
      case "settings_update": {
        const p = parseSettingsPatch(body);
        if (!p.ok) return json({ error: p.error }, 400);
        const { error } = await admin.from("sanctions_settings").update({ ...p.value.patch, reason: p.value.reason, updated_by: user.id, updated_at: new Date().toISOString() }).eq("id", true);
        if (error) throw error;
        await audit(null, "sanctions.settings.update", { patch: p.value.patch, reason: p.value.reason });
        // Read back through the same code path the gate uses, so the UI shows the EFFECTIVE configuration.
        const row = await createSupabaseStore(admin as unknown as SupabaseLike).getSettings();
        const cfg = resolveConfig(row, { get: (k) => Deno.env.get(k) });
        return json({ ok: true, settings: row, effectiveMode: cfg.mode });
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "sanctions_admin_error", action, error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Internal error" }, 500);
  }
});
