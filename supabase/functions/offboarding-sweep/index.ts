// supabase/functions/offboarding-sweep/index.ts
//
// Hourly job (scheduled by public.offboarding_cron_tick(), or your external cron):
//   1. offboarding_reconcile()  scheduled -> ended, ended -> reactivated (+ win-back attribution)
//   2. winback_claim_due()      atomically claims due messages (kill switch, consent, seq-2-after-seq-1 enforced in SQL)
//   3. per message: re-check eligibility, send, record the outcome via winback_finish()
//
// Fail-closed: no WINBACK_POSTAL_ADDRESS => nothing is claimed or sent (marketing email needs a sender address).
// [COUNSEL] confirm the address, sender identity and wording before enabling win-back in /staff/offboarding.
//
// Auth: header x-push-dispatch-secret must equal PUSH_DISPATCH_SECRET (same as the other cron functions).
// Secrets: PUSH_DISPATCH_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL, SITE_URL, SUPPORT_EMAIL (optional),
//          WINBACK_POSTAL_ADDRESS
// Deploy:  supabase functions deploy offboarding-sweep --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { composeWinback, isWinbackSeq, winbackSkipReason, type ClaimedMessage, type WinbackOwner } from "../_shared/offboarding/offboardingLogic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-push-dispatch-secret",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const log = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...extra }));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const expected = Deno.env.get("PUSH_DISPATCH_SECRET");
  if (!expected) return json({ error: "not_configured" }, 500);
  if (!timingSafeEqual(req.headers.get("x-push-dispatch-secret") ?? "", expected)) return json({ error: "unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const summary = { ended: 0, reactivated: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, blocked: null as string | null };

  // 1. Reconcile (never blocked by the email config: outcome tracking must keep working).
  const rec = await admin.rpc("offboarding_reconcile");
  if (rec.error) {
    log("offboarding_reconcile_failed", { error: rec.error.message });
    return json({ error: "reconcile_failed" }, 500);
  }
  const r = (rec.data ?? {}) as { ended?: number; reactivated?: number };
  summary.ended = Number(r.ended ?? 0);
  summary.reactivated = Number(r.reactivated ?? 0);

  // 2. Fail closed on missing sender identity.
  const postalAddress = str(Deno.env.get("WINBACK_POSTAL_ADDRESS"));
  if (!postalAddress) {
    summary.blocked = "missing_postal_address";
    log("winback_blocked", { reason: summary.blocked });
    return json({ ok: true, ...summary });
  }
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const supportEmail = Deno.env.get("SUPPORT_EMAIL") || "ali@vireek.com";

  const claim = await admin.rpc("winback_claim_due", { p_limit: 25 });
  if (claim.error) {
    log("winback_claim_failed", { error: claim.error.message });
    return json({ error: "claim_failed" }, 500);
  }
  const messages = (claim.data ?? []) as ClaimedMessage[];
  summary.claimed = messages.length;

  for (const msg of messages) {
    try {
      const [{ data: profile }, { data: deletion }] = await Promise.all([
        admin.from("profiles").select("email, full_name, company_name, status, subscription_status").eq("id", msg.user_id).maybeSingle(),
        admin
          .from("deletion_requests")
          .select("id")
          .eq("user_id", msg.user_id)
          .eq("request_type", "full_account")
          .in("status", ["grace_period", "processing", "blocked_legal_hold", "completed"])
          .limit(1),
      ]);

      const owner: WinbackOwner | null = profile
        ? {
            email: str((profile as Record<string, unknown>).email),
            name: (str((profile as Record<string, unknown>).full_name) ?? "").split(" ")[0] ?? "",
            companyName: str((profile as Record<string, unknown>).company_name),
            status: str((profile as Record<string, unknown>).status),
            subscriptionStatus: str((profile as Record<string, unknown>).subscription_status),
          }
        : null;

      const skip = winbackSkipReason(msg, { owner, deletionRequested: (deletion ?? []).length > 0 });
      if (skip || !owner || !isWinbackSeq(msg.seq)) {
        await admin.rpc("winback_finish", { p_message: msg.message_id, p_outcome: "skipped", p_detail: skip ?? "invalid" });
        summary.skipped += 1;
        continue;
      }

      const email = composeWinback({
        seq: msg.seq,
        name: owner.name,
        reason: msg.reason,
        accessEndsAt: msg.access_ends_at,
        siteUrl,
        unsubscribeToken: msg.unsubscribe_token,
        postalAddress,
        supportEmail,
      });

      const sent = await sendEmail(owner.email as string, email.subject, email.html, email.text);
      if (sent.ok) {
        // The email is already out: record it, retry once, and shout if the bookkeeping still fails.
        let done = await admin.rpc("winback_finish", { p_message: msg.message_id, p_outcome: "sent" });
        if (done.error) done = await admin.rpc("winback_finish", { p_message: msg.message_id, p_outcome: "sent" });
        if (done.error) log("winback_finish_failed_after_send", { message: msg.message_id, error: done.error.message });
        summary.sent += 1;
      } else {
        await admin.rpc("winback_finish", { p_message: msg.message_id, p_outcome: "failed", p_detail: sent.error ?? "send_failed" });
        summary.failed += 1;
      }
    } catch (err) {
      // The claim stays in 'sending'; offboarding_reconcile() parks it as 'failed' after an hour. It is never re-sent
      // (at-most-once: a lost marketing email is acceptable, a duplicate is not).
      summary.failed += 1;
      log("winback_message_threw", { message: msg.message_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  log("offboarding_sweep_done", summary);
  return json({ ok: true, ...summary });
});
