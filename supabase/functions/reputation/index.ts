// Reputation API for /dashboard/reputation (staff side).
//
// One authenticated POST endpoint, { action, ...args }:
//   overview / add_manual / delete_manual / draft_reply / save_reply /
//   set_status / save_settings / sync / oauth_start / connect_yelp / disconnect
//
// Scoping: every row is keyed by the ACCOUNT OWNER's profile id
// (accountOwnerId): owners resolve to themselves, team members through
// team_members.account_owner_id. Permission gate (server-side, mirrors the
// dashboard nav): owner OR can_edit_business_profile (custom roles override).
// Managing connections (OAuth / disconnect) is owner-only, like Demand OS.
//
// All provider traffic goes through _shared/reputation/providers.ts (the API
// boundary). With keys missing, provider actions fail closed with
// NOT_CONFIGURED; the inbox still works with manually logged reviews.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { signState } from "../_shared/price-book/oauthState.ts";
import { draftReviewReply } from "../_shared/ai-core/reviewReply.ts";
import {
  PROVIDER_CAPS,
  REPLY_MAX,
  BODY_MAX,
  NAME_MAX,
  canManageReputation,
  clip,
  isAlertFresh,
  isPlatform,
  isUuid,
  normalizeYelpBusinessId,
  safeReviewUrl,
  shouldAlert,
  type Platform,
} from "../_shared/reputation/engine.ts";
import {
  NotConfiguredError,
  UnsupportedError,
  assertConfigured,
  facebookAuthUrl,
  googleAuthUrl,
  lookupYelpBusiness,
  platformConfig,
  postReplyFor,
  type ConnectionRow,
} from "../_shared/reputation/providers.ts";
import { createAlert, loadSettings, syncConnection } from "../_shared/reputation/sync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const fail = (status: number, error: string, detail: string) => json({ error, detail }, status);

const REVIEW_COLUMNS =
  "id, connection_id, platform, source, external_id, reviewer_name, rating, body, reviewed_at, review_url, status, draft_reply, draft_source, draft_generated_at, reply_text, replied_at, reply_via, created_at";
const OVERVIEW_LIMIT = 500;
const SYNC_COOLDOWN_MS = 30_000;
const DRAFTS_PER_HOUR = 40;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return fail(401, "UNAUTHENTICATED", "Missing Authorization header.");
  const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !userData?.user) return fail(401, "UNAUTHENTICATED", "Invalid or expired session.");
  const user = userData.user;

  // ---- resolve account owner + permission gate ----------------------
  const { data: profile } = await admin.from("profiles").select("id, role, email").eq("id", user.id).maybeSingle();
  let ownerId: string | null = profile?.role === "owner" ? user.id : null;
  let teamPermissions: Record<string, unknown> | null = null;
  let customRolePermissions: Record<string, unknown> | null = null;
  if (!ownerId) {
    const { data: tm } = await admin
      .from("team_members")
      .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
      .eq("member_email", profile?.email ?? user.email ?? "")
      .maybeSingle();
    if (tm?.account_owner_id) {
      ownerId = tm.account_owner_id;
      teamPermissions = (tm.permissions as Record<string, unknown> | null) ?? null;
      customRolePermissions = ((tm.custom_role as { permissions?: Record<string, unknown> } | null)?.permissions) ?? null;
    }
  }
  if (!ownerId) return fail(403, "FORBIDDEN", "No account found for this user.");
  if (!canManageReputation({ role: profile?.role, teamPermissions, customRolePermissions })) {
    return fail(403, "FORBIDDEN", "You don't have permission to manage reviews.");
  }
  const accountOwnerId: string = ownerId;
  const isOwner = profile?.role === "owner";

  const args = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(args.action ?? "");
  const nowIso = () => new Date().toISOString();

  // ---- helpers ------------------------------------------------------
  async function businessName(): Promise<string> {
    const { data } = await admin.from("profiles").select("company_name").eq("id", accountOwnerId).maybeSingle();
    return data?.company_name ?? "our team";
  }

  async function loadReview(id: unknown) {
    if (!isUuid(id)) return null;
    const { data } = await admin.from("reviews").select(REVIEW_COLUMNS + ", user_id").eq("id", id).eq("user_id", accountOwnerId).maybeSingle();
    return data;
  }

  async function overview() {
    const cfg = platformConfig();
    const [settings, { data: connections }, { data: reviews, count }, name] = await Promise.all([
      loadSettings(admin, accountOwnerId),
      admin
        .from("review_connections")
        .select("id, platform, external_id, display_name, status, last_synced_at, last_error")
        .eq("user_id", accountOwnerId)
        .order("created_at", { ascending: true }),
      admin
        .from("reviews")
        .select(REVIEW_COLUMNS, { count: "exact" })
        .eq("user_id", accountOwnerId)
        .order("reviewed_at", { ascending: false })
        .limit(OVERVIEW_LIMIT),
      businessName(),
    ]);
    return {
      settings,
      connections: connections ?? [],
      platforms: (Object.keys(cfg) as Platform[]).map((p) => ({ platform: p, configured: cfg[p].configured, ...PROVIDER_CAPS[p] })),
      reviews: reviews ?? [],
      total: count ?? (reviews ?? []).length,
      truncated: (count ?? 0) > OVERVIEW_LIMIT,
      businessName: name,
    };
  }

  const connectionFor = async (id: unknown): Promise<ConnectionRow | null> => {
    if (!isUuid(id)) return null;
    const { data } = await admin
      .from("review_connections")
      .select("id, user_id, platform, external_id, display_name")
      .eq("id", id)
      .eq("user_id", accountOwnerId)
      .maybeSingle();
    return data as ConnectionRow | null;
  };

  try {
    switch (action) {
      case "overview":
        return json(await overview());

      case "add_manual": {
        if (!isPlatform(args.platform)) return fail(400, "INVALID", "Choose Google, Yelp or Facebook.");
        const rating = Number(args.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(400, "INVALID", "Rating must be 1 to 5.");
        const at = args.reviewedAt ? new Date(String(args.reviewedAt)) : new Date();
        if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 86_400_000) return fail(400, "INVALID", "The review date can't be in the future.");
        const reviewer = clip(args.reviewerName, NAME_MAX) || "Anonymous";
        const body = clip(args.body, BODY_MAX) || null;
        const url = args.reviewUrl ? safeReviewUrl(args.reviewUrl) : null;
        if (args.reviewUrl && !url) return fail(400, "INVALID", "The review link must be an https Google, Yelp or Facebook URL.");

        const { data: row, error } = await admin
          .from("reviews")
          .insert({ user_id: accountOwnerId, platform: args.platform, source: "manual", reviewer_name: reviewer, rating, body, reviewed_at: at.toISOString(), review_url: url })
          .select("id")
          .single();
        if (error || !row) throw error ?? new Error("insert failed");

        const settings = await loadSettings(admin, accountOwnerId);
        if (shouldAlert(rating, settings) && isAlertFresh(at.toISOString(), new Date())) {
          await createAlert(admin, accountOwnerId, { platform: args.platform, rating, reviewer_name: reviewer, body });
          await admin.from("reviews").update({ alerted_at: nowIso() }).eq("id", row.id);
        }
        return json(await overview());
      }

      case "delete_manual": {
        const review = await loadReview(args.reviewId);
        if (!review) return fail(404, "NOT_FOUND", "Review not found.");
        if (review.source !== "manual") return fail(409, "CONFLICT", "Only manually logged reviews can be deleted. Synced reviews can be dismissed instead.");
        const { error } = await admin.from("reviews").delete().eq("id", review.id).eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await overview());
      }

      case "draft_reply": {
        const review = await loadReview(args.reviewId);
        if (!review) return fail(404, "NOT_FOUND", "Review not found.");
        const { count } = await admin
          .from("reviews")
          .select("id", { count: "exact", head: true })
          .eq("user_id", accountOwnerId)
          .gte("draft_generated_at", new Date(Date.now() - 3_600_000).toISOString());
        if ((count ?? 0) >= DRAFTS_PER_HOUR) return fail(429, "RATE_LIMITED", "You've generated a lot of drafts this hour. Please wait a bit or write this one by hand.");

        const settings = await loadSettings(admin, accountOwnerId);
        const draft = await draftReviewReply(
          { platform: review.platform, rating: review.rating, reviewer_name: review.reviewer_name, body: review.body },
          { businessName: await businessName(), brandVoice: settings.brand_voice, signoff: settings.signoff },
        );
        await admin
          .from("reviews")
          .update({ draft_reply: draft.reply, draft_source: draft.source, draft_generated_at: nowIso(), updated_at: nowIso() })
          .eq("id", review.id)
          .eq("user_id", accountOwnerId);
        return json({ ...(await overview()), draft });
      }

      case "save_reply": {
        const review = await loadReview(args.reviewId);
        if (!review) return fail(404, "NOT_FOUND", "Review not found.");
        const text = clip(args.text, REPLY_MAX);
        if (text.length < 5) return fail(400, "INVALID", "Write a reply first.");

        let via: "api" | "manual" = "manual";
        if (args.post === true) {
          if (!review.connection_id || !review.external_id) return fail(400, "UNSUPPORTED", "This review can't be answered through the API. Reply on the platform, then mark it replied.");
          const conn = await connectionFor(review.connection_id);
          if (!conn) return fail(404, "NOT_FOUND", "The connection for this review no longer exists.");
          try {
            await postReplyFor(admin, conn, review.external_id, text);
          } catch (e) {
            if (e instanceof NotConfiguredError) return fail(422, "NOT_CONFIGURED", "This integration isn't enabled on this workspace yet.");
            if (e instanceof UnsupportedError) return fail(400, "UNSUPPORTED", e.message);
            console.error(JSON.stringify({ event: "reputation_reply_failed", platform: conn.platform, error: e instanceof Error ? e.message : String(e) }));
            return fail(422, "PROVIDER_ERROR", `${conn.platform} rejected the reply: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
          }
          via = "api";
        }
        const { error } = await admin
          .from("reviews")
          .update({ status: "replied", reply_text: text, replied_at: nowIso(), reply_via: via, draft_reply: null, updated_at: nowIso() })
          .eq("id", review.id)
          .eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await overview());
      }

      case "set_status": {
        const review = await loadReview(args.reviewId);
        if (!review) return fail(404, "NOT_FOUND", "Review not found.");
        const status = String(args.status);
        if (status !== "dismissed" && status !== "new") return fail(400, "INVALID", "Invalid status.");
        if (review.status === "replied") return fail(409, "CONFLICT", "This review already has a reply.");
        const { error } = await admin.from("reviews").update({ status, updated_at: nowIso() }).eq("id", review.id).eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await overview());
      }

      case "save_settings": {
        const max = Number(args.alertMaxRating);
        if (!Number.isInteger(max) || max < 1 || max > 5) return fail(400, "INVALID", "Alert rating must be 1 to 5.");
        const { error } = await admin.from("reputation_settings").upsert({
          user_id: accountOwnerId,
          alerts_enabled: args.alertsEnabled !== false,
          alert_max_rating: max,
          brand_voice: clip(args.brandVoice, 500) || null,
          signoff: clip(args.signoff, 120) || null,
          updated_at: nowIso(),
        });
        if (error) throw error;
        return json(await overview());
      }

      case "sync": {
        const settings = await loadSettings(admin, accountOwnerId);
        let list: ConnectionRow[] = [];
        if (args.connectionId) {
          const c = await connectionFor(args.connectionId);
          if (!c) return fail(404, "NOT_FOUND", "Connection not found.");
          list = [c];
        } else {
          const { data } = await admin.from("review_connections").select("id, user_id, platform, external_id, display_name").eq("user_id", accountOwnerId);
          list = (data ?? []) as ConnectionRow[];
        }
        if (list.length === 0) return fail(400, "NO_CONNECTIONS", "Connect a review source first.");
        const { data: stamps } = await admin.from("review_connections").select("id, updated_at").in("id", list.map((c) => c.id));
        const recent = new Set((stamps ?? []).filter((s) => Date.now() - new Date(s.updated_at).getTime() < SYNC_COOLDOWN_MS).map((s) => s.id));
        const due = list.filter((c) => !recent.has(c.id));
        if (due.length === 0) return fail(429, "RATE_LIMITED", "Synced a moment ago — try again in a few seconds.");
        const results = [];
        for (const c of due) results.push({ connection: c.display_name, ...(await syncConnection(admin, c, settings)) });
        return json({ ...(await overview()), sync: results });
      }

      case "oauth_start": {
        if (!isOwner) return fail(403, "FORBIDDEN", "Only the account owner can connect review sources.");
        if (args.platform !== "google" && args.platform !== "facebook") return fail(400, "INVALID", "Unsupported platform.");
        try {
          assertConfigured(args.platform);
        } catch {
          return fail(422, "NOT_CONFIGURED", "This integration isn't enabled on this workspace yet.");
        }
        const secret = Deno.env.get("REPUTATION_STATE_SECRET") ?? "";
        const state = await signState(`${accountOwnerId}~${args.platform}`, secret);
        const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/reputation-oauth-callback`;
        return json({ url: args.platform === "google" ? googleAuthUrl(redirectUri, state) : facebookAuthUrl(redirectUri, state) });
      }

      case "connect_yelp": {
        if (!isOwner) return fail(403, "FORBIDDEN", "Only the account owner can connect review sources.");
        try {
          assertConfigured("yelp");
        } catch {
          return fail(422, "NOT_CONFIGURED", "Yelp isn't enabled on this workspace yet.");
        }
        const id = normalizeYelpBusinessId(args.businessId);
        if (!id) return fail(400, "INVALID", "Paste your Yelp business page link or its alias (e.g. acme-hvac-austin).");
        let biz;
        try {
          biz = await lookupYelpBusiness(id);
        } catch {
          return fail(422, "PROVIDER_ERROR", "Yelp couldn't find that business. Check the link and try again.");
        }
        const { data: conn, error } = await admin
          .from("review_connections")
          .upsert({ user_id: accountOwnerId, platform: "yelp", external_id: biz.id, display_name: biz.name, status: "active", last_error: null, updated_at: nowIso() }, { onConflict: "user_id,platform,external_id" })
          .select("id, user_id, platform, external_id, display_name")
          .single();
        if (error || !conn) throw error ?? new Error("upsert failed");
        const settings = await loadSettings(admin, accountOwnerId);
        await syncConnection(admin, conn as ConnectionRow, settings);
        return json(await overview());
      }

      case "disconnect": {
        if (!isOwner) return fail(403, "FORBIDDEN", "Only the account owner can disconnect review sources.");
        const conn = await connectionFor(args.connectionId);
        if (!conn) return fail(404, "NOT_FOUND", "Connection not found.");
        const { error } = await admin.from("review_connections").delete().eq("id", conn.id).eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await overview());
      }

      default:
        return fail(400, "INVALID", "Unknown action.");
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "reputation_failed", action, error: error instanceof Error ? error.message : String(error) }));
    return fail(500, "INTERNAL", "Something went wrong. Please try again.");
  }
});
