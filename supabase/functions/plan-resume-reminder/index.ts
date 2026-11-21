// Sends the single, opt-in "finish choosing your plan" reminder. Meant to run hourly from a scheduler.
//
// Deploy:   supabase functions deploy plan-resume-reminder --no-verify-jwt
// Secrets:  CRON_SECRET (shared with the other cron functions), RESEND_API_KEY, SITE_URL (optional, default https://vireek.com)
// Schedule: POST https://<project>.functions.supabase.co/plan-resume-reminder   header  X-Cron-Secret: <CRON_SECRET>
//
// Who gets it (see plan_onboarding_reminder_candidates): owners who ticked the reminder box, still unsubscribed, idle longer than
// plan_onboarding_config.reminder_delay_hours. sendNoticeOnce() guarantees at most one email per person even with overlapping runs.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireCronAuth } from "../_shared/http/cronAuth.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { sendNoticeOnce } from "../_shared/billing/notices/noticeLog.ts";
import { buildPlanResumeEmail } from "../_shared/billing/planResumeEmail.ts";

const PLAN_NAMES: Record<string, string> = { starter: "Starter", professional: "Professional", business: "Business", enterprise: "Enterprise" };

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.response;

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  const { data, error } = await admin.rpc("plan_onboarding_reminder_candidates", { p_limit: 50 });
  if (error) {
    console.error(JSON.stringify({ event: "plan_resume_candidates_failed", error: error.message }));
    return new Response(JSON.stringify({ error: "Lookup failed." }), { status: 500 });
  }

  const tally = { sent: 0, duplicate: 0, failed: 0 };
  for (const row of (data ?? []) as Array<{ user_id: string; email: string; full_name: string | null; plan: string | null }>) {
    const mail = buildPlanResumeEmail({
      greetingName: (row.full_name ?? "").split(" ")[0] ?? "",
      planName: row.plan ? PLAN_NAMES[row.plan] ?? null : null,
      resumeUrl: `${siteUrl}/onboarding/plan`,
    });
    const outcome = await sendNoticeOnce(admin, row.user_id, "plan_resume", "v1", async () => {
      const r = await sendEmail(row.email, mail.subject, mail.html, mail.text);
      return { ok: r.ok, channels: r.ok ? ["email"] : [], error: r.error };
    });
    tally[outcome] += 1;
  }
  console.log(JSON.stringify({ event: "plan_resume_run", ...tally })); // counts only, no addresses
  return new Response(JSON.stringify(tally), { status: 200, headers: { "Content-Type": "application/json" } });
});
