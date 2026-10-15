// supabase/functions/_shared/live-calls/runtime.ts
//
// Feeds the Live Calls board from vapi-webhook's existing server messages.
// Contract: BEST EFFORT. It never throws and never changes the webhook's
// response — a failure here must not affect a call, a booking, or the
// existing calls-row upsert.
//
// Vapi must be sending these Server Messages for the board to fill:
//   status-update, transcript, end-of-call-report
// (Assistant -> Advanced -> Messaging -> Server Messages).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  EMPTY_SIGNALS,
  applyCallerLine,
  parseLiveEvent,
  previewOf,
  sentimentFromScore,
  type LiveMessageLike,
  type LiveRole,
  type LiveSignals,
  type LiveStatus,
} from "./logic.ts";

interface LiveMessage extends LiveMessageLike {
  call?: {
    id?: string;
    customer?: { number?: string | null; name?: string | null } | null;
    startedAt?: string;
  };
}

// deno-lint-ignore no-explicit-any
type ResolveTenant = (admin: SupabaseClient, message: any, requestId: string) => Promise<{ userId: string } | null>;

interface LiveRow {
  id: string;
  user_id: string;
  status: LiveStatus;
  sentiment_score: number;
  signal_text: string;
  intent: LiveSignals["intent"];
  wants_human: boolean;
}

const RANK: Record<LiveStatus, number> = { ringing: 0, in_progress: 1, ended: 2 };
const TENANT_TTL_MS = 10 * 60 * 1000;
const TENANT_CACHE_MAX = 500;
const tenantCache = new Map<string, { userId: string; exp: number }>();

async function tenantFor(
  admin: SupabaseClient,
  message: LiveMessage,
  callId: string,
  requestId: string,
  resolve: ResolveTenant,
): Promise<string | null> {
  const hit = tenantCache.get(callId);
  if (hit && hit.exp > Date.now()) return hit.userId;
  const tenant = await resolve(admin, message, requestId);
  if (!tenant) return null;
  if (tenantCache.size >= TENANT_CACHE_MAX) tenantCache.clear();
  tenantCache.set(callId, { userId: tenant.userId, exp: Date.now() + TENANT_TTL_MS });
  return tenant.userId;
}

const ROW_COLUMNS = "id, user_id, status, sentiment_score, signal_text, intent, wants_human";

/** Returns the live row for this call, creating it on first sight (events can arrive in any order). */
async function ensureLiveCall(
  admin: SupabaseClient,
  userId: string,
  callId: string,
  message: LiveMessage,
  status: LiveStatus,
): Promise<LiveRow | null> {
  const found = await admin.from("live_calls").select(ROW_COLUMNS).eq("vapi_call_id", callId).maybeSingle();
  if (found.error) return null;
  if (found.data) return found.data as LiveRow;

  const started = message.call?.startedAt && !Number.isNaN(Date.parse(message.call.startedAt))
    ? message.call.startedAt
    : new Date().toISOString();

  const inserted = await admin
    .from("live_calls")
    .insert({
      user_id: userId,
      vapi_call_id: callId,
      caller_phone: message.call?.customer?.number ?? null,
      caller_name: message.call?.customer?.name ?? null,
      status,
      started_at: started,
    })
    .select(ROW_COLUMNS)
    .single();

  if (inserted.error) {
    // A concurrent event created it first (unique vapi_call_id) — read it back.
    const again = await admin.from("live_calls").select(ROW_COLUMNS).eq("vapi_call_id", callId).maybeSingle();
    return (again.data as LiveRow | null) ?? null;
  }

  // Opportunistic retention: drop this account's ended calls older than 2 days.
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await admin.from("live_calls").delete().eq("user_id", userId).eq("status", "ended").lt("ended_at", cutoff);

  return inserted.data as LiveRow;
}

export async function trackLiveCallEvent(
  admin: SupabaseClient,
  message: LiveMessage,
  requestId: string,
  resolveTenant: ResolveTenant,
): Promise<void> {
  try {
    const event = parseLiveEvent(message);
    const callId = message.call?.id;
    if (!event || !callId) return;

    const userId = await tenantFor(admin, message, callId, requestId, resolveTenant);
    if (!userId) return;

    if (event.kind === "status") {
      const row = await ensureLiveCall(admin, userId, callId, message, event.status);
      if (!row || RANK[event.status] <= RANK[row.status]) return; // never move a call backwards
      const patch: Record<string, unknown> = { status: event.status, updated_at: new Date().toISOString() };
      if (event.status === "ended") {
        patch.ended_at = new Date().toISOString();
        patch.ended_reason = event.endedReason;
      }
      await admin.from("live_calls").update(patch).eq("id", row.id);
      return;
    }

    // A transcript line can beat the status-update; a call that is speaking is in progress.
    const row = await ensureLiveCall(admin, userId, callId, message, "in_progress");
    if (!row) return;

    const role: LiveRole = event.role;
    await admin.from("live_call_lines").insert({
      live_call_id: row.id,
      user_id: row.user_id,
      role,
      content: event.text,
    });

    const patch: Record<string, unknown> = {
      last_line_role: role,
      last_line_preview: previewOf(event.text),
      last_line_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (role === "caller") {
      const prev: LiveSignals = {
        ...EMPTY_SIGNALS,
        sentiment_score: row.sentiment_score,
        signal_text: row.signal_text,
        intent: row.intent,
        wants_human: row.wants_human,
      };
      const next = applyCallerLine(prev, event.text);
      Object.assign(patch, {
        sentiment_score: next.sentiment_score,
        sentiment: sentimentFromScore(next.sentiment_score),
        signal_text: next.signal_text,
        intent: next.intent,
        wants_human: next.wants_human,
      });
    }
    await admin.from("live_calls").update(patch).eq("id", row.id);
  } catch (error) {
    console.error("live_call_tracking_failed", requestId, error instanceof Error ? error.message : error);
  }
}
