// supabase/functions/shadow-digest/index.ts
//
// Day 1 / 3 / 7 progress emails for Shadow Mode. Scheduler only (suggested: hourly):
//   POST with header x-shadow-cron-secret = SHADOW_CRON_SECRET.
// Recipient is ALWAYS the account owner's own email. This function never contacts a caller.
// Each digest is claimed atomically BEFORE sending (digests_sent), so overlapping runs cannot double-send;
// if the send fails the claim is released and the next run retries.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHADOW_CRON_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL (opt), SITE_URL (opt).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { timingSafeEqualStr } from "../_shared/voice-hardening/webhookAuth.ts";
import { ESTIMATE_LABEL, digestDue, trialDay } from "../_shared/shadow/logic.ts";
import { computeReportPayload, type TrialRow } from "../_shared/shadow/runtime.ts";
import { esc, money } from "../_shared/shadow/report.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Shadow-Cron-Secret" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sendMail(to: string, subject: string, html: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { ok: false, error: "missing RESEND_API_KEY" };
  const from = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    return res.ok ? { ok: true } : { ok: false, error: (await res.text()).slice(0, 300) };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const secret = Deno.env.get("SHADOW_CRON_SECRET") ?? "";
  const provided = req.headers.get("x-shadow-cron-secret") ?? "";
  if (!secret || !timingSafeEqualStr(provided, secret)) return json({ error: "Forbidden." }, 403);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const nowIso = new Date().toISOString();
  const site = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  const { data: trials } = await admin.from("shadow_trials").select("*").in("status", ["active", "completed"]).limit(200);

  let sent = 0, failed = 0;
  for (const t of (trials ?? []) as TrialRow[]) {
    const due = digestDue(t.started_at, nowIso, t.digests_sent ?? []);
    if (due === null) continue;
    // atomic claim
    const claim = await admin.from("shadow_trials").update({ digests_sent: [...(t.digests_sent ?? []), due] })
      .eq("id", t.id).not("digests_sent", "cs", `{${due}}`).select("id");
    if (claim.error || !claim.data?.length) continue;

    const { data: prof } = await admin.from("profiles").select("email, company_name").eq("id", t.user_id).maybeSingle();
    const to = prof?.email as string | undefined;
    let ok = false;
    if (to) {
      const p = await computeReportPayload(admin, t, nowIso);
      const c = p.counts;
      const day = Math.min(7, trialDay(t.started_at, nowIso));
      const est = p.estimate.reason === "ok" ? `${money(p.estimate.lowCents)} – ${money(p.estimate.highCents)} (${ESTIMATE_LABEL})` : null;
      const lines = [
        `Day ${day} of your Shadow Mode trial. Sarah has been listening — she has not spoken to any caller.`,
        `Calls seen: ${c.callsSeen}. Missed / voicemail / abandoned: ${c.unanswered}. After-hours: ${c.afterHours}. Emergencies flagged: ${c.emergencies}.`,
        `Calls Sarah would have captured: ${c.capturable}.`,
        ...(due === 7 && est ? [`Estimated revenue range: ${est}. This is a projection, not realized revenue.`] : []),
        `Review her decisions and see the full report: ${site}/dashboard/shadow-mode`,
      ];
      const html = `<p>${lines.map(esc).join("</p><p>")}</p>`;
      ok = (await sendMail(to, `Shadow Mode — day ${due} update`, html, lines.join("\n\n"))).ok;
    }
    if (ok) {
      sent++;
      await admin.from("shadow_events").insert({ user_id: t.user_id, trial_id: t.id, kind: "digest_sent", detail: { day: due } });
    } else {
      failed++;
      // release the claim so the next run retries
      await admin.from("shadow_trials").update({ digests_sent: (t.digests_sent ?? []).filter((d) => d !== due) }).eq("id", t.id);
    }
  }
  return json({ ok: true, sent, failed });
});
