// supabase/functions/closeout-deadline-engine/index.ts
//
// Daily Install Closeout deadline engine.
//
//   1) runs public.closeout_engine_tick()  (marks missed deadlines, creates escalations + in-app
//      notifications — idempotent, so it is safe even though pg_cron also runs it)
//   2) e-mails the escalations that were created: technician -> office -> owner
//
// NOTHING is submitted to any manufacturer / utility / government portal here. Ever.
//
// Deploy WITHOUT JWT verification (auth is the shared secret below):
//   supabase functions deploy closeout-deadline-engine --no-verify-jwt
// Secrets: CLOSEOUT_CRON_SECRET (required) · SITE_URL · RESEND_API_KEY / RESEND_FROM_EMAIL
// Call:    POST with header `x-closeout-secret` (daily, from pg_cron -> dispatch_closeout_engine()).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-closeout-secret, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_BATCH = 200;
const MAX_ATTEMPTS = 3;
const TIER_LABEL: Record<number, string> = { 1: "technician", 2: "office", 3: "owner" };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const STEP_LABEL: Record<string, string> = {
  permit: "Permit", inspection: "Inspection", warranty: "Warranty registration",
  rebate: "Rebate claim", customer_docs: "Customer documents",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expected = Deno.env.get("CLOSEOUT_CRON_SECRET") ?? "";
  const provided = req.headers.get("x-closeout-secret") ?? "";
  if (!expected || !safeEqual(provided, expected)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  try {
    const { data: tick, error: tickError } = await admin.rpc("closeout_engine_tick");
    if (tickError) throw tickError;

    const { data: pending, error: pendingError } = await admin
      .from("closeout_escalations")
      .select("id, user_id, step_id, tier, deadline_on, days_left, missing_count, attempts")
      .is("delivered_at", null)
      .lt("attempts", MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(MAX_BATCH);
    if (pendingError) throw pendingError;

    let delivered = 0, failed = 0;
    const ownerCache = new Map<string, { owner: string | null; office: string[] }>();

    async function recipientsFor(ownerId: string) {
      const hit = ownerCache.get(ownerId);
      if (hit) return hit;
      const [{ data: prof }, { data: team }] = await Promise.all([
        admin.from("profiles").select("email").eq("id", ownerId).maybeSingle(),
        admin.from("team_members").select("member_email, role, invite_status")
          .eq("account_owner_id", ownerId).eq("invite_status", "active").in("role", ["admin", "manager", "dispatcher"]),
      ]);
      const value = {
        owner: (prof?.email as string | null) ?? null,
        office: (team ?? []).map((t) => String(t.member_email)).filter(Boolean),
      };
      ownerCache.set(ownerId, value);
      return value;
    }

    for (const esc_ of pending ?? []) {
      const { data: step } = await admin
        .from("closeout_steps")
        .select("id, step_key, status, assignee_member_id, job_id, program_id")
        .eq("id", esc_.step_id).maybeSingle();
      // Step finished or gone since the escalation was queued: nothing to send.
      if (!step || ["completed", "not_applicable", "submitted"].includes(step.status as string)) {
        await admin.from("closeout_escalations")
          .update({ delivered_at: new Date().toISOString(), delivery_note: "skipped: step no longer open" })
          .eq("id", esc_.id);
        continue;
      }

      const [{ data: job }, { data: program }] = await Promise.all([
        admin.from("jobs").select("customer_name").eq("id", step.job_id as string).maybeSingle(),
        step.program_id
          ? admin.from("closeout_programs").select("name").eq("id", step.program_id as string).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      const rec = await recipientsFor(esc_.user_id as string);
      let to: string[] = [];
      if (esc_.tier === 1) {
        if (step.assignee_member_id) {
          const { data: m } = await admin.from("team_members").select("member_email")
            .eq("id", step.assignee_member_id as string).eq("account_owner_id", esc_.user_id as string).maybeSingle();
          if (m?.member_email) to = [String(m.member_email)];
        }
        if (to.length === 0) to = rec.office; // no technician assigned: office hears it first
      } else if (esc_.tier === 2) {
        to = rec.office.length ? rec.office : rec.owner ? [rec.owner] : [];
      } else {
        to = rec.owner ? [rec.owner] : [];
      }
      to = Array.from(new Set(to));

      const label = (program?.name as string | undefined) ?? STEP_LABEL[step.step_key as string] ?? "Closeout step";
      const customer = (job?.customer_name as string | undefined) ?? "a customer";
      const days = esc_.days_left as number;
      const when = days < 0 ? `overdue by ${Math.abs(days)} day(s)` : days === 0 ? "due today" : `due in ${days} day(s)`;
      const missing = (esc_.missing_count as number) > 0 ? ` ${esc_.missing_count} required item(s) are still missing.` : "";
      const link = `${siteUrl}/dashboard/install-closeout?step=${step.id}`;
      const subject = `${days < 0 ? "MISSED" : "Deadline"}: ${label} — ${customer}`;
      const text =
        `${label} for ${customer} is ${when} (deadline ${esc_.deadline_on}).${missing}\n` +
        `Escalation level: ${TIER_LABEL[esc_.tier as number]}.\n\nOpen the checklist: ${link}\n\n` +
        `Nothing is submitted automatically — a person must approve and file this with the program or authority.`;
      const html =
        `<div style="font-family:Arial,sans-serif;max-width:520px;line-height:1.5;color:#111827">` +
        `<h2 style="margin:0 0 8px">${esc(label)} — ${esc(customer)}</h2>` +
        `<p>This step is <strong>${esc(when)}</strong> (deadline ${esc(String(esc_.deadline_on))}).${esc(missing)}</p>` +
        `<p>Escalation level: <strong>${esc(TIER_LABEL[esc_.tier as number])}</strong></p>` +
        `<p><a href="${esc(link)}" style="color:#2563eb">Open the closeout checklist</a></p>` +
        `<p style="color:#6b7280;font-size:12px">Nothing is submitted automatically — a person must approve and file this with the program or authority.</p></div>`;

      if (to.length === 0) {
        await admin.from("closeout_escalations")
          .update({ delivered_at: new Date().toISOString(), delivery_note: "no e-mail recipients; in-app notification only" })
          .eq("id", esc_.id);
        continue;
      }

      let okCount = 0;
      let lastError = "";
      for (const addr of to) {
        try {
          const r = await sendEmail(addr, subject, html, text);
          if (r.ok) okCount++; else lastError = r.error ?? "send failed";
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }

      const attempts = ((esc_.attempts as number) ?? 0) + 1;
      if (okCount > 0) {
        delivered++;
        await admin.from("closeout_escalations")
          .update({ delivered_at: new Date().toISOString(), attempts, delivery_note: `sent to ${okCount}/${to.length}` })
          .eq("id", esc_.id);
      } else {
        failed++;
        await admin.from("closeout_escalations")
          .update({
            attempts,
            delivered_at: attempts >= MAX_ATTEMPTS ? new Date().toISOString() : null,
            delivery_note: `e-mail failed: ${lastError}`.slice(0, 300),
          })
          .eq("id", esc_.id);
      }
    }

    return json({ ok: true, tick, queued: pending?.length ?? 0, delivered, failed });
  } catch (e) {
    console.error("closeout-deadline-engine failed:", e instanceof Error ? e.message : e);
    return json({ error: "Engine failed." }, 500);
  }
});
