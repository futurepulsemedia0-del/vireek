// supabase/functions/fraud-admin/index.ts
//
// Staff API for the abuse dashboard (POST { action, ... }). Staff = is_vireek_staff(caller) verified
// server-side on EVERY call. Account owners may only call "appeal" (scoped to their own account).
// Actions: overview | cases | case_update | set_status | unlock | kill_switch | approvals | approval_decide | weekly_report | appeal

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { applyOrgStatus, type OrgStatus } from "../_shared/fraud/enforcement.ts";
import { routeFraudAlert } from "../_shared/fraud/alerts.ts";
import { buildWeeklyReport } from "../_shared/fraud/report.ts";
import { listKnownCountries } from "../_shared/fraud/countries.ts";
import { PLAN_LIMITS, maxLossPerSignupCents, type PlanId } from "../_shared/fraud/planLimits.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KILL_KEYS = ["kill_outbound_calls", "kill_sms", "kill_international", "kill_otp_sms", "enforce"] as const;
const UNLOCK_KEYS = ["outbound_unlocked", "international_unlocked", "voice_clone_unlocked"] as const;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not authenticated" }, 401);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (!body || !action) return json({ error: "action is required" }, 400);

  // ---- owner-scoped action ----
  if (action === "appeal") {
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
    if (text.length < 10) return json({ error: "Please describe your situation (at least 10 characters)." }, 400);
    const { data: owner } = await userClient.rpc("get_account_owner_id");
    if (!owner) return json({ error: "No account" }, 403);
    const { data, error } = await admin.from("fraud_cases").update({ appeal_text: text, appeal_at: new Date().toISOString(), status: "investigating", updated_at: new Date().toISOString() }).eq("user_id", owner).neq("status", "resolved").select("id");
    if (error) return json({ error: "Could not save appeal" }, 500);
    if (!data?.length) return json({ error: "No open restriction to appeal" }, 404);
    await routeFraudAlert(admin, "warn", `Appeal received for ${owner}`, text.slice(0, 300));
    return json({ ok: true });
  }

  // ---- staff gate ----
  const { data: isStaff } = await admin.rpc("is_vireek_staff", { uid: user.id });
  if (isStaff !== true) return json({ error: "Forbidden" }, 403);

  const audit = (userId: string, act: string, meta: Record<string, unknown>) =>
    admin.from("audit_log").insert({ user_id: userId, actor_id: user.id, actor_email: user.email ?? null, action: act, target_table: "fraud", target_id: userId, metadata: meta });

  try {
    switch (action) {
      case "overview": {
        const since = new Date(Date.now() - 86_400_000).toISOString();
        const [settings, cases, orgs, denied, approvals] = await Promise.all([
          admin.from("fraud_settings").select("*").eq("id", true).maybeSingle(),
          admin.from("fraud_cases").select("id", { count: "exact", head: true }).neq("status", "resolved"),
          admin.from("fraud_org_state").select("status").neq("status", "active").limit(5000),
          admin.from("fraud_events").select("code, country").eq("kind", "denied").gte("created_at", since).limit(20000),
          admin.from("fraud_campaign_approvals").select("user_id", { count: "exact", head: true }).eq("status", "pending"),
        ]);
        const byCode: Record<string, number> = {};
        for (const d of denied.data ?? []) byCode[d.code] = (byCode[d.code] ?? 0) + 1;
        return json({
          settings: settings.data, openCases: cases.count ?? 0, pendingApprovals: approvals.count ?? 0,
          suspended: (orgs.data ?? []).filter((o) => o.status === "suspended").length,
          throttled: (orgs.data ?? []).filter((o) => o.status === "throttled").length,
          denied24h: byCode, knownCountries: listKnownCountries(),
          lossBounds: (Object.keys(PLAN_LIMITS) as PlanId[]).map((plan) => ({
            plan,
            unverifiedCents: maxLossPerSignupCents(plan, { verified: false }).totalCents,
            verifiedCents: maxLossPerSignupCents(plan, { verified: true }).totalCents,
          })),
        });
      }
      case "cases": {
        const status = typeof body.status === "string" && ["open", "investigating", "resolved"].includes(body.status) ? body.status : null;
        let q = admin.from("fraud_cases").select("id, user_id, status, severity, title, signals, appeal_text, appeal_at, resolution, created_at, updated_at").order("created_at", { ascending: false }).limit(100);
        q = status ? q.eq("status", status) : q.neq("status", "resolved");
        const { data, error } = await q;
        if (error) throw error;
        return json({ cases: data });
      }
      case "case_update": {
        const id = String(body.id ?? "");
        const status = String(body.status ?? "");
        if (!UUID.test(id) || !["open", "investigating", "resolved"].includes(status)) return json({ error: "Bad request" }, 400);
        const resolution = typeof body.resolution === "string" ? body.resolution.slice(0, 500) : null;
        const { data, error } = await admin.from("fraud_cases").update({ status, resolution, assigned_to: user.id, updated_at: new Date().toISOString() }).eq("id", id).select("user_id").maybeSingle();
        if (error || !data) return json({ error: "Case not found" }, 404);
        await audit(data.user_id, "fraud.case.update", { case_id: id, status });
        return json({ ok: true });
      }
      case "set_status": {
        const userId = String(body.user_id ?? "");
        const status = String(body.status ?? "") as OrgStatus;
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        if (!UUID.test(userId) || !["active", "throttled", "suspended"].includes(status) || reason.length < 3) return json({ error: "Bad request" }, 400);
        const days = Number(body.days);
        const until = status === "throttled" && days > 0 && days <= 30 ? new Date(Date.now() + days * 86_400_000) : null;
        const r = await applyOrgStatus(admin, { userId, status, reason, until, actorId: user.id, source: "fraud-admin" });
        return r.ok ? json({ ok: true }) : json({ error: "Could not change status" }, 500);
      }
      case "unlock": {
        const userId = String(body.user_id ?? "");
        if (!UUID.test(userId)) return json({ error: "Bad request" }, 400);
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        for (const k of UNLOCK_KEYS) if (typeof body[k] === "boolean") patch[k] = body[k];
        if (Array.isArray(body.allowed_countries)) {
          const known = new Set(listKnownCountries());
          patch.allowed_countries = body.allowed_countries.filter((c): c is string => typeof c === "string" && known.has(c)).slice(0, 50);
        }
        const { error } = await admin.from("fraud_org_state").upsert({ user_id: userId, ...patch }, { onConflict: "user_id" });
        if (error) throw error;
        await audit(userId, "fraud.unlock", patch);
        return json({ ok: true });
      }
      case "kill_switch": {
        const patch: Record<string, unknown> = { updated_by: user.id, updated_at: new Date().toISOString() };
        for (const k of KILL_KEYS) if (typeof body[k] === "boolean") patch[k] = body[k];
        if (Array.isArray(body.otp_allowed_countries)) {
          const known = new Set(listKnownCountries());
          patch.otp_allowed_countries = body.otp_allowed_countries.filter((c): c is string => typeof c === "string" && known.has(c)).slice(0, 50);
        }
        if (typeof body.consent_mode === "string" && ["off", "log", "enforce"].includes(body.consent_mode)) patch.consent_mode = body.consent_mode;
        if (typeof body.free_minutes_mode === "string" && ["monthly", "lifetime"].includes(body.free_minutes_mode)) patch.free_minutes_mode = body.free_minutes_mode;
        if (typeof body.enforcement_mode === "string" && ["shadow", "enforce"].includes(body.enforcement_mode)) patch.enforcement_mode = body.enforcement_mode;
        if (typeof body.campaign_approval_days === "number" && Number.isInteger(body.campaign_approval_days) && body.campaign_approval_days >= 0 && body.campaign_approval_days <= 90) patch.campaign_approval_days = body.campaign_approval_days;
        if (typeof body.reason === "string") patch.reason = body.reason.slice(0, 300);
        const { error } = await admin.from("fraud_settings").update(patch).eq("id", true);
        if (error) throw error;
        await admin.from("fraud_events").insert({ user_id: null, kind: "kill_switch", code: "UPDATED", source: "fraud-admin", detail: { ...patch, updated_by: user.id } });
        await audit(user.id, "fraud.kill_switch", patch);
        await routeFraudAlert(admin, "page", "Kill switch changed", JSON.stringify(patch));
        return json({ ok: true });
      }
      case "approvals": {
        const { data, error } = await admin.from("fraud_campaign_approvals").select("user_id, campaign, status, created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(100);
        if (error) throw error;
        return json({ approvals: data });
      }
      case "approval_decide": {
        const userId = String(body.user_id ?? "");
        const campaign = typeof body.campaign === "string" ? body.campaign.slice(0, 80) : "";
        const decision = String(body.decision ?? "");
        if (!UUID.test(userId) || !campaign || !["approved", "rejected"].includes(decision)) return json({ error: "Bad request" }, 400);
        const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
        const { data, error } = await admin.from("fraud_campaign_approvals").update({ status: decision, decided_by: user.id, decided_at: new Date().toISOString(), note }).eq("user_id", userId).eq("campaign", campaign).select("user_id");
        if (error) throw error;
        if (!data?.length) return json({ error: "Approval not found" }, 404);
        await audit(userId, `fraud.campaign.${decision}`, { campaign, note });
        return json({ ok: true });
      }
      case "weekly_report": {
        const to = new Date(); const from = new Date(to.getTime() - 7 * 86_400_000);
        const ev = async (kind: string) => (await admin.from("fraud_events").select("code, country").eq("kind", kind).gte("created_at", from.toISOString()).limit(50000)).data ?? [];
        const [denied, anomalies, otp, signup, changes] = await Promise.all([ev("denied"), ev("anomaly"), ev("otp_blocked"), ev("signup_blocked"), ev("status_change")]);
        const [cases, susp] = await Promise.all([
          admin.from("fraud_cases").select("id", { count: "exact", head: true }).neq("status", "resolved"),
          admin.from("fraud_org_state").select("user_id", { count: "exact", head: true }).eq("status", "suspended"),
        ]);
        return json({ report: buildWeeklyReport({ from: from.toISOString(), to: to.toISOString(), denied, anomalies, otpBlocked: otp.length, signupBlocked: signup.length, statusChanges: changes, openCases: cases.count ?? 0, suspendedOrgs: susp.count ?? 0, reservedCents: 0 }) });
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "fraud_admin_error", action, error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Internal error" }, 500);
  }
});
