// supabase/functions/subprocessor-notice-dispatch/index.ts
//
// Emails a posted sub-processor change notice to (a) verified portal subscribers and
// (b) owners of accounts that opted into the Trust Pack (residency, SLA, encryption or
// dedicated tenant), as required by DPA section 5. Idempotent: each (notice, recipient)
// is recorded in subprocessor_notice_deliveries, so a retry never double-sends.
//
// Auth: staff JWT, or header X-Cron-Secret = TRUST_CRON_SECRET.
// Body: { noticeId } — or {} to dispatch every notice that has not been dispatched yet.
//
// Secrets: RESEND_API_KEY, RESEND_FROM_EMAIL, SITE_URL, TRUST_CRON_SECRET
// Deploy:  supabase functions deploy subprocessor-notice-dispatch

import { authenticate, corsHeaders, cronAuthorized, json, readJson } from "../_shared/trust/http.ts";
import { adminClient } from "../_shared/trust/vault.ts";
import { renderNoticeEmail, type SubprocessorNotice } from "../../../src/lib/trustPack/notices.ts";
import { isUuid } from "../../../src/lib/trustPack/regions.ts";

const MAX_RECIPIENTS_PER_RUN = 500;

async function send(to: string, mail: { subject: string; html: string; text: string }): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("RESEND_FROM_EMAIL"), to, ...mail }),
  });
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!cronAuthorized(req)) {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    if (!auth.isStaff) return json({ error: "Forbidden" }, 403);
  }
  if (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("RESEND_FROM_EMAIL")) return json({ error: "Email is not configured." }, 503);

  const body = (await readJson(req)) ?? {};
  const admin = adminClient();
  const site = Deno.env.get("SITE_URL") ?? "https://vireek.com";

  let q = admin.from("subprocessor_notices").select("*").is("withdrawn_at", null);
  if (typeof body.noticeId === "string") {
    if (!isUuid(body.noticeId)) return json({ error: "Invalid noticeId" }, 400);
    q = q.eq("id", body.noticeId);
  } else {
    q = q.is("dispatched_at", null);
  }
  const { data: notices, error } = await q.limit(20);
  if (error) return json({ error: "Could not load notices." }, 500);

  const result = { notices: 0, sent: 0, skipped: 0, failed: 0, remaining: false };

  // Account owners that opted into the Trust Pack.
  const ownerIds = new Set<string>();
  for (const table of ["tenant_residency", "sla_policies", "tenant_encryption_policy", "dedicated_tenants"]) {
    const { data } = await admin.from(table).select("user_id");
    for (const r of data ?? []) ownerIds.add(r.user_id as string);
  }
  const ownerEmails: string[] = [];
  for (const id of ownerIds) {
    const { data } = await admin.auth.admin.getUserById(id);
    if (data?.user?.email) ownerEmails.push(data.user.email.toLowerCase());
  }
  const { data: subs } = await admin.from("subprocessor_subscribers")
    .select("email,unsubscribe_token").not("verified_at", "is", null).is("unsubscribed_at", null);

  for (const n of (notices ?? []) as (SubprocessorNotice & { dispatched_at: string | null })[]) {
    result.notices++;
    const { data: done } = await admin.from("subprocessor_notice_deliveries").select("email").eq("notice_id", n.id);
    const already = new Set((done ?? []).map((d: { email: unknown }) => String(d.email).toLowerCase()));

    const recipients: { email: string; audience: "subscriber" | "account_owner"; unsub: string | null }[] = [
      ...ownerEmails.map((email) => ({ email, audience: "account_owner" as const, unsub: null })),
      ...(subs ?? []).map((s: { email: unknown; unsubscribe_token: unknown }) => ({ email: String(s.email).toLowerCase(), audience: "subscriber" as const, unsub: s.unsubscribe_token as string })),
    ];

    let sentThisRun = 0;
    let complete = true;
    for (const r of recipients) {
      if (already.has(r.email)) { result.skipped++; continue; }
      if (sentThisRun >= MAX_RECIPIENTS_PER_RUN) { complete = false; result.remaining = true; break; }
      const mail = renderNoticeEmail(n, { siteUrl: site, unsubscribeUrl: r.unsub ? `${site.replace(/\/+$/, "")}/trust/security?unsubscribe=${r.unsub}#subprocessor-notices` : null });
      let ok = false;
      try { ok = await send(r.email, mail); } catch { ok = false; }
      if (ok) {
        await admin.from("subprocessor_notice_deliveries").upsert({ notice_id: n.id, email: r.email, audience: r.audience }, { onConflict: "notice_id,email" });
        already.add(r.email);
        result.sent++;
        sentThisRun++;
      } else {
        result.failed++;
        complete = false;
      }
    }
    if (complete) await admin.from("subprocessor_notices").update({ dispatched_at: new Date().toISOString() }).eq("id", n.id);
  }
  return json(result);
});
