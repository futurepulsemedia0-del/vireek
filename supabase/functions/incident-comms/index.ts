// supabase/functions/incident-comms/index.ts
//
// The ONLY write path for customer incident communication. A signed-in Vireek staff member calls it with an action:
//   draft | update | submit | approve | reject | send
// It authenticates the caller, requires is_vireek_staff, lints every text before submit/approve/send, and only then
// calls the service-role RPCs that enforce the approval state machine (see 20290308000000_incident_comms.sql).
// Nothing is published without a stored human approval bound to the exact text (content hash).
//
// Publishing = (1) status post via status_incident_updates (rendered by public_status_feed on /status)
//              (2) email to status subscribers via the EXISTING notify-status-subscribers function.
// Each step has its own idempotency marker, so a retry after a partial failure never posts or emails twice.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (platform), STATUS_NOTIFY_WEBHOOK_SECRET (if notify-status-subscribers uses it)
// Deploy:  supabase functions deploy incident-comms        (JWT verification stays ON)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  allowedAudiences,
  audienceProblem,
  generateDraft,
  hasBlockingIssue,
  isPhase,
  isSeverity,
  isStale,
  lintDraft,
  type Audience,
  type Phase,
} from "../_shared/incident-comms/incidentCommsLogic.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*", // bearer-JWT endpoint; no cookies involved
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, X-Client-Info",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 5000): string => (typeof v === "string" ? v.slice(0, max) : "");

interface DraftRow {
  id: string;
  incident_id: string;
  phase: Phase;
  severity: string;
  audience: Audience;
  status_post_text: string;
  email_subject: string | null;
  email_body: string | null;
  next_update_at: string | null;
  state: string;
  status_posted_at: string | null;
  content_hash?: string;
}

/** Map a database error to an HTTP answer. The RPC messages are written to be shown to staff. */
function dbFail(err: { code?: string; message: string }) {
  if (err.code === "42501") return json({ ok: false, error: "forbidden", message: err.message }, 403);
  if (err.code === "P0002") return json({ ok: false, error: "not_found", message: err.message }, 404);
  if (err.code === "P0001") return json({ ok: false, error: "conflict", message: err.message }, 409);
  if (err.code === "23514" || err.code === "22023") return json({ ok: false, error: "invalid", message: "The draft is not valid for this severity or audience." }, 422);
  console.error(JSON.stringify({ event: "incident_comms_db_error", code: err.code, error: err.message }));
  return json({ ok: false, error: "server_error", message: "Something went wrong. Please try again." }, 500);
}

async function loadDraft(admin: SupabaseClient, id: string): Promise<DraftRow | null> {
  const { data } = await admin.from("incident_comms_drafts").select("*").eq("id", id).maybeSingle();
  return (data as DraftRow | null) ?? null;
}

const lintOf = (d: DraftRow) => lintDraft({ statusPost: d.status_post_text, emailSubject: d.email_subject, emailBody: d.email_body }, d.phase);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return json({ ok: false, error: "server_not_configured" }, 500);
  const admin = createClient(url, svc, { auth: { persistSession: false, autoRefreshToken: false } });

  // --- authenticate + authorize (staff only) ---
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "unauthorized" }, 401);
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u.user) return json({ ok: false, error: "unauthorized" }, 401);
  const actor = u.user.id;
  const { data: isStaff } = await admin.rpc("is_vireek_staff", { uid: actor });
  if (isStaff !== true) return json({ ok: false, error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const action = str(body.action, 20);
  const id = str(body.id, 40);
  if (action !== "draft" && !UUID_RE.test(id)) return json({ ok: false, error: "invalid_id" }, 400);

  try {
    // ------------------------------------------------------------------ draft
    if (action === "draft") {
      const incidentId = str(body.incident_id, 40);
      const phase = body.phase;
      const severity = body.severity;
      const audience = body.audience;
      if (!UUID_RE.test(incidentId) || !isPhase(phase) || !isSeverity(severity) || (audience !== "status_page" && audience !== "status_page_and_subscribers")) {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      const problem = audienceProblem(severity, audience);
      if (problem || !allowedAudiences(severity).includes(audience)) return json({ ok: false, error: problem ?? "audience_not_allowed", message: "This severity cannot use that audience." }, 422);

      const { data: inc } = await admin
        .from("status_incidents")
        .select("title, impact, component_id, region, started_at")
        .eq("id", incidentId)
        .maybeSingle();
      if (!inc) return json({ ok: false, error: "not_found", message: "Unknown incident." }, 404);

      const draft = generateDraft({
        incident: { title: String(inc.title), impact: inc.impact === "major" ? "major" : "minor", componentId: String(inc.component_id), region: (inc.region as string | null) ?? null, startedAt: String(inc.started_at) },
        phase,
        severity,
        audience,
        now: new Date(),
        customerAction: str(body.customer_action, 300),
      });
      const issues = lintDraft({ statusPost: draft.statusPostText, emailSubject: draft.emailSubject, emailBody: draft.emailBody }, phase);
      if (hasBlockingIssue(issues)) return json({ ok: false, error: "lint_blocked", issues }, 422);

      const { data: newId, error } = await admin.rpc("incident_comms_create_draft", {
        p_actor: actor,
        p_incident: incidentId,
        p_phase: phase,
        p_severity: severity,
        p_audience: audience,
        p_status_post: draft.statusPostText,
        p_email_subject: draft.emailSubject,
        p_email_body: draft.emailBody,
        p_next_update_at: draft.nextUpdateAt ? draft.nextUpdateAt.toISOString() : null,
      });
      if (error) return dbFail(error);
      return json({ ok: true, id: newId, template_id: draft.templateId, issues });
    }

    const d = await loadDraft(admin, id);
    if (!d) return json({ ok: false, error: "not_found", message: "Unknown draft." }, 404);

    // ------------------------------------------------------------------ update
    if (action === "update") {
      const next: DraftRow = {
        ...d,
        status_post_text: str(body.status_post_text, 2000),
        email_subject: d.audience === "status_page" ? null : str(body.email_subject, 500),
        email_body: d.audience === "status_page" ? null : str(body.email_body, 10000),
      };
      const issues = lintOf(next);
      if (hasBlockingIssue(issues)) return json({ ok: false, error: "lint_blocked", issues }, 422);
      const { error } = await admin.rpc("incident_comms_update_draft", {
        p_actor: actor,
        p_id: id,
        p_status_post: next.status_post_text,
        p_email_subject: next.email_subject,
        p_email_body: next.email_body,
      });
      if (error) return dbFail(error);
      return json({ ok: true, issues });
    }

    // ------------------------------------------------------------------ submit / approve (lint gate)
    if (action === "submit" || action === "approve") {
      const issues = lintOf(d);
      if (hasBlockingIssue(issues)) return json({ ok: false, error: "lint_blocked", issues }, 422);
      const problem = audienceProblem(d.severity as never, d.audience);
      if (problem) return json({ ok: false, error: problem, message: "This severity cannot use that audience." }, 422);
      const { error } =
        action === "submit"
          ? await admin.rpc("incident_comms_submit", { p_actor: actor, p_id: id })
          : await admin.rpc("incident_comms_approve", { p_actor: actor, p_id: id, p_hash: str(body.content_hash, 100) });
      if (error) return dbFail(error);
      return json({ ok: true, issues });
    }

    // ------------------------------------------------------------------ reject
    if (action === "reject") {
      const { error } = await admin.rpc("incident_comms_reject", { p_actor: actor, p_id: id, p_reason: str(body.reason, 300) });
      if (error) return dbFail(error);
      return json({ ok: true });
    }

    // ------------------------------------------------------------------ send
    if (action === "send") {
      const issues = lintOf(d);
      if (hasBlockingIssue(issues)) return json({ ok: false, error: "lint_blocked", issues }, 422);
      if (isStale(d.phase, d.next_update_at, new Date(), d.status_posted_at !== null)) {
        return json({ ok: false, error: "draft_stale", message: "The promised next-update time has passed. Generate a new draft." }, 409);
      }

      const claim = await admin.rpc("incident_comms_claim_send", { p_actor: actor, p_id: id });
      if (claim.error) return dbFail(claim.error);
      const c = claim.data as { audience: Audience; phase: Phase; impact: "minor" | "major"; status_post_text: string; email_subject: string | null; email_body: string | null; status_posted: boolean; email_sent: boolean };

      try {
        if (!c.status_posted) {
          const { error } = await admin.rpc("incident_comms_publish_status", { p_actor: actor, p_id: id });
          if (error) throw new Error(`status_post: ${error.message}`);
        }

        let emailResult: { sent: number; failed: number; total: number } | null = null;
        if (c.audience === "status_page_and_subscribers" && !c.email_sent) {
          const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${svc}`, apikey: svc };
          const secret = Deno.env.get("STATUS_NOTIFY_WEBHOOK_SECRET");
          if (secret) headers["X-Webhook-Secret"] = secret;
          const res = await fetch(`${url.replace(/\/$/, "")}/functions/v1/notify-status-subscribers`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: c.email_subject,
              impact: c.impact,
              status: c.phase === "resolved" ? "resolved" : c.phase === "monitoring" ? "monitoring" : "investigating",
              summary: c.email_body,
            }),
          });
          const out = (await res.json().catch(() => ({}))) as { success?: boolean; sent?: number; failed?: number; total?: number };
          if (!res.ok || out.success !== true) throw new Error(`email: http ${res.status}`);
          emailResult = { sent: Number(out.sent ?? 0), failed: Number(out.failed ?? 0), total: Number(out.total ?? 0) };
          // From here the emails are out: never retry this step (a partial failure is reported, not re-sent).
          const { error } = await admin.rpc("incident_comms_mark_emailed", { p_actor: actor, p_id: id, p_result: emailResult });
          if (error) throw new Error(`email_marker: ${error.message}`);
        }

        const fin = await admin.rpc("incident_comms_finish", { p_actor: actor, p_id: id, p_ok: true });
        if (fin.error) throw new Error(`finish: ${fin.error.message}`);
        return json({ ok: true, state: "sent", email: emailResult });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ event: "incident_comms_send_failed", draft: id, error: message }));
        await admin.rpc("incident_comms_finish", { p_actor: actor, p_id: id, p_ok: false, p_error: message });
        return json({ ok: false, error: "send_failed", message: "Sending failed part-way. Steps that already completed will not be repeated if you retry." }, 502);
      }
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (err) {
    console.error(JSON.stringify({ event: "incident_comms_error", error: err instanceof Error ? err.message : String(err) }));
    return json({ ok: false, error: "server_error", message: "Something went wrong. Please try again." }, 500);
  }
});
