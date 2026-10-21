// supabase/functions/supplier-price-feed/index.ts
//
// Lets ONE supplier (or an integration acting for it) push catalog prices and order delivery
// updates into Vireek. Authenticated with a per-supplier key created in Supplier catalog →
// "Supplier API access" (table supplier_feed_keys). Only the SHA-256 hash is stored; a key can only
// touch its own supplier's items and purchase orders.
//
// Routes (POST, JSON):
//   /supplier-price-feed            { "items": [ { sku, name?, unit_cost | unit_cost_cents, ... } ], "dry_run"?: bool }
//                                   scope: prices:write — max 5000 items per call
//   /supplier-price-feed/shipments  { po_number, shipment_status?, expected_at?, carrier?,
//                                     tracking_number?, tracking_url? }
//                                   scope: shipments:write
//
// Deploy:  supabase functions deploy supplier-price-feed --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const RATE_LIMIT_PER_MINUTE = 60;

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json", ...extra } });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;
}

// Database error messages raised on purpose by our RPCs are safe to show; anything else is not.
function safeMessage(message: string | undefined): string {
  const m = message ?? "";
  const known = ["Too many rows", "No rows to import", "items must be an array", "Unknown supplier"];
  return known.find((k) => m.includes(k)) ?? "Request could not be processed";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return json({ error: "Server not configured" }, 500);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const auth = req.headers.get("Authorization") || "";
    const raw = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!raw) return json({ error: "Missing Authorization header. Use: Authorization: Bearer vsf_live_..." }, 401);

    const { data: key } = await admin
      .from("supplier_feed_keys")
      .select("id, user_id, vendor_id, scopes, revoked_at")
      .eq("key_hash", await sha256Hex(raw))
      .maybeSingle();
    if (!key || key.revoked_at) return json({ error: "Invalid or revoked API key" }, 401);

    const { data: allowed } = await admin.rpc("_supplier_feed_touch", { p_key_id: key.id, p_limit: RATE_LIMIT_PER_MINUTE });
    if (allowed === false) {
      return json({ error: `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE} requests/minute per key).` }, 429, { "Retry-After": "60" });
    }

    const declared = Number(req.headers.get("content-length") || 0);
    if (declared > MAX_BODY_BYTES) return json({ error: "Request body too large (max 5 MB)" }, 413);
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "Request body too large (max 5 MB)" }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "Body must be valid JSON" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "Body must be a JSON object" }, 400);

    const route = new URL(req.url).pathname.replace(/^\/supplier-price-feed\/?/, "").split("/")[0] || "";
    const scopes = key.scopes as string[];

    if (route === "") {
      if (!scopes.includes("prices:write")) return json({ error: "This key is missing the required scope: prices:write" }, 403);
      if (!Array.isArray(body.items)) return json({ error: "items must be an array" }, 400);
      const { data, error } = await admin.rpc("_import_supplier_prices", {
        p_owner: key.user_id,
        p_vendor_id: key.vendor_id,
        p_source: "api",
        p_file_name: "api",
        p_items: body.items,
        p_actor: null,
        p_feed_key_id: key.id,
        p_dry_run: body.dry_run === true,
      });
      if (error) return json({ error: safeMessage(error.message) }, 400);
      return json({ data });
    }

    if (route === "shipments") {
      if (!scopes.includes("shipments:write")) return json({ error: "This key is missing the required scope: shipments:write" }, 403);
      const po = str(body.po_number, 60);
      if (!po) return json({ error: "po_number is required" }, 400);
      const eta = str(body.expected_at, 10);
      if (eta && !/^\d{4}-\d{2}-\d{2}$/.test(eta)) return json({ error: "expected_at must be YYYY-MM-DD" }, 400);
      const { data, error } = await admin.rpc("_supplier_feed_shipment", {
        p_key_id: key.id,
        p_po_number: po,
        p_carrier: str(body.carrier, 80),
        p_tracking_number: str(body.tracking_number, 120),
        p_tracking_url: str(body.tracking_url, 500),
        p_shipment_status: str(body.shipment_status, 30),
        p_expected_at: eta,
      });
      if (error) return json({ error: "Request could not be processed" }, 400);
      const res = data as { status: string; reason?: string };
      const code = res.status === "ok" ? 200 : res.status === "not_found" ? 404 : res.status === "forbidden" ? 403 : 422;
      return json(res.status === "ok" ? { data: res } : { error: res.reason ?? "Rejected", status: res.status }, code);
    }

    return json({ error: "Not found. Routes: POST /supplier-price-feed, POST /supplier-price-feed/shipments" }, 404);
  } catch (_err) {
    return json({ error: "Internal error" }, 500);
  }
});
