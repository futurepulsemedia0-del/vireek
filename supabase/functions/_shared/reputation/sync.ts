// supabase/functions/_shared/reputation/sync.ts
//
// Pulls reviews for one connection through the provider boundary, upserts them
// into the inbox (never duplicating, never touching reply state of reviews the
// team already handled) and raises low-rating alerts through `notifications`.
// Used by BOTH the cron-driven reputation-sync function and the on-demand
// "Sync now" action of the reputation function.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { HttpError } from "../ads/common.ts";
import {
  DEFAULT_SETTINGS,
  alertText,
  isAlertFresh,
  shouldAlert,
  type NormalizedReview,
} from "./engine.ts";
import { NotConfiguredError, ReauthRequiredError, fetchReviewsFor, type ConnectionRow } from "./providers.ts";

export interface SettingsRow {
  alerts_enabled: boolean;
  alert_max_rating: number;
  brand_voice: string | null;
  signoff: string | null;
}

export async function loadSettings(admin: SupabaseClient, ownerId: string): Promise<SettingsRow> {
  const { data } = await admin.from("reputation_settings").select("alerts_enabled, alert_max_rating, brand_voice, signoff").eq("user_id", ownerId).maybeSingle();
  return { ...DEFAULT_SETTINGS, ...(data ?? {}) };
}

export async function createAlert(
  admin: SupabaseClient,
  ownerId: string,
  r: { platform: NormalizedReview["platform"]; rating: number; reviewer_name: string; body: string | null },
) {
  const t = alertText(r);
  await admin.from("notifications").insert({
    user_id: ownerId,
    type: "system",
    title: t.title,
    message: t.message,
    action_url: "/dashboard/reputation",
  });
}

export interface SyncResult {
  inserted: number;
  updated: number;
  alerts: number;
  error: string | null;
}

export async function syncConnection(
  admin: SupabaseClient,
  conn: ConnectionRow,
  settings: SettingsRow,
  now = new Date(),
): Promise<SyncResult> {
  const result: SyncResult = { inserted: 0, updated: 0, alerts: 0, error: null };
  const markConnection = (patch: Record<string, unknown>) =>
    admin.from("review_connections").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", conn.id);

  try {
    const fetched = await fetchReviewsFor(admin, conn);

    const ids = fetched.map((r) => r.external_id);
    const { data: existing } = ids.length
      ? await admin.from("reviews").select("id, external_id, status").eq("user_id", conn.user_id).eq("platform", conn.platform).in("external_id", ids)
      : { data: [] as { id: string; external_id: string; status: string }[] };
    const known = new Map((existing ?? []).map((e) => [e.external_id as string, e]));

    for (const r of fetched) {
      const hit = known.get(r.external_id);
      if (hit) {
        // Reviewers can edit their review; keep our copy current but never reset reply state.
        const { error } = await admin
          .from("reviews")
          .update({ rating: r.rating, body: r.body, reviewer_name: r.reviewer_name, updated_at: new Date().toISOString() })
          .eq("id", hit.id);
        if (!error) result.updated++;
        continue;
      }

      const replied = !!r.existing_reply;
      const { data: row, error } = await admin
        .from("reviews")
        .insert({
          user_id: conn.user_id,
          connection_id: conn.id,
          platform: r.platform,
          source: "api",
          external_id: r.external_id,
          reviewer_name: r.reviewer_name,
          rating: r.rating,
          body: r.body,
          reviewed_at: r.reviewed_at,
          review_url: r.review_url,
          status: replied ? "replied" : "new",
          reply_text: r.existing_reply?.text ?? null,
          replied_at: r.existing_reply ? (r.existing_reply.at ?? now.toISOString()) : null,
          reply_via: replied ? "platform" : null,
        })
        .select("id")
        .single();
      if (error || !row) continue; // unique-violation race with a concurrent sync is harmless
      result.inserted++;

      if (!replied && shouldAlert(r.rating, settings) && isAlertFresh(r.reviewed_at, now)) {
        await createAlert(admin, conn.user_id, r);
        await admin.from("reviews").update({ alerted_at: now.toISOString() }).eq("id", row.id);
        result.alerts++;
      }
    }

    await markConnection({ status: "active", last_error: null, last_synced_at: now.toISOString() });
  } catch (e) {
    const reauth = e instanceof ReauthRequiredError || (e instanceof HttpError && (e.status === 401 || e.status === 403));
    const message = e instanceof NotConfiguredError ? "Integration isn't configured on this server." : e instanceof Error ? e.message : String(e);
    result.error = message.slice(0, 300);
    await markConnection({ status: reauth ? "needs_reauth" : "error", last_error: result.error });
  }
  return result;
}
