// supabase/functions/growth-weekly-digest/index.ts
//
// Weekly founder digest: evaluates alert rules, builds the snapshot, turns it into recommended actions
// (rules in _shared/growth/digest.ts) and emails every staff user. At most one send per ISO week.
//
// Caller: header x-growth-cron-secret = GROWTH_CRON_SECRET (schedule e.g. Mondays 07:00 UTC). Not callable by users.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROWTH_CRON_SECRET (>=16 chars), RESEND_API_KEY,
//          RESEND_FROM_EMAIL (optional), SITE_URL (optional).
// Deploy: supabase functions deploy growth-weekly-digest

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { cronSecretMatches } from "../_shared/growth/auth.ts";
import { buildDigest, renderDigest, type DigestSnapshot } from "../_shared/growth/digest.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function isoWeekStart(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() - (day - 1));
  return x.toISOString().slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!cronSecretMatches(req.headers.get("x-growth-cron-secret"), Deno.env.get("GROWTH_CRON_SECRET") ?? "")) {
    return json({ error: "Unauthorized" }, 401);
  }
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return json({ error: "Not configured" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const weekStart = isoWeekStart(new Date());
  try {
    // Claim the week first so a retry or double trigger cannot send twice.
    const { data: claim, error: claimErr } = await admin
      .from("growth_digest_log").upsert({ week_start: weekStart, recipients: 0 }, { onConflict: "week_start", ignoreDuplicates: true })
      .select("week_start");
    if (claimErr) throw new Error(`claim: ${claimErr.message}`);
    if (!claim || claim.length === 0) return json({ ok: true, skipped: "already_sent_this_week" });

    const release = async () => { await admin.from("growth_digest_log").delete().eq("week_start", weekStart); };

    const { error: alertErr } = await admin.rpc("growth_evaluate_alerts");
    if (alertErr) { await release(); throw new Error(`alerts: ${alertErr.message}`); }
    const { data: snap, error: snapErr } = await admin.rpc("growth_digest_snapshot");
    if (snapErr || !snap) { await release(); throw new Error(`snapshot: ${snapErr?.message ?? "empty"}`); }

    const site = (Deno.env.get("SITE_URL") ?? "https://vireek.com").replace(/\/$/, "");
    const digest = buildDigest(snap as DigestSnapshot, `week of ${weekStart}`);
    const mail = renderDigest(digest, `${site}/staff/growth`);

    const { data: staff } = await admin.from("profiles").select("id").eq("is_staff", true).limit(20);
    let sent = 0;
    for (const s of staff ?? []) {
      const { data: u } = await admin.auth.admin.getUserById(s.id as string);
      const to = u?.user?.email;
      if (!to) continue;
      const r = await sendEmail(to, mail.subject, mail.html, mail.text);
      if (r.ok) sent++;
      else console.error("[growth-weekly-digest] send failed", r.error?.slice(0, 120));
    }
    if (sent === 0) { await release(); return json({ ok: false, error: "No digest delivered; will retry on next trigger" }, 502); }
    await admin.from("growth_digest_log").update({ recipients: sent, snapshot: snap }).eq("week_start", weekStart);
    return json({ ok: true, recipients: sent, actions: digest.actions.length });
  } catch (err) {
    console.error("[growth-weekly-digest]", err instanceof Error ? err.message : "unknown");
    return json({ error: "Digest failed" }, 500);
  }
});
