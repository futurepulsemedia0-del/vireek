// punchout-return — PUBLIC endpoint the supplier's website posts the shopping cart to
// (cXML PunchOutOrderMessage, form field "cxml-urlencoded" or "cxml-base64").
// The user's browser performs the POST, so there is no Authorization header: the one-time
// BuyerCookie we issued is the credential (256-bit random, hash-only in the DB, single use, 4 h expiry).
// The function stores the cart as a STAGING copy and 303-redirects the browser back into Vireek.
// It never creates an order by itself.
//
// Deploy:  supabase functions deploy punchout-return --no-verify-jwt
// Secrets: SITE_URL (default https://app.vireek.com)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { CxmlError, parseOrderMessage } from "../_shared/punchout/cxml.ts";
import { sha256Hex } from "../_shared/punchout/security.ts";

const MAX_BODY_BYTES = 1_000_000;

function back(site: string, params: Record<string, string>): Response {
  const u = new URL("/dashboard/supplier-punchout", site);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  // 303 turns the supplier's POST into a plain GET in the user's browser.
  return new Response(null, { status: 303, headers: { Location: u.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

const textResponse = (msg: string, status: number) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return textResponse("Method not allowed", 405);
  const site = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return textResponse("Server not configured", 500);

  try {
    const declared = Number(req.headers.get("content-length") || 0);
    if (declared > MAX_BODY_BYTES) return back(site, { error: "too_large" });

    let xml = "";
    const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
    if (ctype.includes("application/x-www-form-urlencoded") || ctype.includes("multipart/form-data")) {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return back(site, { error: "too_large" });
      const form = new URLSearchParams(raw);
      const b64 = form.get("cxml-base64");
      xml = form.get("cxml-urlencoded") ?? (b64 ? atob(b64.replace(/\s+/g, "")) : "");
    } else {
      xml = await req.text();
    }
    if (!xml || xml.length > MAX_BODY_BYTES) return back(site, { error: "invalid_cart" });

    let msg;
    try {
      msg = parseOrderMessage(xml);
    } catch (e) {
      return back(site, { error: e instanceof CxmlError ? "invalid_cart" : "invalid_cart" });
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: sessionId, error } = await admin.rpc("punchout_receive_cart", {
      p_cookie_hash: await sha256Hex(msg.buyerCookie),
      p_lines: msg.lines,
      p_total_cents: msg.totalCents,
      p_currency: msg.currency,
      p_payload_hash: await sha256Hex(JSON.stringify(msg.lines) + "|" + msg.currency),
    });
    if (error) return back(site, { error: /Currency/i.test(error.message) ? "currency_mismatch" : "invalid_cart" });
    if (!sessionId) return back(site, { error: "session_expired" });
    return back(site, { session: sessionId as string });
  } catch (_e) {
    return back(site, { error: "failed" });
  }
});
