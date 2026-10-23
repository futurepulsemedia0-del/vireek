// supabase/functions/_shared/quote-video/daily.ts
//
// Thin Daily.co REST wrapper for live video estimates. Kept in its own file so
// that, if your live project already has a Daily helper, you can delete this
// file and point quote-video-session / quote-video-public at the existing one
// (the three functions below are the whole surface they use).
//
// Secret: DAILY_API_KEY (Supabase → Edge Functions → Secrets).
//
// Security model: rooms are PRIVATE (no one can join without a meeting token),
// short-lived (exp), capped at 4 participants, and cloud recording is NOT
// enabled - a live estimate leaves no recording, so there is no recording-
// consent obligation to track.

const DAILY_API = "https://api.daily.co/v1";

export class DailyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function daily(path: string, apiKey: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${DAILY_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const info = (body as { info?: string; error?: string } | null)?.info ?? (body as { error?: string } | null)?.error;
    throw new DailyError(res.status, info ?? `Daily API ${res.status}`);
  }
  return body;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function createPrivateRoom(
  apiKey: string,
  roomName: string,
  expEpochSeconds: number,
): Promise<{ name: string; url: string }> {
  const room = (await daily("/rooms", apiKey, {
    method: "POST",
    body: JSON.stringify({
      name: roomName,
      privacy: "private",
      properties: {
        exp: expEpochSeconds,
        eject_at_room_exp: true,
        max_participants: 4,
        enable_chat: true,
        enable_screenshare: true,
        enable_prejoin_ui: true,
        start_video_off: false,
        start_audio_off: false,
      },
    }),
  })) as { name?: string; url?: string } | null;
  if (!room?.name || !room?.url) throw new DailyError(502, "Daily returned an invalid room");
  return { name: room.name, url: room.url };
}

export async function createMeetingToken(
  apiKey: string,
  opts: { roomName: string; userName: string; isOwner: boolean; expEpochSeconds: number },
): Promise<string> {
  const res = (await daily("/meeting-tokens", apiKey, {
    method: "POST",
    body: JSON.stringify({
      properties: {
        room_name: opts.roomName,
        user_name: opts.userName,
        is_owner: opts.isOwner,
        exp: opts.expEpochSeconds,
        eject_at_token_exp: true,
        enable_screenshare: true,
        start_video_off: false,
      },
    }),
  })) as { token?: string } | null;
  if (!res?.token) throw new DailyError(502, "Daily returned an invalid token");
  return res.token;
}

/** Best-effort: a missing room (already expired) is not an error. */
export async function deleteRoom(apiKey: string, roomName: string): Promise<void> {
  try {
    await daily(`/rooms/${encodeURIComponent(roomName)}`, apiKey, { method: "DELETE" });
  } catch (error) {
    if (error instanceof DailyError && error.status === 404) return;
    throw error;
  }
}

export function joinUrl(roomUrl: string, token: string): string {
  return `${roomUrl}?t=${encodeURIComponent(token)}`;
}
