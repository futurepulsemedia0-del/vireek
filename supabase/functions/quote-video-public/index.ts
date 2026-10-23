// Public (no-auth) endpoint behind the customer quote link /quote/:token.
// Matches ONLY on the unguessable quotes.quote_token. Never returns storage
// paths, account ids or contact details - only short-lived signed URLs.
//
//   { action: "list", token }                                   → videos + live flag
//   { action: "event", token, video_id, event, progress?, name? } → engagement / acknowledgement
//   { action: "live_status", token }                            → { live }
//   { action: "join_live", token, name? }                       → { url, expires_at }
//
// Engagement + acknowledgement rules live in SQL (record_quote_video_event);
// a customer can only ever touch videos the technician explicitly shared.
//
// Deploy with JWT verification OFF (public link):
//   supabase functions deploy quote-video-public --no-verify-jwt
// Secrets (live estimates only): DAILY_API_KEY

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  QUOTE_VIDEO_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  canCustomerJoin,
  isUuid,
  liveSessionState,
  parseEventBody,
  sanitizeDisplayName,
} from "../_shared/quote-video/engine.ts";
import { createMeetingToken, DailyError, joinUrl } from "../_shared/quote-video/daily.ts";

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

// Stable SQL error codes (RAISE EXCEPTION 'CODE') → HTTP.
const SQL_ERRORS: Array<{ match: string; status: number; error: string }> = [
  { match: "NOT_FOUND", status: 404, error: "NOT_FOUND" },
  { match: "QUOTE_NOT_OPEN", status: 409, error: "QUOTE_NOT_OPEN" },
  { match: "WATCH_REQUIRED", status: 409, error: "WATCH_REQUIRED" },
  { match: "NAME_REQUIRED", status: 422, error: "NAME_REQUIRED" },
  { match: "INVALID_EVENT", status: 422, error: "INVALID_EVENT" },
];

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
    const { data: quote } = await admin
      .from("quotes")
      .select("id, status, customer_name")
      .eq("quote_token", token)
      .maybeSingle();
    if (!quote || quote.status === "draft") return json({ error: "NOT_FOUND" }, 404);

    const now = new Date();
    const loadLive = async () => {
      const { data } = await admin
        .from("quote_video_sessions")
        .select("id, room_name, room_url, status, expires_at, customer_join_count, customer_first_joined_at")
        .eq("quote_id", quote.id)
        .eq("status", "live")
        .maybeSingle();
      return data;
    };

    // ---- event ----
    if (body?.action === "event") {
      const parsed = parseEventBody(body);
      if (!parsed.ok) return json({ error: parsed.error }, 422);
      const { data, error } = await admin.rpc("record_quote_video_event", {
        p_token: token,
        p_video_id: parsed.videoId,
        p_event: parsed.event,
        p_progress: parsed.progress,
        p_name: parsed.name,
      });
      if (error) {
        const mapped = SQL_ERRORS.find((e) => error.message?.includes(e.match));
        if (mapped) return json({ error: mapped.error }, mapped.status);
        throw error;
      }
      return json({ result: data });
    }

    // ---- live_status ----
    if (body?.action === "live_status") {
      const session = await loadLive();
      return json({ live: canCustomerJoin(session, now) });
    }

    // ---- join_live ----
    if (body?.action === "join_live") {
      const apiKey = Deno.env.get("DAILY_API_KEY");
      if (!apiKey) return json({ error: "LIVE_NOT_CONFIGURED" }, 501);

      const session = await loadLive();
      if (!session || liveSessionState(session, now) !== "live") return json({ error: "NO_LIVE_SESSION" }, 404);
      if (!canCustomerJoin(session, now)) return json({ error: "JOIN_LIMIT" }, 429);

      const name = sanitizeDisplayName(body?.name, sanitizeDisplayName(quote.customer_name, "Customer"));
      const exp = Math.floor(new Date(session.expires_at).getTime() / 1000);
      const meetingToken = await createMeetingToken(apiKey, {
        roomName: session.room_name,
        userName: name,
        isOwner: false,
        expEpochSeconds: exp,
      });

      await admin
        .from("quote_video_sessions")
        .update({
          customer_join_count: (session.customer_join_count ?? 0) + 1,
          customer_first_joined_at: session.customer_first_joined_at ?? now.toISOString(),
        })
        .eq("id", session.id);

      return json({ url: joinUrl(session.room_url, meetingToken), expires_at: session.expires_at });
    }

    // ---- default: list ----
    const { data: rows, error: listError } = await admin.rpc("get_quote_videos_for_token", { p_token: token });
    if (listError) throw listError;
    const videos = (rows ?? []) as Array<{
      id: string; title: string; note: string | null; storage_path: string; mime_type: string;
      duration_seconds: number | null; max_progress: number; completed_at: string | null; acknowledged_at: string | null;
    }>;

    const urls = new Map<string, string>();
    if (videos.length) {
      const { data: signed } = await admin.storage
        .from(QUOTE_VIDEO_BUCKET)
        .createSignedUrls(videos.map((v) => v.storage_path), SIGNED_URL_TTL_SECONDS);
      for (const row of signed ?? []) if (row.signedUrl && row.path) urls.set(row.path, row.signedUrl);
    }

    const live = canCustomerJoin(await loadLive(), now);

    return json({
      quote_status: quote.status,
      live,
      videos: videos
        .filter((v) => urls.has(v.storage_path))
        .map((v) => ({
          id: v.id,
          title: v.title,
          note: v.note,
          mime_type: v.mime_type,
          duration_seconds: v.duration_seconds,
          max_progress: v.max_progress,
          completed: v.completed_at !== null,
          acknowledged: v.acknowledged_at !== null,
          url: urls.get(v.storage_path) as string,
        })),
    });
  } catch (error) {
    if (error instanceof DailyError) {
      console.error(JSON.stringify({ event: "quote_video_public_daily_failed", status: error.status, error: error.message }));
      return json({ error: "LIVE_UNAVAILABLE" }, 502);
    }
    console.error(JSON.stringify({ event: "quote_video_public_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "INTERNAL" }, 500);
  }
});
