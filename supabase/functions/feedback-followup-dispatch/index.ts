// supabase/functions/feedback-followup-dispatch/index.ts
//
// Cron (every ~10 min, header X-Cron-Secret = CRON_SECRET). Sends follow-up emails that staff queued in
// /staff/feedback. Only rows with contact_ok = true can be queued (enforced in SQL) and this function
// re-checks it, so nobody is emailed without having opted in.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("X-Cron-Secret") !== secret) return new Response("forbidden", { status: 403 });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: rows, error } = await admin.from("feedback_followups")
    .select("id, user_id, email_body, contact_ok").eq("email_status", "queued").eq("contact_ok", true).limit(25);
  if (error) return new Response("load_failed", { status: 500 });

  let sent = 0, failed = 0;
  for (const r of rows ?? []) {
    // Claim the row first so overlapping runs cannot double-send.
    const { data: claimed } = await admin.from("feedback_followups").update({ email_status: "none" })
      .eq("id", r.id).eq("email_status", "queued").select("id");
    if (!claimed?.length) continue;
    try {
      const { data: u } = await admin.auth.admin.getUserById(r.user_id);
      const to = u?.user?.email;
      if (!to || !r.email_body) throw new Error("no recipient");
      const text = `${r.email_body}\n\n— The Vireek team\nYou received this because you agreed to be contacted about your feedback.`;
      const html = `<p>${esc(r.email_body).replace(/\n/g, "<br>")}</p><p>— The Vireek team</p><p style="color:#6b7280;font-size:12px">You received this because you agreed to be contacted about your feedback.</p>`;
      const res = await sendEmail(to, "Following up on your Vireek feedback", html, text);
      if (!res.ok) throw new Error(res.error ?? "send failed");
      await admin.from("feedback_followups").update({ email_status: "sent", email_error: null }).eq("id", r.id);
      sent++;
    } catch (e) {
      await admin.from("feedback_followups").update({ email_status: "failed", email_error: String((e as Error).message).slice(0, 200) }).eq("id", r.id);
      failed++;
    }
  }
  return new Response(JSON.stringify({ sent, failed }), { headers: { "Content-Type": "application/json" } });
});
