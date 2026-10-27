// Issues short-lived ICE servers (STUN + TURN) for a live video session.
// POST { token }  ->  { iceServers, relay }
// Secrets (any ONE option; without them the client falls back to public STUN):
//   Cloudflare Realtime TURN : CF_TURN_KEY_ID + CF_TURN_API_TOKEN
//   Your own coturn          : TURN_URLS (comma separated) + TURN_USERNAME + TURN_CREDENTIAL
// Deploy: supabase functions deploy video-ice --no-verify-jwt   (guests have no account)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const TOKEN_RE = /^[0-9a-f]{64}$/;
const TTL_SECONDS = 4 * 60 * 60;
const STUN = { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] };

type IceServer = { urls: string[]; username?: string; credential?: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function normalize(raw: unknown): IceServer[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const out: IceServer[] = [];
  for (const item of list as Array<{ urls?: unknown; username?: unknown; credential?: unknown }>) {
    const urls = (Array.isArray(item?.urls) ? item.urls : [item?.urls]).filter((u): u is string => typeof u === "string");
    if (urls.length === 0) continue;
    out.push({
      urls,
      ...(typeof item.username === "string" ? { username: item.username } : {}),
      ...(typeof item.credential === "string" ? { credential: item.credential } : {}),
    });
  }
  return out;
}

async function loadTurn(): Promise<IceServer[]> {
  const keyId = Deno.env.get("CF_TURN_KEY_ID");
  const apiToken = Deno.env.get("CF_TURN_API_TOKEN");
  if (keyId && apiToken) {
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      });
      if (res.ok) {
        const body = await res.json();
        const servers = normalize(body?.iceServers);
        if (servers.length) return servers;
      } else {
        console.error(JSON.stringify({ event: "video_ice_cf_failed", status: res.status }));
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "video_ice_cf_error", error: e instanceof Error ? e.message : String(e) }));
    }
  }
  const urls = (Deno.env.get("TURN_URLS") ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const username = Deno.env.get("TURN_USERNAME");
  const credential = Deno.env.get("TURN_CREDENTIAL");
  if (urls.length && username && credential) return [{ urls, username, credential }];
  return [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return json({ error: "Invalid token" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error } = await db.rpc("get_video_session_public", { p_token: token });
  if (error) return json({ error: "Lookup failed" }, 500);
  if (!session || !["waiting", "live"].includes(session.status)) return json({ error: "Session unavailable" }, 410);

  const turn = await loadTurn();
  return json({ iceServers: [STUN, ...turn], relay: turn.length > 0 });
});
