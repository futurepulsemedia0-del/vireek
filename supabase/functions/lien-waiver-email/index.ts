import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";

// Emails a lien-waiver signing link (kind = "request") or the signed copy (kind = "copy").
// Runs AS THE CALLER (their JWT), so RLS decides which waivers they can read — no service role needed.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(authHeader)) return json({ error: "Missing Authorization header." }, 401);

    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const body = await req.json().catch(() => ({}));
    const waiverId = typeof body.waiver_id === "string" ? body.waiver_id : "";
    const kind = body.kind === "copy" ? "copy" : "request";
    if (!waiverId) return json({ error: "waiver_id is required." }, 400);

    const { data: w, error } = await supabase
      .from("lien_waivers")
      .select("id, user_id, waiver_number, title, status, sign_token, claimant_name, claimant_email, amount_cents, expires_at, signer_name")
      .eq("id", waiverId)
      .maybeSingle();
    if (error || !w) return json({ error: "Waiver not found." }, 404);

    if (kind === "request" && w.status !== "sent") return json({ error: "Send the waiver for signature first." }, 400);
    if (kind === "copy" && w.status !== "signed") return json({ error: "Only signed waivers can be emailed as a copy." }, 400);

    const to = (typeof body.to === "string" && body.to.trim()) || w.claimant_email || "";
    if (!EMAIL_RE.test(to) || to.length > 254) return json({ error: "Enter a valid email address." }, 400);

    const { data: profile } = await supabase.from("profiles").select("company_name").eq("id", w.user_id).maybeSingle();
    const business = profile?.company_name || "Your contractor";
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
    const url = `${siteUrl}/lien-waiver/${w.sign_token}`;
    const title = w.title || "Lien waiver";
    const amount = `$${(Number(w.amount_cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const subject = kind === "request"
      ? `${business} sent you a lien waiver to sign (${w.waiver_number})`
      : `Signed lien waiver ${w.waiver_number} from ${business}`;
    const headline = kind === "request" ? `${esc(business)} asked you to sign a lien waiver` : `Your signed lien waiver copy`;
    const cta = kind === "request" ? "Review &amp; sign" : "View signed copy";
    const footer = kind === "request" && w.expires_at
      ? `This link is unique to you — please don't forward it. It expires ${new Date(w.expires_at).toLocaleDateString("en-US")}.`
      : "Keep this link for your records.";

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1a1a1a;">
      <p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:0 0 16px;">Lien waiver ${esc(w.waiver_number ?? "")}</p>
      <h1 style="font-size:22px;margin:0 0 12px;">${headline}</h1>
      <p style="font-size:14px;color:#4b5563;margin:0 0 4px;">${esc(title)}</p>
      <p style="font-size:14px;color:#4b5563;margin:0 0 20px;">${esc(w.claimant_name)} · ${amount}</p>
      <a href="${url}" style="display:inline-block;padding:12px 24px;background:#111827;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px;">${cta}</a>
      <p style="margin-top:24px;font-size:12px;color:#9ca3af;">${esc(footer)}</p>
    </div>`;
    const text = `${business} — ${title} (${w.waiver_number}), ${amount}: ${url}`;

    const res = await sendEmail(to, subject, html, text);
    if (!res.ok) return json({ error: res.error || "Email could not be sent." }, 502);

    await supabase.rpc("log_lien_waiver_email", { p_id: w.id, p_recipient: to, p_kind: kind });
    return json({ ok: true });
  } catch (err) {
    console.error("lien-waiver-email error:", err);
    return json({ error: err instanceof Error ? err.message : "Unexpected error." }, 500);
  }
});
