// Sends (or re-sends / reminds about) an invoice by email and records it in
// `invoice_reminders` + `audit_log`.
//
//   POST { invoice_id, kind: 'initial' | 'resend' | 'reminder' }
//
// Security: the caller's JWT is verified, the account owner is resolved
// server-side, the invoice is looked up scoped to that owner, and the caller
// must hold `can_view_billing` (owners always do). All writes use the service
// role because clients have no INSERT policy on invoice_reminders/audit_log.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { resolveCustomerLanguage } from "../_shared/i18n/customerLanguage.ts";
import { formatDate, formatMoney, htmlLangAttrs, renderTemplate, textAlignStart } from "../_shared/i18n/templates.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

function totalCents(items: Array<{ quantity: number; unit_price_cents: number }>, tax: number): number {
  const sub = (items ?? []).reduce((s, li) => s + (Number(li.quantity) || 0) * (Number(li.unit_price_cents) || 0), 0);
  return sub + Math.round((sub * (Number(tax) || 0)) / 100);
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// deno-lint-ignore no-explicit-any
async function resolveCaller(admin: any, user: { id: string; email?: string | null }) {
  const { data: profile } = await admin.from("profiles").select("id, role, company_name").eq("id", user.id).maybeSingle();
  if (profile?.role === "owner") return { ownerId: profile.id as string, canBill: true, companyName: profile.company_name as string | null };

  const { data: member } = await admin
    .from("team_members")
    .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
    .eq("member_email", user.email ?? "")
    .maybeSingle();
  if (!member) return { ownerId: profile?.id ?? user.id, canBill: Boolean(profile), companyName: profile?.company_name ?? null };

  const custom = member.custom_role?.permissions?.can_view_billing;
  const canBill = custom !== undefined ? Boolean(custom) : Boolean(member.permissions?.can_view_billing);
  const { data: owner } = await admin.from("profiles").select("company_name").eq("id", member.account_owner_id).maybeSingle();
  return { ownerId: member.account_owner_id as string, canBill, companyName: (owner?.company_name as string | null) ?? null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const caller = userData.user;

    const body = await req.json().catch(() => ({}));
    const invoiceId = typeof body.invoice_id === "string" ? body.invoice_id : "";
    const kind = body.kind as string;
    if (!invoiceId) return json({ error: "invoice_id is required." }, 400);
    if (!["initial", "resend", "reminder"].includes(kind)) return json({ error: "Invalid kind." }, 400);

    const { ownerId, canBill, companyName } = await resolveCaller(admin, caller);
    if (!canBill) return json({ error: "You don't have permission to send invoices." }, 403);

    const { data: invoice } = await admin
      .from("invoices")
      .select("id, user_id, customer_id, customer_phone, invoice_number, customer_name, customer_email, line_items, tax_percent, status, due_date, invoice_token, sent_at")
      .eq("id", invoiceId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!invoice) return json({ error: "Invoice not found." }, 404);
    if (invoice.status === "void") return json({ error: "This invoice is void." }, 400);
    if (invoice.status === "paid" && kind === "reminder") return json({ error: "This invoice is already paid." }, 400);

    const to = (invoice.customer_email ?? "").trim();
    if (!EMAIL_RE.test(to)) return json({ error: "Add a valid customer email to this invoice first." }, 400);

    if (kind === "reminder") {
      const { data: last } = await admin
        .from("invoice_reminders")
        .select("created_at")
        .eq("invoice_id", invoice.id)
        .eq("status", "sent")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (last && Date.now() - new Date(last.created_at).getTime() < REMINDER_COOLDOWN_MS) {
        return json({ error: "A reminder was already sent in the last 12 hours.", code: "COOLDOWN", retry_after: last.created_at }, 429);
      }
    }

    // Balance due (net of payments and refunds).
    const [{ data: pays }, { data: refs }] = await Promise.all([
      admin.from("invoice_payments").select("amount_cents").eq("invoice_id", invoice.id),
      admin.from("invoice_refunds").select("amount_cents").eq("invoice_id", invoice.id),
    ]);
    const total = totalCents(invoice.line_items, invoice.tax_percent);
    const net = (pays ?? []).reduce((s: number, p: { amount_cents: number }) => s + Number(p.amount_cents), 0) -
      (refs ?? []).reduce((s: number, r: { amount_cents: number }) => s + Number(r.amount_cents), 0);
    const balance = Math.max(0, total - net);

    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    const link = `${siteUrl}/invoice/${invoice.invoice_token}`;
const language = await resolveCustomerLanguage(admin, ownerId, { customerId: invoice.customer_id, phone: invoice.customer_phone, email: to });
    const L = (key: Parameters<typeof renderTemplate>[0]) => renderTemplate(key, language);
    const business = companyName || L("invoice.email.fallbackBusiness");
    const overdue = invoice.due_date && new Date(invoice.due_date) < new Date(new Date().toDateString());
    const subject = renderTemplate(
      kind === "reminder" ? (overdue ? "invoice.email.subject.overdue" : "invoice.email.subject.reminder") : "invoice.email.subject.initial",
      language,
      { number: invoice.invoice_number, business },
    );
    const dueLine = invoice.due_date ? renderTemplate("invoice.email.due", language, { date: formatDate(invoice.due_date, language) }) : "";
    const lead = L(kind === "reminder" ? "invoice.email.lead.reminder" : "invoice.email.lead.initial");
    const greeting = renderTemplate("invoice.email.greeting", language, { name: invoice.customer_name });
    const balanceLabel = formatMoney(balance / 100, language);

    const text = `${greeting}\n\n${lead}\n\n${L("invoice.email.label.invoice")} ${invoice.invoice_number}\n${L("invoice.email.label.balance")}: ${balanceLabel}\n${dueLine}\n\n${L("invoice.email.viewHere")} ${link}\n\n${L("invoice.email.signoff")}\n${business}`;
    const html = `<div ${htmlLangAttrs(language)} style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#171717;text-align:${textAlignStart(language)}">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(lead)}</p>
<table style="width:100%;border:1px solid #e1e1e8;border-radius:12px;padding:16px;border-collapse:separate">
<tr><td style="color:#6e6e78;font-size:13px">${escapeHtml(L("invoice.email.label.invoice"))}</td><td style="text-align:${language === "ar" || language === "fa" ? "left" : "right"};font-weight:600">${escapeHtml(invoice.invoice_number)}</td></tr>
<tr><td style="color:#6e6e78;font-size:13px">${escapeHtml(L("invoice.email.label.balance"))}</td><td style="text-align:${language === "ar" || language === "fa" ? "left" : "right"};font-weight:600">${escapeHtml(balanceLabel)}</td></tr>
${dueLine ? `<tr><td colspan="2" style="color:#6e6e78;font-size:13px;padding-top:8px">${escapeHtml(dueLine)}</td></tr>` : ""}
</table>
<p style="margin:24px 0"><a href="${link}" style="background:#203ad8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">${escapeHtml(L("invoice.email.cta"))}</a></p>
<p style="color:#6e6e78;font-size:13px">${escapeHtml(L("invoice.email.signoff"))}<br/>${escapeHtml(business)}</p></div>`;
    const result = await sendEmail(to, subject, html, text);

    await admin.from("invoice_reminders").insert({
      user_id: ownerId,
      invoice_id: invoice.id,
      kind,
      channel: "email",
      recipient: to,
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : (result.error ?? "Unknown error").slice(0, 500),
      sent_by: caller.id,
      sent_by_email: caller.email ?? null,
    });

    if (!result.ok) return json({ error: "Could not send the email.", detail: result.error }, 422);

    // First successful send moves a draft to "sent".
    if (invoice.status === "draft") {
      await admin.from("invoices").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", invoice.id).eq("user_id", ownerId);
    }

    await admin.from("audit_log").insert({
      user_id: ownerId,
      actor_id: caller.id,
      actor_email: caller.email ?? null,
      action: kind === "reminder" ? "invoice_reminder_sent" : kind === "resend" ? "invoice_resent" : "invoice_sent",
      target_table: "invoices",
      target_id: invoice.id,
      details: { recipient: to, kind },
    });

    return json({ ok: true, recipient: to });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error." }, 500);
  }
});
