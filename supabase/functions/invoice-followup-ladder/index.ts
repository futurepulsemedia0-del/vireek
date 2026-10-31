// Approval-to-Cash follow-up ladder (cron).
//
//   POST (no body) with header  X-Cron-Secret: <APPROVAL_TO_CASH_CRON_SECRET>
//
// Safety properties
// - FAILS CLOSED: if the secret env var is unset or the header does not match (constant-time), 401.
// - HUMAN APPROVAL REQUIRED: only invoices whose tracking row has followups_approved_at are even selected,
//   and the claim RPC re-checks it atomically.
// - IDEMPOTENT: each ladder step is claimed with a compare-and-set (a2c_claim_followup_step) BEFORE sending;
//   concurrent/duplicate runs cannot send the same step twice. A failed send releases the claim for retry.
// - At most ONE email per invoice per run (see decideLadderStep); malformed rows are skipped + logged, never guessed.
// - Rejected invoices are never dunned (they need a human); they flow to revenue_recovery_events instead.
// - Also syncs overdue/rejected invoices into revenue_recovery_events (a2c_sync_recovery_events).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { invoiceRecipientEmails, resolveContactRecipients } from "../_shared/customers/contactRecipients.ts";
import { resolveCustomerLanguage } from "../_shared/i18n/customerLanguage.ts";
import { escapeHtml, formatDate, formatMoney, htmlLangAttrs, renderTemplate, textAlignStart } from "../_shared/i18n/templates.ts";
import { decideLadderStep, type ApState } from "../_shared/approvalToCash/logic.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret" };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const log = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...extra }));

interface Candidate {
  invoice_id: string; owner_id: string; customer_id: string | null; customer_name: string; customer_email: string | null;
  customer_phone: string | null; invoice_number: string; invoice_token: string; due_date: string | null; invoice_status: string;
  balance_cents: number | string; ap_state: string; followups_paused: boolean; last_ladder_step: number; ladder: number[]; business_name: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("APPROVAL_TO_CASH_CRON_SECRET") ?? "";
  const provided = req.headers.get("X-Cron-Secret") ?? "";
  if (!secret || !timingSafeEqual(provided, secret)) return json({ error: "Unauthorized." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const today = new Date().toISOString().slice(0, 10); // UTC calendar day; same basis as the SQL current_date
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const stats = { candidates: 0, sent: 0, skipped: 0, failed: 0, recovery_synced: 0 };

  try {
    const { data, error } = await admin.rpc("a2c_followup_candidates", { p_today: today, p_limit: 200 });
    if (error) throw error;
    const candidates = (data ?? []) as Candidate[];
    stats.candidates = candidates.length;

    for (const c of candidates) {
      let claim: { from: number; to: number } | null = null;
      let delivered = false;
      try {
        const decision = decideLadderStep(
          {
            dueDate: c.due_date,
            balanceCents: Number(c.balance_cents),
            invoiceStatus: c.invoice_status as "sent" | "viewed",
            apState: c.ap_state as ApState,
            followupsApproved: true, // selected by the RPC only when approved; the claim re-checks atomically
            followupsPaused: c.followups_paused,
            lastLadderStep: c.last_ladder_step,
          },
          c.ladder ?? [],
          today,
        );
        if (!decision.send) {
          stats.skipped++;
          if (["malformed_date", "invalid_ladder", "missing_due_date"].includes(decision.reason)) {
            log("a2c_followup_skipped_bad_data", { invoice_id: c.invoice_id, reason: decision.reason });
          }
          continue;
        }

        const contacts = await resolveContactRecipients(admin, c.owner_id, c.customer_id, "invoice");
        const recipients = invoiceRecipientEmails(c.customer_email, contacts, (v: string) => EMAIL_RE.test(v));
        if (recipients.length === 0) {
          stats.skipped++;
          log("a2c_followup_skipped_no_recipient", { invoice_id: c.invoice_id });
          continue;
        }

        // Atomic claim BEFORE any external send.
        const { data: claimed, error: claimErr } = await admin.rpc("a2c_claim_followup_step", {
          p_invoice_id: c.invoice_id, p_from_step: c.last_ladder_step, p_to_step: decision.stepNumber,
        });
        if (claimErr) throw claimErr;
        if (claimed !== true) { stats.skipped++; continue; } // another run won, or state changed
        claim = { from: c.last_ladder_step, to: decision.stepNumber };

        const language = await resolveCustomerLanguage(admin, c.owner_id, { customerId: c.customer_id, phone: c.customer_phone, email: recipients[0] });
        const L = (key: Parameters<typeof renderTemplate>[0]) => renderTemplate(key, language);
        const business = c.business_name || L("invoice.email.fallbackBusiness");
        const subject = renderTemplate("invoice.email.subject.overdue", language, { number: c.invoice_number, business });
        const greeting = renderTemplate("invoice.email.greeting", language, { name: c.customer_name });
        const lead = L("invoice.email.lead.reminder");
        const balanceLabel = formatMoney(Number(c.balance_cents) / 100, language);
        const dueLine = c.due_date ? renderTemplate("invoice.email.due", language, { date: formatDate(c.due_date, language) }) : "";
        const link = `${siteUrl}/invoice/${c.invoice_token}`;
        const text = `${greeting}\n\n${lead}\n\n${L("invoice.email.label.invoice")} ${c.invoice_number}\n${L("invoice.email.label.balance")}: ${balanceLabel}\n${dueLine}\n\n${L("invoice.email.viewHere")} ${link}\n\n${L("invoice.email.signoff")}\n${business}`;
        const html = `<div ${htmlLangAttrs(language)} style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#171717;text-align:${textAlignStart(language)}">
<p>${escapeHtml(greeting)}</p><p>${escapeHtml(lead)}</p>
<p><strong>${escapeHtml(L("invoice.email.label.invoice"))} ${escapeHtml(c.invoice_number)}</strong><br/>${escapeHtml(L("invoice.email.label.balance"))}: <strong>${escapeHtml(balanceLabel)}</strong>${dueLine ? `<br/>${escapeHtml(dueLine)}` : ""}</p>
<p style="margin:24px 0"><a href="${link}" style="background:#203ad8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">${escapeHtml(L("invoice.email.cta"))}</a></p>
<p style="color:#6e6e78;font-size:13px">${escapeHtml(L("invoice.email.signoff"))}<br/>${escapeHtml(business)}</p></div>`;

        const sentTo: string[] = [];
        for (const addr of recipients) {
          const r = await sendEmail(addr, subject, html, text);
          const ok = r.ok;
          if (ok) sentTo.push(addr);
          await admin.from("invoice_reminders").insert({
            user_id: c.owner_id, invoice_id: c.invoice_id, kind: "reminder", channel: "email", recipient: addr,
            status: ok ? "sent" : "failed", error: ok ? null : (r.error ?? "Unknown error").slice(0, 500),
            // unique (invoice_id, ladder_step) WHERE sent: record the step on the first successful row only
            ladder_step: ok && sentTo.length === 1 ? decision.stepNumber : null,
            sent_by: null, sent_by_email: "approval-to-cash ladder",
          });
        }

        if (sentTo.length === 0) {
          await admin.rpc("a2c_release_followup_step", { p_invoice_id: c.invoice_id, p_from_step: c.last_ladder_step, p_to_step: decision.stepNumber });
          stats.failed++;
          log("a2c_followup_send_failed", { invoice_id: c.invoice_id, step: decision.stepNumber });
          continue;
        }

        delivered = true;
        await admin.from("audit_log").insert({
          user_id: c.owner_id, actor_id: null, actor_email: "approval-to-cash ladder", action: "invoice_followup_sent",
          target_table: "invoices", target_id: c.invoice_id,
          details: { step: decision.stepNumber, days_overdue: decision.daysOverdue, recipients: sentTo },
        });
        stats.sent++;
      } catch (e) {
        if (claim && !delivered) {
          // Nothing reached the customer: release the claim so the next run retries this step.
          try {
            await admin.rpc("a2c_release_followup_step", { p_invoice_id: c.invoice_id, p_from_step: claim.from, p_to_step: claim.to });
          } catch { /* best effort; the claim stays and is visible in logs */ }
        }
        stats.failed++;
        log("a2c_followup_invoice_error", { invoice_id: c.invoice_id, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const { data: synced, error: syncErr } = await admin.rpc("a2c_sync_recovery_events", { p_today: today, p_limit: 5000 });
    if (syncErr) log("a2c_recovery_sync_failed", { error: syncErr.message });
    else stats.recovery_synced = Number(synced ?? 0);

    return json({ ok: true, today, ...stats });
  } catch (error) {
    log("a2c_followup_run_failed", { error: error instanceof Error ? error.message : String(error) });
    return json({ error: "Follow-up run failed." }, 500);
  }
});
