// Daily cron: commercial follow-up ladder + overdue ledger sync.
//
//   POST {}   header X-Cron-Secret: $COMMERCIAL_COLLECTIONS_CRON_SECRET
//
// Per commercial customer (opt-in profile): sends ladder reminders by the existing invoice
// email templates, and at the demand threshold QUEUES a human-review draft. It never sends a
// demand letter, lien or any legal document - there is no code path for that.
// Idempotent: every (invoice, step, kind) is claimed once in commercial_followups before acting.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { invoiceRecipientEmails, resolveContactRecipients } from "../_shared/customers/contactRecipients.ts";
import { resolveCustomerLanguage } from "../_shared/i18n/customerLanguage.ts";
import { escapeHtml, formatDate, formatMoney, htmlLangAttrs, renderTemplate } from "../_shared/i18n/templates.ts";
import { buildDemandDraft, daysBetween, nextLadderAction } from "../_shared/commercialCash/logic.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret" };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  // Fail closed: this function emails customers, so a missing secret is a misconfiguration.
  const cronSecret = Deno.env.get("COMMERCIAL_COLLECTIONS_CRON_SECRET");
  if (!cronSecret) return json({ error: "COMMERCIAL_COLLECTIONS_CRON_SECRET is not configured." }, 500);
  if (req.headers.get("X-Cron-Secret") !== cronSecret) return json({ error: "Unauthorized." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const today = new Date().toISOString();
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const stats = { candidates: 0, reminders_sent: 0, reminders_failed: 0, drafts_queued: 0, recovery_synced: 0, skipped: 0, errors: 0 };

  try {
    const { data: cands, error } = await admin.rpc("commercial_collections_candidates", { p_limit: 500 });
    if (error) throw error;
    const rows = (cands ?? []) as Row[];
    stats.candidates = rows.length;
    if (rows.length === 0) return json({ ok: true, ...stats });

    const ids = rows.map((r) => r.invoice_id);
    const { data: done } = await admin.from("commercial_followups").select("invoice_id, step_day, kind, status").in("invoice_id", ids);
    const doneBy = new Map<string, Row[]>();
    for (const d of (done ?? []) as Row[]) doneBy.set(d.invoice_id, [...(doneBy.get(d.invoice_id) ?? []), d]);

    const { data: profiles } = await admin.from("profiles").select("id, company_name").in("id", [...new Set(rows.map((r) => r.user_id))]);
    const company = new Map<string, string>(((profiles ?? []) as Row[]).map((p) => [p.id, p.company_name as string]));

    for (const r of rows) {
      try {
        // Rejected invoices are not chased; they sit in the recovery ledger (written when rejected).
        if (r.stage === "rejected") { stats.skipped++; continue; }

        const overdue = r.due_date && daysBetween(r.due_date, today) > 0;
        if (overdue) {
          await admin.rpc("commercial_sync_recovery_event", {
            p_invoice_id: r.invoice_id, p_source_type: "invoice_overdue",
            p_note: `Commercial invoice ${r.invoice_number} is ${daysBetween(r.due_date, today)} days past due.`,
          });
          stats.recovery_synced++;
        }

        const anchor = r.ladder_basis === "due" ? r.due_date : r.invoice_sent_at;
        const mine = doneBy.get(r.invoice_id) ?? [];
        const doneReminders = mine.filter((d) => d.kind === "reminder" && d.status !== "failed").map((d) => d.step_day as number);
        const failedRetry = mine.filter((d) => d.kind === "reminder" && d.status === "failed").map((d) => d.step_day as number);
        const draftDone = mine.some((d) => d.kind === "demand_draft" && d.status !== "failed");
        const action = nextLadderAction({
          anchor, today, ladderDays: r.ladder_days, demandDraftAfterDays: r.demand_draft_after_days,
          doneReminders: doneReminders.filter((s) => !failedRetry.includes(s)), draftDone,
        });
        if (action.action === "none") continue;

        const ok = await admin.rpc("commercial_claim_followup", { p_invoice_id: r.invoice_id, p_step_day: action.stepDay, p_kind: action.action });
        if (ok.error) throw ok.error;
        if (ok.data !== true) { stats.skipped++; continue; } // another run owns it, or it is already done

        const business = company.get(r.user_id) || "";
        const language = await resolveCustomerLanguage(admin, r.user_id, { customerId: r.customer_id, phone: r.customer_phone, email: r.customer_email });
        const balanceLabel = formatMoney(Number(r.balance_cents) / 100, language);

        if (action.action === "demand_draft") {
          const { count } = await admin.from("commercial_followups").select("id", { count: "exact", head: true })
            .eq("invoice_id", r.invoice_id).eq("kind", "reminder").eq("status", "sent");
          const draft = buildDemandDraft({
            businessName: business || "Our team", customerName: r.customer_name, invoiceNumber: r.invoice_number,
            balanceFormatted: balanceLabel, dueDate: r.due_date ? formatDate(r.due_date, language) : null,
            sentDate: r.invoice_sent_at ? formatDate(r.invoice_sent_at, language) : null,
            daysOutstanding: daysBetween(anchor ?? today, today), poReference: r.po_number ?? r.work_order_number ?? null,
            remindersSent: count ?? 0,
          });
          const q = await admin.rpc("commercial_queue_demand_draft", {
            p_invoice_id: r.invoice_id, p_body: draft.body, p_disclaimer: draft.disclaimer,
            p_facts: { balance_cents: r.balance_cents, days_outstanding: daysBetween(anchor ?? today, today), step_day: action.stepDay },
          });
          if (q.error) throw q.error;
          await admin.rpc("commercial_sync_recovery_event", {
            p_invoice_id: r.invoice_id, p_source_type: "invoice_overdue",
            p_note: `Commercial invoice ${r.invoice_number}: demand-letter DRAFT queued for human review (not sent).`,
          });
          await admin.rpc("commercial_complete_followup", { p_invoice_id: r.invoice_id, p_step_day: action.stepDay, p_kind: "demand_draft", p_status: "queued" });
          stats.drafts_queued++;
          continue;
        }

        // ---- reminder via the existing invoice email templates ----
        const contacts = await resolveContactRecipients(admin, r.user_id, r.customer_id, "invoice");
        const recipients = invoiceRecipientEmails(r.customer_email, contacts, (v: string) => EMAIL_RE.test(v));
        if (recipients.length === 0) {
          await admin.rpc("commercial_complete_followup", { p_invoice_id: r.invoice_id, p_step_day: action.stepDay, p_kind: "reminder", p_status: "failed", p_error: "No valid recipient email." });
          stats.reminders_failed++;
          continue;
        }
        const { data: inv } = await admin.from("invoices").select("invoice_token").eq("id", r.invoice_id).eq("user_id", r.user_id).maybeSingle();
        if (!inv) { await admin.rpc("commercial_complete_followup", { p_invoice_id: r.invoice_id, p_step_day: action.stepDay, p_kind: "reminder", p_status: "skipped", p_error: "Invoice not found." }); continue; }
        const link = `${siteUrl}/invoice/${inv.invoice_token}`;
        const L = (k: Parameters<typeof renderTemplate>[0]) => renderTemplate(k, language);
        const biz = business || L("invoice.email.fallbackBusiness");
        const subject = renderTemplate(overdue ? "invoice.email.subject.overdue" : "invoice.email.subject.reminder", language, { number: r.invoice_number, business: biz });
        const dueLine = r.due_date ? renderTemplate("invoice.email.due", language, { date: formatDate(r.due_date, language) }) : "";
        const greeting = renderTemplate("invoice.email.greeting", language, { name: r.customer_name });
        const poLine = r.po_number || r.work_order_number ? `PO / WO: ${r.po_number ?? r.work_order_number}` : "";
        const text = `${greeting}\n\n${L("invoice.email.lead.reminder")}\n\n${L("invoice.email.label.invoice")} ${r.invoice_number}\n${poLine ? poLine + "\n" : ""}${L("invoice.email.label.balance")}: ${balanceLabel}\n${dueLine}\n\n${L("invoice.email.viewHere")} ${link}\n\n${L("invoice.email.signoff")}\n${biz}`;
        const html = `<div ${htmlLangAttrs(language)} style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#171717">
<p>${escapeHtml(greeting)}</p><p>${escapeHtml(L("invoice.email.lead.reminder"))}</p>
<p><strong>${escapeHtml(L("invoice.email.label.invoice"))} ${escapeHtml(r.invoice_number)}</strong>${poLine ? `<br/>${escapeHtml(poLine)}` : ""}<br/>${escapeHtml(L("invoice.email.label.balance"))}: ${escapeHtml(balanceLabel)}${dueLine ? `<br/>${escapeHtml(dueLine)}` : ""}</p>
<p><a href="${escapeHtml(link)}" style="background:#203ad8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">${escapeHtml(L("invoice.email.cta"))}</a></p>
<p style="color:#6e6e78;font-size:13px">${escapeHtml(L("invoice.email.signoff"))}<br/>${escapeHtml(biz)}</p></div>`;

        let anyOk = false; let lastError = "";
        for (const to of recipients) {
          const res = await sendEmail(to, subject, html, text);
          anyOk = anyOk || res.ok;
          if (!res.ok) lastError = res.error ?? "Unknown error";
          await admin.from("invoice_reminders").insert({
            user_id: r.user_id, invoice_id: r.invoice_id, kind: "reminder", channel: "email", recipient: to,
            status: res.ok ? "sent" : "failed", error: res.ok ? null : lastError.slice(0, 500), sent_by: null, sent_by_email: "commercial-collections-cron",
          });
        }
        await admin.from("audit_log").insert({
          user_id: r.user_id, actor_id: null, actor_email: "commercial-collections-cron", action: "commercial_ladder_reminder",
          target_table: "invoices", target_id: r.invoice_id, details: { step_day: action.stepDay, recipients: recipients.length, ok: anyOk },
        });
        await admin.rpc("commercial_complete_followup", {
          p_invoice_id: r.invoice_id, p_step_day: action.stepDay, p_kind: "reminder", p_status: anyOk ? "sent" : "failed",
          p_error: anyOk ? null : lastError, p_details: { recipients: recipients.length },
        });
        if (anyOk) stats.reminders_sent++; else stats.reminders_failed++;
      } catch (err) {
        stats.errors++;
        console.error(JSON.stringify({ event: "commercial_collections_item_failed", invoice_id: r.invoice_id, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    return json({ ok: true, ...stats });
  } catch (err) {
    console.error(JSON.stringify({ event: "commercial_collections_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Collections run failed.", ...stats }, 500);
  }
});
