import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { nextReminder, reminderMessage } from "../_shared/paymentPlans/logic.ts";
import { chargeInstallment, notifyCustomer, payLinkFor } from "../_shared/paymentPlans/charge.ts";

// Hourly cron (see migration header). Order matters: late fees -> auto-charges (so a fee is included in the charge) -> reminders.
Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("PAYMENT_PLAN_CRON_SECRET");
  if (!cronSecret || req.headers.get("X-Cron-Secret") !== cronSecret) return new Response(JSON.stringify({ error: "Unauthorized." }), { status: 401 });
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) return new Response(JSON.stringify({ error: "Missing STRIPE_SECRET_KEY." }), { status: 500 });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const stats = { late_fees: 0, charged: 0, failed: 0, requires_action: 0, errors: 0, reminders: 0 };
  const fail = (step: string, e: unknown) => { stats.errors++; console.error(JSON.stringify({ event: "payment_plan_runner_error", step, error: e instanceof Error ? e.message : String(e) })); };

  try {
    const { data: fees, error } = await admin.rpc("assess_payment_plan_late_fees");
    if (error) throw error;
    stats.late_fees = fees ?? 0;
  } catch (e) { fail("late_fees", e); }

  try {
    const { data: ids, error } = await admin.rpc("list_installments_to_charge", { p_limit: 100 });
    if (error) throw error;
    for (const id of (ids ?? []) as string[]) {
      try {
        const r = await chargeInstallment(admin, secretKey, id, false);
        if (r.outcome === "paid") stats.charged++;
        else if (r.outcome === "failed") stats.failed++;
        else if (r.outcome === "requires_action") stats.requires_action++;
      } catch (e) { fail(`charge:${id}`, e); } // one bad row never blocks the rest
    }
  } catch (e) { fail("charges", e); }

  try {
    const { data: rows, error } = await admin.rpc("list_installments_for_reminders");
    if (error) throw error;
    const today = new Date().toISOString().slice(0, 10);
    for (const r of (rows ?? []) as any[]) {
      try {
        const next = nextReminder({ kind: r.kind, status: r.status, due_date: r.due_date, reminders_sent: r.reminders_sent ?? [], auto_charge: r.auto_charge }, today);
        if (!next) continue;
        const msg = reminderMessage(next.stage, { name: r.customer_name, amountCents: Number(r.amount_cents), lateFeeCents: Number(r.late_fee_cents), currency: r.currency, dueDate: r.due_date, autoCharge: r.auto_charge, link: payLinkFor("i", r.id) });
        await notifyCustomer({ customer_phone: r.customer_phone, customer_email: r.customer_email }, msg.subject, msg.text);
        await admin.rpc("mark_plan_reminders_sent", { p_installment_id: r.id, p_stages: next.mark });
        stats.reminders++;
      } catch (e) { fail(`reminder:${r.id}`, e); }
    }
  } catch (e) { fail("reminders", e); }

  return new Response(JSON.stringify({ ok: true, ...stats }), { status: 200, headers: { "Content-Type": "application/json" } });
});
