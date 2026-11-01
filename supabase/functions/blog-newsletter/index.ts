// supabase/functions/blog-newsletter/index.ts
//
// Double opt-in newsletter for the blog. POST JSON { action: 'subscribe' | 'confirm' | 'unsubscribe', ... }
//
//   subscribe   { email, consent: true, consentVersion, source?, website? }  -> stores a PENDING row, emails a confirm link
//   confirm     { token }                                                      -> pending -> confirmed (token valid 48 h)
//   unsubscribe { token }                                                      -> confirmed/pending -> unsubscribed
//
// Security: service role only (tables have RLS on and no policies); confirm tokens are random 256-bit
// values stored as SHA-256 hashes; `subscribe` always answers the same way for new / existing /
// already-confirmed addresses (no email enumeration); honeypot + hourly rate limits per IP and per email.
//
// Secrets (same Resend setup as notify-status-subscribers):
//   supabase secrets set RESEND_API_KEY=re_xxx
//   supabase secrets set RESEND_FROM_EMAIL="Vireek <blog@yourdomain.com>"
//   supabase secrets set SITE_URL=https://vireek.com        (optional, defaults to https://vireek.com)
//
// Deploy: supabase functions deploy blog-newsletter

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const CONSENT_TEXTS: Record<string, string> = {
  v1: "Yes, email me new Vireek articles and playbooks. I can unsubscribe at any time. See the Privacy Policy.",
};
const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const fail = (message: string, status: number) => json({ success: false, message }, status);

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function sendConfirmationEmail(to: string, confirmUrl: string, unsubscribeUrl: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) {
    console.error("RESEND_API_KEY is not set");
    return false;
  }
  const from = Deno.env.get("RESEND_FROM_EMAIL") || "Vireek <blog@resend.dev>";
  const html = `<p>Thanks for your interest in Vireek articles and playbooks.</p>
<p><a href="${esc(confirmUrl)}">Confirm your subscription</a></p>
<p>This link expires in 48 hours. If you did not ask for this, ignore this email or <a href="${esc(unsubscribeUrl)}">opt out here</a>. You will not be subscribed unless you confirm.</p>`;
  const text = `Thanks for your interest in Vireek articles and playbooks.\n\nConfirm your subscription: ${confirmUrl}\n\nThis link expires in 48 hours. If you did not ask for this, ignore this email or opt out: ${unsubscribeUrl}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: "Confirm your Vireek subscription", html, text }),
  });
  if (!res.ok) console.error("Resend error:", res.status, await res.text());
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return fail("Method not allowed", 405);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid request.", 400);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return fail("Server configuration error.", 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const action = body.action;

  /* ------------------------------- subscribe ------------------------------- */
  if (action === "subscribe") {
    // Honeypot: bots fill the hidden field. Pretend success, do nothing.
    if (typeof body.website === "string" && body.website.trim() !== "") return json({ success: true });

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return fail("Please enter a valid email address.", 400);
    const version = typeof body.consentVersion === "string" ? body.consentVersion : "";
    if (body.consent !== true || !CONSENT_TEXTS[version]) return fail("Please confirm that you want to receive our emails.", 400);
    const source = typeof body.source === "string" ? body.source.slice(0, 80) : null;

    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    const [ipKey, emailKey] = await Promise.all([sha256(`ip:${ip}`), sha256(`email:${email}`)]);
    for (const [key, limit] of [[ipKey, 8], [emailKey, 3]] as const) {
      const { data: allowed, error } = await admin.rpc("consume_blog_newsletter_rate_limit", { p_key: key, p_limit: limit });
      if (error) {
        console.error("rate limit error:", error);
        return fail("Something went wrong. Please try again in a moment.", 500);
      }
      if (!allowed) return fail("Too many attempts. Please try again in about an hour.", 429);
    }

    const { data: existing, error: selErr } = await admin
      .from("blog_subscribers")
      .select("id, status, unsubscribe_token, last_confirmation_sent_at")
      .eq("email", email)
      .maybeSingle();
    if (selErr) {
      console.error(selErr);
      return fail("Something went wrong. Please try again in a moment.", 500);
    }
    // Already confirmed: identical response, no email (prevents enumeration and mail-bombing).
    if (existing?.status === "confirmed") return json({ success: true });
    if (existing?.last_confirmation_sent_at && Date.now() - new Date(existing.last_confirmation_sent_at).getTime() < RESEND_COOLDOWN_MS) {
      return json({ success: true });
    }

    const token = randomToken();
    const fields = {
      status: "pending",
      confirm_token_hash: await sha256(token),
      confirm_expires_at: new Date(Date.now() + CONFIRM_TTL_MS).toISOString(),
      consent_text: CONSENT_TEXTS[version],
      consent_version: version,
      consent_at: new Date().toISOString(),
      source,
      unsubscribed_at: null,
      updated_at: new Date().toISOString(),
    };
    let unsubscribeToken: string;
    if (existing) {
      const { error } = await admin.from("blog_subscribers").update(fields).eq("id", existing.id);
      if (error) {
        console.error(error);
        return fail("Something went wrong. Please try again in a moment.", 500);
      }
      unsubscribeToken = existing.unsubscribe_token;
    } else {
      const { data, error } = await admin.from("blog_subscribers").insert({ email, ...fields }).select("unsubscribe_token").single();
      if (error || !data) {
        console.error(error);
        return fail("Something went wrong. Please try again in a moment.", 500);
      }
      unsubscribeToken = data.unsubscribe_token;
    }

    const sent = await sendConfirmationEmail(
      email,
      `${siteUrl}/newsletter/confirm?token=${encodeURIComponent(token)}`,
      `${siteUrl}/newsletter/unsubscribe?token=${unsubscribeToken}`,
    );
    if (!sent) return fail("We could not send the confirmation email. Please try again later.", 502);
    await admin.from("blog_subscribers").update({ last_confirmation_sent_at: new Date().toISOString() }).eq("email", email);
    return json({ success: true });
  }

  /* -------------------------------- confirm -------------------------------- */
  if (action === "confirm") {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 200) return fail("This confirmation link is invalid or has expired.", 400);
    const hash = await sha256(token);
    const { data, error } = await admin
      .from("blog_subscribers")
      .select("id, status, confirm_expires_at")
      .eq("confirm_token_hash", hash)
      .maybeSingle();
    if (error) {
      console.error(error);
      return fail("Something went wrong. Please try again in a moment.", 500);
    }
    if (!data || data.status !== "pending" || !data.confirm_expires_at || new Date(data.confirm_expires_at).getTime() < Date.now()) {
      return fail("This confirmation link is invalid or has expired. Please subscribe again.", 400);
    }
    const { error: upErr } = await admin
      .from("blog_subscribers")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString(), confirm_token_hash: null, confirm_expires_at: null, updated_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("status", "pending"); // guards against double-click races
    if (upErr) {
      console.error(upErr);
      return fail("Something went wrong. Please try again in a moment.", 500);
    }
    return json({ success: true });
  }

  /* ------------------------------ unsubscribe ------------------------------ */
  if (action === "unsubscribe") {
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!UUID_RE.test(token)) return fail("This unsubscribe link is invalid.", 400);
    const { error } = await admin
      .from("blog_subscribers")
      .update({ status: "unsubscribed", unsubscribed_at: new Date().toISOString(), confirm_token_hash: null, confirm_expires_at: null, updated_at: new Date().toISOString() })
      .eq("unsubscribe_token", token)
      .neq("status", "unsubscribed");
    if (error) {
      console.error(error);
      return fail("Something went wrong. Please try again in a moment.", 500);
    }
    return json({ success: true }); // same answer for unknown / already-unsubscribed tokens
  }

  return fail("Unknown action.", 400);
});
