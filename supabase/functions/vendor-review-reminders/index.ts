// supabase/functions/vendor-review-reminders/index.ts
//
// Daily vendor-review reminder. Runs the evaluator (opens/closes reminders in vendor_review_reminders), atomically
// claims the reminders that still need a message, and e-mails ONE digest to every Vireek staff user.
// Idempotent: a reminder is claimed once (overdue ones repeat every 7 days); a retry or double trigger cannot
// send the same reminder twice. If nothing could be delivered, the claim is released so the next run retries.
//
// Auth: header X-Cron-Secret = TRUST_CRON_SECRET (scheduler), or a Vireek staff user's JWT. Not callable by customers.
// Body (optional): { "dryRun": true }  -> evaluate and report counts only; nothing is claimed or sent.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (staff JWT path), TRUST_CRON_SECRET,
//          RESEND_API_KEY, RESEND_FROM_EMAIL (optional).
// Schedule: once a day from your external scheduler, after the 06:23 UTC pg_cron evaluator (see the migration).
// Deploy:   supabase functions deploy vendor-review-reminders

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { authenticate, corsHeaders, cronAuthorized, json, readJson } from "../_shared/trust/http.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { buildDigest, parseClaimed } from "../_shared/compliance/vendorReviewDigest.ts";

const MAX_STAFF = 20;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!cronAuthorized(req)) {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    if (!auth.isStaff) return json({ error: "Forbidden" }, 403);
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return json({ error: "Not configured" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const body = (await readJson(req)) ?? {};
  const dryRun = body.dryRun === true;

  try {
    const { data: evaluated, error: evalErr } = await admin.rpc("vendor_review_evaluate_reminders");
    if (evalErr) throw new Error(`evaluate: ${evalErr.message}`);
    if (dryRun) return json({ ok: true, dryRun: true, evaluated });

    const { data: claimedRaw, error: claimErr } = await admin.rpc("vendor_review_claim_notifications");
    if (claimErr) throw new Error(`claim: ${claimErr.message}`);
    const claimed = parseClaimed(claimedRaw);
    if (claimed.length === 0) return json({ ok: true, evaluated, claimed: 0, sent: 0 });

    const releaseAll = async () => {
      const { error } = await admin.rpc("vendor_review_release_notifications", { p_ids: claimed.map((c) => c.reminder_id) });
      if (error) console.error("[vendor-review-reminders] release failed", error.message.slice(0, 120));
    };

    if (!Deno.env.get("RESEND_API_KEY")) {
      await releaseAll();
      return json({ ok: false, error: "Email is not configured; reminders stay pending." }, 503);
    }

    const digest = buildDigest(claimed);
    if (!digest) return json({ ok: true, evaluated, claimed: 0, sent: 0 });

    const { data: staff } = await admin.from("profiles").select("id").eq("is_staff", true).limit(MAX_STAFF);
    let sent = 0;
    for (const s of staff ?? []) {
      const { data: u } = await admin.auth.admin.getUserById(s.id as string);
      const to = u?.user?.email;
      if (!to) continue;
      const r = await sendEmail(to, digest.subject, digest.html, digest.text);
      if (r.ok) sent++;
      else console.error("[vendor-review-reminders] send failed", r.error?.slice(0, 120));
    }

    if (sent === 0) {
      await releaseAll();
      return json({ ok: false, error: "No reminder delivered; will retry on the next run." }, 502);
    }
    return json({ ok: true, evaluated, claimed: claimed.length, sent, counts: digest.counts });
  } catch (err) {
    console.error("[vendor-review-reminders]", err instanceof Error ? err.message : "unknown");
    return json({ error: "Reminder run failed" }, 500);
  }
});
