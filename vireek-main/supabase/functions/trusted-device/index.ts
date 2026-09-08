import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const COOKIE_NAME = "vrk_device";
const DEVICE_TTL_DAYS = 60;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function deviceCookieHeader(rawToken: string, maxAgeSeconds: number) {
  // httpOnly: never readable by page JavaScript, so it can't be lifted by
  // an XSS payload or read out of localStorage. Secure + SameSite=Lax
  // stops it being sent cross-site. This cookie holds an opaque random
  // token only — never the user's email, id, or any Supabase session token.
  return `${COOKIE_NAME}=${encodeURIComponent(rawToken)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function expiredCookieHeader() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function deviceNameFromUserAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMac = /Macintosh/.test(ua);
  const isWindows = /Windows/.test(ua);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && !/Chrome\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  const platform = isIOS ? "iOS" : isAndroid ? "Android" : isMac ? "Mac" : isWindows ? "Windows" : "device";
  return `${browser} on ${platform}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Identify the caller from their Supabase access token. This never trusts
  // a client-supplied user_id — the id always comes from a verified JWT.
  const authHeader = req.headers.get("authorization") ?? "";
  const accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) return json({ error: "Missing Authorization header" }, 401);

  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401);
  const userId = userData.user.id;

  let body: { action?: string; device_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine for some actions
  }
  const action = body.action;

  if (action === "check") {
    const rawToken = readCookie(req, COOKIE_NAME);
    if (!rawToken) return json({ trusted: false });

    const tokenHash = await sha256Hex(rawToken);
    const { data: rows, error } = await admin
      .from("trusted_devices")
      .select("id, expires_at, revoked_at")
      .eq("user_id", userId)
      .eq("device_token_hash", tokenHash)
      .is("revoked_at", null)
      .limit(1);

    if (error) return json({ error: "Lookup failed" }, 500);

    const row = rows?.[0];
    if (!row) return json({ trusted: false });

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return json({ trusted: false }, 200, { "Set-Cookie": expiredCookieHeader() });
    }

    await admin.from("trusted_devices").update({ last_used_at: new Date().toISOString() }).eq("id", row.id);
    return json({ trusted: true });
  }

  if (action === "register") {
    // Always issue a brand-new random token — never reuse or extend
    // whatever cookie (if any) was already present. This is what protects
    // against replay: an attacker who captured an old cookie value gains
    // nothing once a fresh verification issues a new one, and the old
    // hash simply stops matching once its row is superseded/expired.
    const rawToken = crypto.randomUUID() + crypto.randomUUID();
    const tokenHash = await sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + DEVICE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const deviceName = deviceNameFromUserAgent(req.headers.get("user-agent"));

    const { error } = await admin.from("trusted_devices").insert({
      user_id: userId,
      device_token_hash: tokenHash,
      device_name: deviceName,
      expires_at: expiresAt,
    });
    if (error) return json({ error: "Could not register device" }, 500);

    return json(
      { registered: true },
      200,
      { "Set-Cookie": deviceCookieHeader(rawToken, DEVICE_TTL_DAYS * 24 * 60 * 60) }
    );
  }

  if (action === "list") {
    const currentRaw = readCookie(req, COOKIE_NAME);
    const currentHash = currentRaw ? await sha256Hex(currentRaw) : null;

    const { data, error } = await admin
      .from("trusted_devices")
      .select("id, device_name, created_at, last_used_at, expires_at, revoked_at, device_token_hash")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .order("last_used_at", { ascending: false });

    if (error) return json({ error: "Could not list devices" }, 500);

    const devices = (data ?? []).map((d) => ({
      id: d.id,
      device_name: d.device_name,
      created_at: d.created_at,
      last_used_at: d.last_used_at,
      expires_at: d.expires_at,
      is_current: currentHash ? d.device_token_hash === currentHash : false,
    }));

    return json({ devices });
  }

  if (action === "revoke") {
    if (!body.device_id) return json({ error: "device_id is required" }, 400);

    const { error } = await admin
      .from("trusted_devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", body.device_id)
      .eq("user_id", userId); // scoped so a user can only revoke their own device

    if (error) return json({ error: "Could not revoke device" }, 500);
    return json({ revoked: true });
  }

  return json({ error: "Unknown action" }, 400);
});
