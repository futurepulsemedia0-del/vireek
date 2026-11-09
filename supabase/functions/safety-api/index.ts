// supabase/functions/safety-api/index.ts
//
// User-JWT API for the parts of Site Safety Intelligence that need the exact-address key and the
// tier computation (both live in src/lib/safety/core.ts so there is ONE implementation):
//   action "brief"     -> the pre-job Site Safety Brief for a job the caller is on (or any job for a manager)
//   action "ack_brief" -> the technician confirms they read it
//   action "add_fact"  -> a manager (staff note / equipment / customer self-report) or the assigned
//                         technician (technician_report) records a fact about THIS job's address
//
// Technicians never read the facts table; they only receive what this function returns for their own job.
// Deploy: supabase functions deploy safety-api

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  HAZARD_CATEGORIES,
  computeRiskTier,
  isDaytimeHour,
  lintFactText,
  normalizeSiteKey,
  resolvePrecautions,
  type FactLike,
  type HazardCategory,
  type PolicyRules,
  type RiskTier,
} from "../../../src/lib/safety/core.ts";
import { isValidTimeZone, wallTimeIn } from "../../../src/lib/timezone.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface FactRow extends FactLike {
  id: string;
  fact_text: string;
  quote: string | null;
  review_note: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("Authorization");
  if (!url || !anon || !service) return json({ error: "Server misconfiguration" }, 500);
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const user = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const admin = createClient(url, service, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const [{ data: owner }, { data: me }, { data: canManage }] = await Promise.all([
    user.rpc("get_account_owner_id"),
    user.rpc("get_my_team_member_id"),
    user.rpc("safety_can_manage"),
  ]);
  if (!owner) return json({ error: "Unauthorized" }, 401);
  const isManager = canManage === true;

  const jobId = typeof body.job_id === "string" && UUID.test(body.job_id) ? body.job_id : null;
  if (!jobId) return json({ error: "A valid job_id is required" }, 400);

  // The user-scoped client enforces RLS: a job from another tenant is simply not returned.
  const { data: job } = await user.from("jobs").select("id, user_id, address, customer_id, scheduled_datetime, safety_flag, safety_flag_note").eq("id", jobId).maybeSingle();
  if (!job || job.user_id !== owner) return json({ error: "Not found" }, 404);
  let onJob = false;
  if (me) {
    const { data } = await user.rpc("safety_is_on_job", { p_job: jobId, p_member: me });
    onJob = data === true;
  }
  if (!isManager && !onJob) return json({ error: "Forbidden" }, 403);

  const { data: settings } = await admin.from("safety_settings").select("enabled, fact_ttl_days, show_unreviewed_call_facts, timezone").eq("user_id", owner).maybeSingle();
  if (!settings?.enabled) return json({ enabled: false });
  const siteKey = normalizeSiteKey(job.address as string | null);
  const action = String(body.action ?? "");

  try {
    if (action === "brief") {
      let facts: FactRow[] = [];
      if (siteKey) {
        const { data } = await admin.from("safety_hazard_facts")
          .select("id, category, fact_text, quote, source, occurred_on, expires_on, review_status, review_note")
          .eq("user_id", owner).eq("site_key", siteKey).in("review_status", ["confirmed", "pending_review"]);
        facts = (data ?? []) as FactRow[];
      }
      const now = new Date();
      // Machine-extracted facts a manager switched off for technicians are not shown or counted.
      const visible = facts.filter((f) => f.review_status === "confirmed" || f.source !== "call_volunteered" || settings.show_unreviewed_call_facts);
      const tierResult = computeRiskTier(visible, now);

      const { data: ruleRows } = await admin.from("safety_policy_rules").select("tier, precautions").eq("user_id", owner);
      const rules: PolicyRules = {};
      for (const r of ruleRows ?? []) rules[r.tier as RiskTier] = r.precautions as PolicyRules[RiskTier];

      const { data: existing } = await admin.from("safety_job_assessments").select("override_tier, override_reason, acknowledged_at").eq("job_id", jobId).maybeSingle();
      const tier = (existing?.override_tier as RiskTier | null) ?? tierResult.tier;
      const precautions = resolvePrecautions(tier, rules);

      const row = { tier: tierResult.tier, precautions, fact_ids: tierResult.fact_ids, capped_pending_review: tierResult.capped_pending_review, computed_at: now.toISOString() };
      if (existing) await admin.from("safety_job_assessments").update(row).eq("job_id", jobId);
      else await admin.from("safety_job_assessments").insert({ job_id: jobId, user_id: owner, ...row });

      const when = job.scheduled_datetime ? new Date(job.scheduled_datetime as string) : null;
      const zone = isValidTimeZone(settings.timezone) ? settings.timezone : "UTC";
      const outsideDaytime = precautions.includes("daytime_only") && when ? !isDaytimeHour(wallTimeIn(when, zone).hour) : false;

      return json({
        enabled: true,
        tier,
        computed_tier: tierResult.tier,
        overridden: !!existing?.override_tier,
        capped_pending_review: tierResult.capped_pending_review,
        precautions,
        outside_daytime: outsideDaytime,
        acknowledged: !!existing?.acknowledged_at,
        site_known: !!siteKey,
        facts: visible.map((f) => ({
          id: f.id,
          category: f.category,
          text: f.fact_text,
          source: f.source,
          occurred_on: f.occurred_on,
          expires_on: f.expires_on,
          status: f.review_status === "confirmed" ? "confirmed" : "unreviewed",
          // The caller's own sentence and review notes are for staff only.
          ...(isManager ? { quote: f.quote, review_note: f.review_note } : {}),
        })),
        job_flag: job.safety_flag ? { note: job.safety_flag_note } : null,
        contact: "If a fact here looks wrong, tell the office. Facts expire and can be reviewed or removed.",
      });
    }

    if (action === "ack_brief") {
      if (!onJob) return json({ error: "Forbidden" }, 403);
      await admin.from("safety_job_assessments").update({ acknowledged_by: me, acknowledged_at: new Date().toISOString() }).eq("job_id", jobId);
      return json({ ok: true });
    }

    if (action === "add_fact") {
      const category = String(body.category ?? "") as HazardCategory;
      const text = String(body.fact_text ?? "").trim();
      if (!HAZARD_CATEGORIES.includes(category)) return json({ error: "Unknown category" }, 400);
      const lint = lintFactText(text);
      if (!lint.ok) return json({ error: "fact_rejected", codes: lint.codes }, 422);
      if (!siteKey) return json({ error: "This job has no street address to attach a fact to" }, 422);

      const today = new Date().toISOString().slice(0, 10);
      const occurred = typeof body.occurred_on === "string" && DATE.test(body.occurred_on) ? body.occurred_on : today;
      if (occurred > today) return json({ error: "The date cannot be in the future" }, 422);
      const expires = new Date(Date.parse(`${occurred}T00:00:00Z`) + (settings.fact_ttl_days as number) * 86_400_000).toISOString().slice(0, 10);

      let source: string;
      let status: string;
      if (isManager) {
        source = ["staff_incident", "equipment_data", "customer_self_report"].includes(String(body.source)) ? String(body.source) : "staff_incident";
        status = "confirmed";
      } else {
        source = "technician_report";
        status = "pending_review";
      }
      const { data, error } = await admin.from("safety_hazard_facts").insert({
        user_id: owner, site_key: siteKey, customer_id: job.customer_id, job_id: jobId, category, fact_text: text, source,
        source_ref: `job:${jobId}`, occurred_on: occurred, expires_on: expires, review_status: status, created_by: (await user.auth.getUser()).data.user?.id ?? null,
      }).select("id").single();
      if (error) {
        if (error.code === "23514") return json({ error: "fact_rejected", codes: ["database_lint"] }, 422);
        throw new Error(error.message);
      }
      return json({ ok: true, id: data.id });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error(JSON.stringify({ event: "safety_api_failed", action, error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Request failed" }, 500);
  }
});
