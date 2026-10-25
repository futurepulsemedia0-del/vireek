// supabase/functions/analytics-embed/index.ts
//
// PUBLIC, token-authenticated analytics for partners (no Supabase JWT). The page that renders it is
// the static public/embed/analytics.html; partners may also call this API from their own backend.
//
//   GET  ?action=meta            -> embed title, theme, metrics (label, unit), allowed breakdowns, default range
//   POST {action:"data", from?, to?, metrics?, granularity?, groupBy?, compare?}  -> metric results
//
// Auth: Authorization: Bearer <signed embed token>  (see _shared/data-platform/embed.ts and
// docs/DATA_PLATFORM.md for how the partner's server mints it). Every failure returns the same
// generic 401 so a caller can't tell a wrong signature from a revoked embed.
//
// Deploy: supabase functions deploy analytics-embed --no-verify-jwt

import { adminClient, aad, corsHeaders, encryptionKey, json } from "../_shared/data-platform/http.ts";
import { openSecret } from "../_shared/data-platform/secrets.ts";
import { peekEmbedId, resolveEmbedQuery, sanitizeEmbedConfig, verifyEmbedToken } from "../_shared/data-platform/embed.ts";
import { computeMetrics, METRICS } from "../_shared/data-platform/metrics.ts";
import { loadMetricData } from "../_shared/data-platform/loader.ts";

const deny = () => json({ error: "This embed link is invalid or has expired." }, 401);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const url = new URL(req.url);
    const header = req.headers.get("Authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const eid = token ? peekEmbedId(token) : null;
    if (!eid) return deny();

    const admin = adminClient();
    const { data: embed } = await admin.from("dp_embeds").select("id,user_id,config,status,rate_limit_per_minute,last_used_at").eq("id", eid).maybeSingle();
    if (!embed || embed.status !== "active") return deny();
    const { data: sec } = await admin.from("dp_secrets").select("secret_enc").eq("ref_id", eid).eq("kind", "embed").maybeSingle();
    if (!sec) return deny();
    const secret = await openSecret(sec.secret_enc as string, encryptionKey(), aad("embed", eid));
    const check = await verifyEmbedToken(secret, token, Math.floor(Date.now() / 1000));
    if (!check.ok) { console.warn(`[analytics-embed] ${eid} rejected: ${check.reason}`); return deny(); }

    const { data: ok } = await admin.rpc("dp_embed_rate_ok", { p_embed_id: eid, p_limit: embed.rate_limit_per_minute });
    if (ok === false) return json({ error: "Too many requests. Please retry shortly." }, 429, { "Retry-After": "30" });

    const cfg = sanitizeEmbedConfig(embed.config);
    if (!cfg.ok) return json({ error: "This embed is not configured correctly." }, 409);
    const config = cfg.config;

    const lastUsed = embed.last_used_at ? Date.parse(embed.last_used_at as string) : 0;
    if (Date.now() - lastUsed > 300_000) admin.from("dp_embeds").update({ last_used_at: new Date().toISOString() }).eq("id", eid).then(() => {});

    const action = url.searchParams.get("action") ?? "data";
    if (action === "meta") {
      return json({
        title: config.title,
        theme: config.theme,
        granularity: config.granularity,
        default_range_days: config.default_range_days,
        max_range_days: config.max_range_days,
        allowed_group_by: config.allowed_group_by,
        metrics: config.metrics.map((id) => ({ id, label: METRICS[id].label, unit: METRICS[id].unit, better: METRICS[id].better, description: METRICS[id].description })),
      }, 200, { "Cache-Control": "private, max-age=60" });
    }

    let request: Record<string, unknown> = {};
    if (req.method === "POST") { try { request = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); } }
    const resolved = resolveEmbedQuery(config, check.payload, request, new Date());
    if (!resolved.ok) return json({ error: resolved.error }, 400);
    const q = resolved.query;
    const span = Date.parse(q.to) - Date.parse(q.from);
    const { data, truncated } = await loadMetricData(admin, embed.user_id as string, new Date(Date.parse(q.from) - (q.compare ? span : 0) - 86_400_000).toISOString());
    return json({ ...computeMetrics(data, q), truncated, generated_at: new Date().toISOString() }, 200, { "Cache-Control": "private, max-age=30" });
  } catch (err) {
    console.error("[analytics-embed]", err instanceof Error ? err.message : err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
