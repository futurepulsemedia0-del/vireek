// login-alert — records a completed sign-in and, when it comes from a new
// device or a new country, notifies the user by email (Resend) and by push
// (via the existing `notifications` table -> send-push-notification trigger).
//
// Called by the dashboard once per session (see src/lib/loginAlerts.ts).
// The caller's identity comes from the verified JWT; IP and user agent come
// from Supabase Auth's own session row, never from the request body, so a
// client can't spoof "I'm on a known device".
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided), RESEND_API_KEY,
//   RESEND_FROM_EMAIL (optional), SITE_URL, ALLOWED_ORIGINS (optional, comma
//   separated, extra origins besides SITE_URL), GEOIP_LOOKUP_URL (optional,
//   default https://ipwho.is/{ip}; must contain {ip}).
//
// Deploy: supabase functions deploy login-alert

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import {
  buildAlertEmail,
  classifyLogin,
  decodeJwtPayload,
  describeDevice,
  describeMethod,
  formatLocation,
  hashUserAgent,
  isPublicIp,
  maskIp,
  parseGeoResponse,
  primaryAuthMethod,
  sha256Hex,
  type GeoInfo,
} from "../_shared/security/login-alert-engine.ts";

const COOKIE_NAME = "vrk_device";
const HISTORY_DAYS = 180;
const HISTORY_LIMIT = 200;
const MAX_ALERT_EMAILS_PER_HOUR = 5;
const GEO_TIMEOUT_MS = 2500;

function siteUrl(): string {
  return (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
}

function allowedOrigins(): string[] {
  const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  return [siteUrl(), "http://localhost:5173", "http://127.0.0.1:5173", ...extra];
}

// Credentialed CORS (the httpOnly device cookie must be readable) forbids a
// wildcard origin, so reflect the caller's origin only if it is allow-listed.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const base = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
    Vary: "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) {
    return { ...base, "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" };
  }
  return { ...base, "Access-Control-Allow-Origin": "*" };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function lookupGeo(ip: string | null, req: Request): Promise<GeoInfo | null> {
  if (ip && isPublicIp(ip)) {
    const template = Deno.env.get("GEOIP_LOOKUP_URL") ?? "https://ipwho.is/{ip}";
    if (template.includes("{ip}")) {
      try {
        const res = await fetch(template.replace("{ip}", encodeURIComponent(ip)), {
          signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const geo = parseGeoResponse(await res.json());
          if (geo) return geo;
        }
      } catch {
        // fall through to the CDN header fallback — geo is best-effort
      }
    }
  }
  const cc = req.headers.get("cf-ipcountry");
  if (cc && /^[A-Za-z]{2}$/.test(cc) && cc.toUpperCase() !== "XX") {
    return { country: cc.toUpperCase(), region: null, city: null };
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return json(req, { error: "Missing Authorization header" }, 401);
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json(req, { error: "Invalid or expired session" }, 401);
  const user = userData.user;

  const payload = decodeJwtPayload(accessToken);
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id : null;
  if (!sessionId) return json(req, { error: "Token has no session_id" }, 400);

  try {
    // Server-recorded network info for this exact session.
    const { data: netRows } = await admin.rpc("get_session_network_info", {
      p_user_id: user.id,
      p_session_id: sessionId,
    });
    const net = (Array.isArray(netRows) ? netRows[0] : null) as { ip: string | null; user_agent: string | null } | null;
    const fwd = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    const ip = net?.ip ?? (fwd || null);
    const userAgent = net?.user_agent ?? req.headers.get("user-agent");

    const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();
    const { data: priorRows, error: priorError } = await admin
      .from("login_events")
      .select("device_cookie_hash, ua_hash, country, session_id")
      .eq("user_id", user.id)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (priorError) throw priorError;
    if ((priorRows ?? []).some((r) => r.session_id === sessionId)) {
      return json(req, { recorded: false, alerted: false, reason: "duplicate" });
    }

    const rawCookie = readCookie(req, COOKIE_NAME);
    const cookieHash = rawCookie ? await sha256Hex(rawCookie) : null;
    const uaHash = await hashUserAgent(user.id, userAgent);
    const geo = await lookupGeo(ip, req);

    const verdict = classifyLogin({ cookieDeviceHash: cookieHash, uaHash, geo }, priorRows ?? []);

    const deviceLabel = describeDevice(userAgent);
    const method = primaryAuthMethod(payload);

    const { error: insertError } = await admin.from("login_events").insert({
      user_id: user.id,
      session_id: sessionId,
      auth_method: method,
      device_cookie_hash: cookieHash,
      ua_hash: uaHash,
      device_label: deviceLabel,
      ip_masked: maskIp(ip),
      country: geo?.country ?? null,
      region: geo?.region ?? null,
      city: geo?.city ?? null,
      is_baseline: verdict.isBaseline,
      is_new_device: verdict.isNewDevice,
      is_new_location: verdict.isNewLocation,
      alert_sent: false,
    });
    if (insertError) {
      // 23505 = another call for this session won the race; it owns the alert.
      if ((insertError as { code?: string }).code === "23505") {
        return json(req, { recorded: false, alerted: false, reason: "duplicate" });
      }
      throw insertError;
    }

    if (!verdict.shouldAlert) return json(req, { recorded: true, alerted: false });

    // Flood guard: a burst of "new device" sessions must not become an email bomb.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await admin
      .from("login_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("alert_sent", true)
      .gte("created_at", hourAgo);
    if ((count ?? 0) >= MAX_ALERT_EMAILS_PER_HOUR) {
      return json(req, { recorded: true, alerted: false, reason: "rate_limited" });
    }

    const location = formatLocation(geo);
    let emailOk = false;
    if (user.email) {
      const mail = buildAlertEmail({
        deviceLabel,
        methodLabel: describeMethod(method),
        location,
        ipMasked: maskIp(ip),
        whenUtc: new Date(),
        isNewDevice: verdict.isNewDevice,
        isNewLocation: verdict.isNewLocation,
        securityUrl: `${siteUrl()}/dashboard/settings/security`,
      });
      const result = await sendEmail(user.email, mail.subject, mail.html, mail.text);
      emailOk = result.ok;
      if (!result.ok) console.error(JSON.stringify({ event: "login_alert_email_failed", user_id: user.id, error: result.error }));
    }

    // Push: inserting a notification fires the existing dispatch trigger.
    const { error: notifError } = await admin.from("notifications").insert({
      user_id: user.id,
      type: "system",
      title: verdict.isNewDevice ? "New device signed in" : "Sign-in from a new location",
      message: `${deviceLabel} · ${location}. If this wasn't you, secure your account.`,
      action_url: "/dashboard/settings/security",
    });
    if (notifError) console.error(JSON.stringify({ event: "login_alert_notification_failed", user_id: user.id }));

    await admin
      .from("login_events")
      .update({ alert_sent: emailOk || !notifError })
      .eq("session_id", sessionId);

    return json(req, { recorded: true, alerted: true, email: emailOk });
  } catch (err) {
    console.error(JSON.stringify({ event: "login_alert_failed", user_id: user.id, message: err instanceof Error ? err.message : String(err) }));
    return json(req, { error: "Could not process login alert" }, 500);
  }
});
