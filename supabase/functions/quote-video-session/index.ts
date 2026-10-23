// Technician-side live video estimate (Daily.co).
//
//   { action: "start", quote_id, display_name? } → { session_id, url, expires_at }   (re-issues a token if one is already live)
//   { action: "end",   session_id }              → { ended: true }
//
// Auth   : the caller's own JWT. Authorisation is decided in SQL by
//          quote_video_caller_owner(quote_id) - owner or a team member with
//          can_view_billing, and the quote must belong to the caller's account.
//          The service-role client is used only to write the session row.
// Privacy: rooms are private + short-lived; recording is never enabled.
//
// Secrets: DAILY_API_KEY (required for this function).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  LIVE_ROOM_TTL_SECONDS,
  buildRoomName,
  isUuid,
  liveSessionState,
  sanitizeDisplayName,
  secondsFromNow,
} from "../_shared/quote-video/engine.ts";
import { DailyError, createMeetingToken, createPrivateRoom, deleteRoom, joinUrl } from "../_shared/quote-video/daily.ts";

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

const SESSION_COLUMNS = "id, user_id, quote_id, room_name, room_url, status, expires_at";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "UNAUTHENTICATED" }, 401);

  const apiKey = Deno.env.get("DAILY_API_KEY");
  if (!apiKey) return json({ error: "LIVE_NOT_CONFIGURED" }, 501);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const asCaller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const { data: userData } = await asCaller.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return json({ error: "UNAUTHENTICATED" }, 401);

    const now = new Date();

    // ---------------- end ----------------
    if (action === "end") {
      if (!isUuid(body?.session_id)) return json({ error: "NOT_FOUND" }, 404);
      const { data: session } = await admin
        .from("quote_video_sessions")
        .select(SESSION_COLUMNS)
        .eq("id", body.session_id)
        .maybeSingle();
      if (!session) return json({ error: "NOT_FOUND" }, 404);

      const { data: owner } = await asCaller.rpc("quote_video_caller_owner", { p_quote_id: session.quote_id });
      if (!owner || owner !== session.user_id) return json({ error: "FORBIDDEN" }, 403);

      await admin
        .from("quote_video_sessions")
        .update({ status: "ended", ended_at: now.toISOString() })
        .eq("id", session.id)
        .eq("status", "live");
      await deleteRoom(apiKey, session.room_name).catch((e) =>
        console.error(JSON.stringify({ event: "quote_video_room_delete_failed", error: String(e) })),
      );
      return json({ ended: true });
    }

    // ---------------- start (default) ----------------
    if (action !== "start" || !isUuid(body?.quote_id)) return json({ error: "INVALID_REQUEST" }, 422);
    const quoteId = body.quote_id;

    const { data: owner } = await asCaller.rpc("quote_video_caller_owner", { p_quote_id: quoteId });
    if (!owner) return json({ error: "FORBIDDEN" }, 403);

    const { data: quote } = await admin.from("quotes").select("id, status").eq("id", quoteId).maybeSingle();
    if (!quote || !["draft", "sent"].includes(quote.status)) return json({ error: "QUOTE_CLOSED" }, 409);

    const displayName = sanitizeDisplayName(body?.display_name, "Technician");

    const issue = async (session: { id: string; room_name: string; room_url: string; expires_at: string }) => {
      const exp = Math.floor(new Date(session.expires_at).getTime() / 1000);
      const meetingToken = await createMeetingToken(apiKey, {
        roomName: session.room_name,
        userName: displayName,
        isOwner: true,
        expEpochSeconds: exp,
      });
      return json({ session_id: session.id, url: joinUrl(session.room_url, meetingToken), expires_at: session.expires_at });
    };

    // Reuse a still-live session (rejoin after a refresh / dropped connection).
    const { data: existing } = await admin
      .from("quote_video_sessions")
      .select(SESSION_COLUMNS)
      .eq("quote_id", quoteId)
      .eq("status", "live")
      .maybeSingle();
    if (existing) {
      if (liveSessionState(existing, now) === "live") return await issue(existing);
      // Left over from a crash/expiry: close it so a fresh one can start.
      await admin.from("quote_video_sessions").update({ status: "ended", ended_at: now.toISOString() }).eq("id", existing.id);
    }

    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const roomName = buildRoomName(randomHex);
    const expEpoch = secondsFromNow(now, LIVE_ROOM_TTL_SECONDS);

    const room = await createPrivateRoom(apiKey, roomName, expEpoch);
    const { data: created, error: insertError } = await admin
      .from("quote_video_sessions")
      .insert({
        user_id: owner,
        quote_id: quoteId,
        created_by: userId,
        room_name: room.name,
        room_url: room.url,
        expires_at: new Date(expEpoch * 1000).toISOString(),
      })
      .select(SESSION_COLUMNS)
      .single();

    if (insertError || !created) {
      // Lost a race with another tab (unique live-per-quote index): drop our room, reuse theirs.
      await deleteRoom(apiKey, room.name).catch(() => undefined);
      const { data: winner } = await admin
        .from("quote_video_sessions")
        .select(SESSION_COLUMNS)
        .eq("quote_id", quoteId)
        .eq("status", "live")
        .maybeSingle();
      if (winner) return await issue(winner);
      throw insertError ?? new Error("session insert failed");
    }

    return await issue(created);
  } catch (error) {
    if (error instanceof DailyError) {
      console.error(JSON.stringify({ event: "quote_video_session_daily_failed", status: error.status, error: error.message }));
      return json({ error: "LIVE_UNAVAILABLE" }, 502);
    }
    console.error(JSON.stringify({ event: "quote_video_session_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "INTERNAL" }, 500);
  }
});
