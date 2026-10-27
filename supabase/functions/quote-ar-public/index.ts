// Public (no-auth) endpoint behind the customer quote link /quote/:token.
// Matches ONLY on the unguessable quotes.quote_token. Never returns storage
// paths, account ids or contact details - only short-lived signed URLs.
//
//   { action: "list", token }                                        -> AR previews + signed URLs
//   { action: "event", token, preview_id, event, platform? }         -> engagement tracking
//
// Engagement rules + throttling live in SQL (record_quote_ar_event).
//
// Deploy with JWT verification OFF (public link) - also set in supabase/config.toml:
//   supabase functions deploy quote-ar-public --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { QUOTE_AR_BUCKET, SIGNED_URL_TTL_SECONDS, isUuid, parseEventBody } from "../_shared/quote-ar/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Stable SQL error codes (RAISE EXCEPTION 'CODE') -> HTTP.
const SQL_ERRORS: Array<{ match: string; status: number; error: string }> = [
  { match: "NOT_FOUND", status: 404, error: "NOT_FOUND" },
  { match: "INVALID_EVENT", status: 422, error: "INVALID_EVENT" },
];

interface ArRow {
  preview_id: string;
  option_id: string | null;
  name: string;
  brand: string | null;
  model_number: string | null;
  category: string;
  placement: string;
  width_mm: number;
  depth_mm: number;
  height_mm: number;
  clearance_mm: number;
  glb_path: string;
  usdz_path: string | null;
  quote_status: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const token = body?.token;
  if (!isUuid(token)) return json({ error: "NOT_FOUND" }, 404);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    // ---- event ----
    if (body?.action === "event") {
      const parsed = parseEventBody(body);
      if (!parsed.ok) return json({ error: parsed.error }, parsed.error === "NOT_FOUND" ? 404 : 422);
      const { data, error } = await admin.rpc("record_quote_ar_event", {
        p_token: token,
        p_preview_id: parsed.previewId,
        p_event: parsed.event,
        p_platform: parsed.platform,
      });
      if (error) {
        const mapped = SQL_ERRORS.find((e) => error.message?.includes(e.match));
        if (mapped) return json({ error: mapped.error }, mapped.status);
        throw error;
      }
      return json({ result: data });
    }

    // ---- default: list ----
    const { data: rows, error: listError } = await admin.rpc("get_quote_ar_for_token", { p_token: token });
    if (listError) throw listError;
    const previews = (rows ?? []) as ArRow[];
    if (previews.length === 0) return json({ quote_status: null, previews: [] });

    const paths = previews.flatMap((p) => (p.usdz_path ? [p.glb_path, p.usdz_path] : [p.glb_path]));
    const { data: signed } = await admin.storage.from(QUOTE_AR_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    const urls = new Map<string, string>();
    for (const row of signed ?? []) if (row.signedUrl && row.path) urls.set(row.path, row.signedUrl);

    return json({
      quote_status: previews[0].quote_status,
      previews: previews
        .filter((p) => urls.has(p.glb_path))
        .map((p) => ({
          id: p.preview_id,
          option_id: p.option_id,
          name: p.name,
          brand: p.brand,
          model_number: p.model_number,
          category: p.category,
          placement: p.placement,
          width_mm: p.width_mm,
          depth_mm: p.depth_mm,
          height_mm: p.height_mm,
          clearance_mm: p.clearance_mm,
          glb_url: urls.get(p.glb_path) as string,
          usdz_url: p.usdz_path ? urls.get(p.usdz_path) ?? null : null,
        })),
    });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "quote_ar_public_failed", error: error instanceof Error ? error.message : String(error) }),
    );
    return json({ error: "INTERNAL" }, 500);
  }
});
