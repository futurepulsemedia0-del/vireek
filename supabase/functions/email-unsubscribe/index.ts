// supabase/functions/email-unsubscribe/index.ts
//
// Public unsubscribe endpoint (no JWT).
//   POST ?t=<token>  (RFC 8058 one-click, body "List-Unsubscribe=One-Click") -> unsubscribes
//   POST {token, action:"lookup"}      -> {email_masked, company} for the confirm page
//   POST {token, action:"unsubscribe"} -> unsubscribes (called by /email/unsubscribe/:token)
//   GET  ?t=<token>                    -> 302 to the app's confirm page (scanners that
//                                         GET links can't unsubscribe anyone by accident)
//
// Deploy:  supabase functions deploy email-unsubscribe --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function mask(email: string): string {
  const [local, domain = ""] = email.split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const url = new URL(req.url);
  const site = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  if (req.method === "GET") {
    const t = url.searchParams.get("t") ?? "";
    return new Response(null, { status: 302, headers: { Location: UUID_RE.test(t) ? `${site}/email/unsubscribe/${t}` : site } });
  }
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let token = url.searchParams.get("t") ?? "";
  let action = "unsubscribe"; // the one-click POST carries the token in the query string
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    token = String(body.token ?? token);
    action = String(body.action ?? "unsubscribe");
  }
  if (!UUID_RE.test(token)) return json({ success: false, error: "Invalid link" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    if (action === "lookup") {
      const { data: r } = await admin
        .from("email_campaign_recipients")
        .select("email, unsubscribed_at, user_id")
        .eq("token", token)
        .maybeSingle();
      if (!r) return json({ success: false, error: "This unsubscribe link isn't valid." }, 404);
      const { data: p } = await admin.from("profiles").select("company_name").eq("id", r.user_id).maybeSingle();
      return json({ success: true, email_masked: mask(r.email), company: p?.company_name ?? null, already: !!r.unsubscribed_at });
    }

    const { data: email, error } = await admin.rpc("email_unsubscribe", { p_token: token });
    if (error) throw error;
    if (!email) return json({ success: false, error: "This unsubscribe link isn't valid." }, 404);
    return json({ success: true, email_masked: mask(String(email)) });
  } catch (e) {
    console.error("email-unsubscribe error", e);
    return json({ success: false, error: "Something went wrong. Please try again." }, 500);
  }
});
