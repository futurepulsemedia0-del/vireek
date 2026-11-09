// supabase/functions/marketing-track/index.ts
//
// PUBLIC, unauthenticated endpoint. Called from the marketing site (not
// the dashboard) to record attribution touches and referral-link clicks
// before a visitor has signed up. Uses the service-role client because
// there's no logged-in user yet — the same shape as demo-chat/index.ts.
//
// Call from the site once per pageview, e.g.:
//   fetch("https://<project-ref>.functions.supabase.co/marketing-track", {
//     method: "POST",
//     body: JSON.stringify({
//       user_id: "<the Vireek account this site belongs to>",
//       anonymous_id: getOrCreateCookie("vk_aid"),
//       source: params.get("utm_source"), medium: params.get("utm_medium"),
//       campaign: params.get("utm_campaign"), ref_code: params.get("ref"),
//       referrer: document.referrer, landing_page: location.pathname,
//     }),
//   });

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { dbRateLimiter } from "../_shared/http/rateLimit.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_PER_MINUTE = 120;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface TrackPayload {
  user_id: string;
  anonymous_id: string;
  source?: string;
  medium?: string;
  campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  fbc?: string;
  fbp?: string;
  referrer?: string;
  landing_page?: string;
  ref_code?: string; // referral link, e.g. vireek.com/?ref=ABC123
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as TrackPayload;
    if (!body.user_id || !body.anonymous_id) {
      return new Response(JSON.stringify({ ok: false, error: "user_id and anonymous_id are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
    // Public endpoint: اعتبارسنجی tenant، clamp فیلدها، rate limit بر اساس IP.
    if (!UUID_RE.test(body.user_id) || typeof body.anonymous_id !== "string" || body.anonymous_id.length > 128) {
      return new Response(JSON.stringify({ ok: false, error: "invalid user_id or anonymous_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    for (const key of Object.keys(body) as (keyof TrackPayload)[]) {
      const v = body[key];
      if (typeof v === "string") (body as unknown as Record<string, unknown>)[key] = v.slice(0, 500);
      else if (key !== "user_id") delete (body as unknown as Record<string, unknown>)[key];
    }
    const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    try {
      const rl = await dbRateLimiter(admin).hit(`marketing-track:${ip}`, RATE_LIMIT_PER_MINUTE, 60);
      if (!rl.allowed) {
        return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) },
        });
      }
    } catch (rlErr) {
      console.error("marketing-track rate limiter unavailable (failing open):", rlErr);
    }
    const { data: account } = await admin.from("profiles").select("id").eq("id", body.user_id).maybeSingle();
    if (!account) {
      return new Response(JSON.stringify({ ok: false, error: "unknown account" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: existingTouch } = await admin
      .from("marketing_attribution_touches")
      .select("id")
      .eq("user_id", body.user_id).
      .eq("anonymous_id", body.anonymous_id)
      .limit(1)
      .maybeSingle();

    await admin.from("marketing_attribution_touches").insert({
      user_id: body.user_id,
      anonymous_id: body.anonymous_id,
      source: body.source ?? null,
      medium: body.medium ?? null,
      campaign: body.campaign ?? null,
      utm_content: body.utm_content ?? null,
      utm_term: body.utm_term ?? null,
          gclid: body.gclid?.slice(0, 300) ?? null,
      gbraid: body.gbraid?.slice(0, 300) ?? null,
      wbraid: body.wbraid?.slice(0, 300) ?? null,
      fbclid: body.fbclid?.slice(0, 300) ?? null,
      fbc: body.fbc?.slice(0, 300) ?? null,
      fbp: body.fbp?.slice(0, 300) ?? null,
      referrer: body.referrer ?? null,
      landing_page: body.landing_page ?? null,
      is_first_touch: !existingTouch,
    });

    if (body.ref_code) {
      const { data: rc } = await admin.from("referral_codes").select("id, clicks").eq("code", body.ref_code).maybeSingle();
      if (rc) await admin.from("referral_codes").update({ clicks: rc.clicks + 1 }).eq("id", rc.id);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("marketing-track error", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
