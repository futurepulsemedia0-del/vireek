import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeGet } from "../_shared/stripe/terminalPayments.ts";
import { processBankStripeEvent } from "../_shared/bankPayments/runtime.ts";

// Cron (every 30 min, see migration header). Secret header: X-Cron-Secret = PAY_BY_BANK_CRON_SECRET.
//  1) Polls Stripe for bank debits stuck in processing / verification too long (a lost webhook can never strand money).
//  2) Retries accounting posts / reversals that failed (closed period, missing account, ...).
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const STALE_HOURS = 24 * 7;

function eventTypeFor(pi: any): string | null {
  switch (pi?.status) {
    case "succeeded": return "payment_intent.succeeded";
    case "processing": return "payment_intent.processing";
    case "canceled": return "payment_intent.canceled";
    case "requires_action": return pi.next_action?.type === "verify_with_microdeposits" ? "payment_intent.requires_action" : null;
    case "requires_payment_method": return pi.last_payment_error ? "payment_intent.payment_failed" : null;
    default: return null;
  }
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("PAY_BY_BANK_CRON_SECRET");
  if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Unauthorized." }, 401);
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) return json({ error: "Missing STRIPE_SECRET_KEY." }, 500);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const stats = { polled: 0, advanced: 0, accounting: 0, errors: 0 };
  const fail = (step: string, e: unknown) => { stats.errors++; console.error(JSON.stringify({ event: "pay_by_bank_reconcile_error", step, error: e instanceof Error ? e.message : String(e) })); };

  try {
    const { data: stale, error } = await admin.rpc("list_stale_bank_attempts", { p_hours: STALE_HOURS, p_limit: 50 });
    if (error) throw error;
    for (const row of (stale ?? []) as { id: string; provider_payment_id: string }[]) {
      try {
        stats.polled++;
        const pi = await stripeGet(`payment_intents/${row.provider_payment_id}`, stripeKey);
        const type = eventTypeFor(pi);
        if (!type) continue;
        // Synthetic event id = pi + status: a poll can never double-apply, and a real webhook that arrives later is a harmless duplicate.
        const r = await processBankStripeEvent(admin, { id: `poll_${pi.id}_${pi.status}`, type, created: Math.floor(Date.now() / 1000), data: { object: pi } });
        if (r.result === "applied") stats.advanced++;
      } catch (e) { fail(`poll:${row.id}`, e); }
    }
  } catch (e) { fail("stale", e); }

  try {
    const { data: ids, error } = await admin.rpc("list_bank_attempts_needing_accounting", { p_limit: 100 });
    if (error) throw error;
    for (const id of (ids ?? []) as string[]) {
      try {
        const { data } = await admin.rpc("bank_attempt_post_accounting", { p_attempt_id: id });
        if (data === "posted" || data === "reversed") stats.accounting++;
      } catch (e) { fail(`accounting:${id}`, e); }
    }
  } catch (e) { fail("accounting", e); }

  return json({ ok: true, ...stats });
});
