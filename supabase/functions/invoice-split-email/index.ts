// Emails a payer their private pay link for one share of a split invoice.
//
//   POST { payer_id }
//
// Security: the caller's JWT is verified, the account owner is resolved
// server-side, the payer is looked up scoped to that owner, and the caller
// must hold `can_view_billing` (owners always do). Writes use the service role.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const COOLDOWN_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// deno-lint-ignore no-explicit-any
async function resolveCaller(admin: any, user: { id: string; email?: string | null }) {
  const { data: profile } = await admin.from("profiles").select("id, role").eq("id", user.id).maybeSingle();
  if (profile?.role === "owner") return { ownerId: profile.id as string, canBill: true };

  const { data: member } = await admin
    .from("team_members")
    .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
    .eq("member_email", user.email ?? "")
    .maybeSingle();
  if (!member) return { ownerId: (profile?.id ?? user.id) as string, canBill: Boolean(profile) };

  const custom = member.custom_role?.permissions?.can_view_billing;
  const canBill = custom !== undefined ? Boolean(custom) : Boolean(member.permissions?.can_view_billing);
  return { ownerId: member.account_owner_id as string, canBill };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return json({ error: "Invalid or expired session." }, 401);
    const caller = userData.user;

    const body = await req.json().catch(() => ({}));
    const payerId = typeof body.payer_id === "string" ? body.payer_id : "";
    if (!UUID_RE.test(payerId)) return json({ error: "payer_id is required." }, 400);

    const { ownerId, canBill } = await resolveCaller(admin, caller);
    if (!canBill) return json({ error: "You don't have permission to send payment links." }, 403);

    const { data: payer } = await admin
      .from("invoice_split_payers")
      .select("id, user_id, invoice_id, name, email, public_token, link_sent_at")
      .eq("id", payerId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!payer) return json({ error: "Payer not found." }, 404);

    const to = (payer.email ?? "").trim();
    if (!EMAIL_RE.test(to)) return json({ error: "Add a valid email for this payer first." }, 400);

    if (payer.link_sent_at && Date.now() - new Date(payer.link_sent_at).getTime() < COOLDOWN_MS) {
      return json({ error: "A link was just sent to this payer. Please wait a few minutes before sending it again.", code: "COOLDOWN" }, 429);
    }

    // Amounts and eligibility come from the same function the public page uses.
    const { data: summary, error: summaryError } = await admin.rpc("split_payer_summary", { p_token: payer.public_token });
    if (summaryError) throw summaryError;
    const s = summary as Record<string, unknown> | null;
    if (!s || s.status === "not_found") return json({ error: "Payer not found." }, 404);
    if (s.status === "paid") return json({ error: "This payer has nothing left to pay." }, 400);
    if (s.status === "blocked") {
      const reason = s.reason === "not_ready" ? "Send the invoice first, then send payment links."
        : s.reason === "changed" ? "The invoice total changed. Update the split before sending links."
        : "This invoice is void.";
      return json({ error: reason }, 400);
    }

    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    const link = `${siteUrl}/pay-share/${payer.public_token}`;
    const business = (s.business_name as string | null)?.trim() || "your service provider";
    const invoiceNumber = String(s.invoice_number);
    const payable = money(Number(s.payable_cents));
    const dueLine = s.due_date ? `Due ${new Date(`${s.due_date}T00:00:00`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}` : "";

    const subject = `Your share of invoice ${invoiceNumber} from ${business}`;
    const greeting = `Hi ${payer.name},`;
    const lead = `${business} has asked you to pay your share of invoice ${invoiceNumber}. You can pay securely online using the link below.`;
    const text = `${greeting}\n\n${lead}\n\nAmount due: ${payable}\n${dueLine ? `${dueLine}\n` : ""}\nPay here: ${link}\n\nThank you,\n${business}`;
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#171717">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(lead)}</p>
<table style="width:100%;border:1px solid #e1e1e8;border-radius:12px;padding:16px;border-collapse:separate">
<tr><td style="color:#6e6e78;font-size:13px">Invoice</td><td style="text-align:right;font-weight:600">${escapeHtml(invoiceNumber)}</td></tr>
<tr><td style="color:#6e6e78;font-size:13px">Your share due</td><td style="text-align:right;font-weight:600">${escapeHtml(payable)}</td></tr>
${dueLine ? `<tr><td colspan="2" style="color:#6e6e78;font-size:13px;padding-top:8px">${escapeHtml(dueLine)}</td></tr>` : ""}
</table>
<p style="margin:24px 0"><a href="${link}" style="background:#203ad8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">Pay your share</a></p>
<p style="color:#6e6e78;font-size:13px">This link is private to you. Thank you,<br/>${escapeHtml(business)}</p></div>`;

    const result = await sendEmail(to, subject, html, text);
    if (!result.ok) return json({ error: "Could not send the email.", detail: result.error }, 422);

    await admin.from("invoice_split_payers").update({ link_sent_at: new Date().toISOString() }).eq("id", payer.id).eq("user_id", ownerId);
    await admin.from("audit_log").insert({
      user_id: ownerId,
      actor_id: caller.id,
      actor_email: caller.email ?? null,
      action: "invoice_split_link_sent",
      target_table: "invoices",
      target_id: payer.invoice_id,
      details: { payer_id: payer.id, payer: payer.name, recipient: to },
    });

    return json({ ok: true, recipient: to });
  } catch (err) {
    console.error(JSON.stringify({ event: "invoice_split_email_failed", error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Unexpected error." }, 500);
  }
});
