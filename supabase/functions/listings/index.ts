// Listings API for /dashboard/listings (staff side).
//
// One authenticated POST endpoint, { action, ...args }:
//   overview / save_settings / oauth_start / connect_yelp / disconnect /
//   link_location / unlink_location / sync / confirm_manual
//
// Scoping: every row is keyed by the ACCOUNT OWNER's profile id (accountOwnerId):
// owners resolve to themselves, team members through team_members.account_owner_id.
// Permission gate (server-side, mirrors the dashboard nav): owner OR
// can_edit_business_profile (custom roles override). Managing connections
// (OAuth / Yelp / disconnect) is owner-only, like Reputation.
//
// All provider traffic goes through _shared/listings/providers.ts. With keys
// missing every link runs in manual (copy & paste) mode and nothing is called.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { signState } from "../_shared/price-book/oauthState.ts";
import {
  LISTING_CAPS,
  blockingIssues,
  canManageListings,
  canonicalHash,
  clip,
  isListingPlatform,
  isUuid,
  normalizeExternalId,
  normalizeWebsite,
  normalizeYelpAlias,
  resolveMode,
  validateCanonical,
  type ListingPlatform,
} from "../_shared/listings/engine.ts";
import {
  LINK_COLUMNS,
  NotConfiguredError,
  assertConfigured,
  facebookAuthUrl,
  lookupYelpBusiness,
  platformStatus,
  type LinkRow,
} from "../_shared/listings/providers.ts";
import { canonicalFor, loadOwnerContext, loadSettings, logLinkEvent, processLink, type OwnerContext } from "../_shared/listings/sync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const fail = (status: number, error: string, detail: string) => json({ error, detail }, status);

const EVENT_LIMIT = 60;
const LINK_LIMIT = 2000;
const SYNC_COOLDOWN_MS = 30_000;
const MAX_LINKS_PER_SYNC = 25;

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
  if (!canManageListings({ role: profile?.role, teamPermissions, customRolePermissions })) {
    return fail(403, "FORBIDDEN", "You don't have permission to manage listings.");
  }
  const accountOwnerId: string = ownerId;
  const isOwner = profile?.role === "owner";

  const args = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(args.action ?? "");
  const nowIso = () => new Date().toISOString();

  // ---- helpers ------------------------------------------------------
  async function loadLinks(filter?: { id?: string; locationId?: string }): Promise<LinkRow[]> {
    let q = admin.from("listing_links").select(LINK_COLUMNS).eq("user_id", accountOwnerId);
    if (filter?.id) q = q.eq("id", filter.id);
    if (filter?.locationId) q = q.eq("location_id", filter.locationId);
    const { data } = await q.order("created_at", { ascending: true }).limit(LINK_LIMIT);
    return (data ?? []) as LinkRow[];
  }

  async function overview(ctxIn?: OwnerContext) {
    const ctx = ctxIn ?? (await loadOwnerContext(admin, accountOwnerId));
    const status = platformStatus();
    const [{ data: connections }, { data: links }, { data: events }] = await Promise.all([
      admin
        .from("listing_connections")
        .select("id, platform, external_id, display_name, status, last_synced_at, last_error")
        .eq("user_id", accountOwnerId)
        .order("created_at", { ascending: true }),
      admin
        .from("listing_links")
        .select("id, location_id, connection_id, platform, external_location_id, mode, state, last_pushed_hash, last_pushed_at, last_checked_at, drift_fields, blocked_reason, last_error, created_at")
        .eq("user_id", accountOwnerId)
        .order("created_at", { ascending: true })
        .limit(LINK_LIMIT),
      admin
        .from("listing_sync_events")
        .select("id, location_id, platform, kind, outcome, fields, detail, created_at")
        .eq("user_id", accountOwnerId)
        .order("created_at", { ascending: false })
        .limit(EVENT_LIMIT),
    ]);

    const locations = [...ctx.locations.values()].map(({ row }) => {
      const canonical = canonicalFor(ctx, row.id)!;
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        is_primary: row.is_primary,
        canonical,
        hash: canonicalHash(canonical),
        issues: validateCanonical(canonical),
      };
    });

    return {
      settings: { auto_sync: ctx.settings.auto_sync, website_url: ctx.settings.website_url, description: ctx.settings.description },
      platforms: (Object.keys(LISTING_CAPS) as ListingPlatform[]).map((p) => ({
        platform: p,
        configured: status[p].configured,
        pushEnabled: status[p].pushEnabled,
        mode: resolveMode(p, status[p]),
        credentials: LISTING_CAPS[p].credentials,
        externalLabel: LISTING_CAPS[p].externalLabel,
        note: LISTING_CAPS[p].note,
      })),
      locations,
      connections: connections ?? [],
      links: links ?? [],
      events: events ?? [],
    };
  }

  try {
    switch (action) {
      case "overview":
        return json(await overview());

      case "save_settings": {
        const websiteRaw = clip(args.websiteUrl, 300);
        const website = websiteRaw ? normalizeWebsite(websiteRaw) : null;
        if (websiteRaw && !website) return fail(400, "INVALID", "Enter a valid website address, like https://example.com.");
        const description = clip(args.description, 750) || null;
        const before = await loadSettings(admin, accountOwnerId);
        const { error } = await admin.from("listing_settings").upsert({
          user_id: accountOwnerId,
          auto_sync: args.autoSync !== false,
          website_url: website,
          description,
          updated_at: nowIso(),
        });
        if (error) throw error;
        if (before.website_url !== website || before.description !== description) {
          await admin.from("listing_links").update({ state: "pending", updated_at: nowIso() }).eq("user_id", accountOwnerId).in("state", ["synced", "drift", "blocked"]);
        }
        return json(await overview());
      }

      case "oauth_start": {
        if (!isOwner) return fail(403, "FORBIDDEN", "Only the account owner can connect directories.");
        if (args.platform !== "facebook") return fail(400, "INVALID", "Unsupported platform.");
        try {
          assertConfigured("facebook");
        } catch {
          return fail(422, "NOT_CONFIGURED", "This integration isn't enabled on this workspace yet.");
        }
        const state = await signState(`${accountOwnerId}~facebook`, Deno.env.get("LISTINGS_STATE_SECRET") ?? "");
        const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/listings-oauth-callback`;
        return json({ url: facebookAuthUrl(redirectUri, state) });
      }

      case "connect_yelp": {
        if (!isOwner) return fail(403, "FORBIDDEN", "Only the account owner can connect directories.");
        try {
          assertConfigured("yelp");
        } catch {
          return fail(422, "NOT_CONFIGURED", "Yelp isn't enabled on this workspace yet.");
        }
        const alias = normalizeYelpAlias(args.businessId);
        if (!alias) return fail(400, "INVALID", "Paste your Yelp business page link or its alias (e.g. acme-hvac-austin).");
        let biz;
        try {
          biz = await lookupYelpBusiness(alias);
        } catch {
          return fail(422, "PROVIDER_ERROR", "Yelp couldn't find that business. Check the link and try again.");
        }
        const { error } = await admin
          .from("listing_connections")
          .upsert({ user_id: accountOwnerId, platform: "yelp", external_id: biz.id, display_name: clip(biz.name, 200) || biz.id, status: "active", last_error: null, updated_at: nowIso() }, { onConflict: "user_id,platform,external_id" });
        if (error) throw error;
        return json(await overview());
      }

      case "disconnect": {
        if (!isOwner) return fail(403, "FORBIDDEN", "Only the account owner can disconnect directories.");
        if (!isUuid(args.connectionId)) return fail(404, "NOT_FOUND", "Connection not found.");
        const { data: conn } = await admin.from("listing_connections").select("id").eq("id", args.connectionId).eq("user_id", accountOwnerId).maybeSingle();
        if (!conn) return fail(404, "NOT_FOUND", "Connection not found.");
        const { error: linkErr } = await admin.from("listing_links").delete().eq("connection_id", conn.id).eq("user_id", accountOwnerId);
        if (linkErr) throw linkErr;
        const { error } = await admin.from("listing_connections").delete().eq("id", conn.id).eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await overview());
      }

      case "link_location": {
        if (!isUuid(args.locationId)) return fail(404, "NOT_FOUND", "Location not found.");
        if (!isListingPlatform(args.platform)) return fail(400, "INVALID", "Choose a directory.");
        const platform: ListingPlatform = args.platform;
        const ctx = await loadOwnerContext(admin, accountOwnerId);
        const loc = ctx.locations.get(args.locationId);
        if (!loc) return fail(404, "NOT_FOUND", "Location not found, or it is archived.");

        const caps = LISTING_CAPS[platform];
        const configured = platformStatus()[platform].configured;
        let connectionId: string | null = null;
        let external: string | null;

        if (caps.credentials === "location_id") {
          const typed = String(args.externalLocationId ?? "").trim();
          external = typed ? normalizeExternalId(typed) : configured ? null : "manual";
          if (!external) return fail(400, "INVALID", `Enter the ${caps.externalLabel} (letters, numbers, dots, dashes and underscores only).`);
        } else if (configured) {
          if (!isUuid(args.connectionId)) return fail(400, "INVALID", "Choose which connected listing to use.");
          const { data: conn } = await admin
            .from("listing_connections")
            .select("id, platform, external_id")
            .eq("id", args.connectionId)
            .eq("user_id", accountOwnerId)
            .maybeSingle();
          if (!conn || conn.platform !== platform) return fail(404, "NOT_FOUND", "That connection no longer exists.");
          connectionId = conn.id;
          external = conn.external_id;
        } else {
          external = "manual";
        }

        const { data: row, error } = await admin
          .from("listing_links")
          .upsert(
            {
              user_id: accountOwnerId,
              location_id: loc.row.id,
              connection_id: connectionId,
              platform,
              external_location_id: external,
              mode: resolveMode(platform, platformStatus()[platform]),
              state: "pending",
              last_pushed_hash: null,
              last_pushed_at: null,
              last_checked_at: null,
              drift_fields: [],
              blocked_reason: null,
              last_error: null,
              updated_at: nowIso(),
            },
            { onConflict: "location_id,platform" },
          )
          .select(LINK_COLUMNS)
          .single();
        if (error || !row) throw error ?? new Error("link upsert failed");
        await logLinkEvent(admin, row as LinkRow, "link", "ok", [], null);
        const result = await processLink(admin, row as LinkRow, ctx, { force: true });
        return json({ ...(await overview(ctx)), sync: [{ linkId: row.id, ...result }] });
      }

      case "unlink_location": {
        if (!isUuid(args.linkId)) return fail(404, "NOT_FOUND", "Listing not found.");
        const [link] = await loadLinks({ id: args.linkId });
        if (!link) return fail(404, "NOT_FOUND", "Listing not found.");
        await logLinkEvent(admin, link, "unlink", "ok", [], null);
        const { error } = await admin.from("listing_links").delete().eq("id", link.id).eq("user_id", accountOwnerId);
        if (error) throw error;
        return json(await overview());
      }

      case "sync": {
        let links: LinkRow[];
        if (args.linkId !== undefined) {
          if (!isUuid(args.linkId)) return fail(404, "NOT_FOUND", "Listing not found.");
          links = await loadLinks({ id: args.linkId });
        } else if (args.locationId !== undefined) {
          if (!isUuid(args.locationId)) return fail(404, "NOT_FOUND", "Location not found.");
          links = await loadLinks({ locationId: args.locationId });
        } else {
          links = await loadLinks();
        }
        if (links.length === 0) return fail(400, "NO_LINKS", "Link a location to a directory first.");
        const due = links.filter((l) => !l.last_checked_at || Date.now() - new Date(l.last_checked_at).getTime() >= SYNC_COOLDOWN_MS);
        if (due.length === 0) return fail(429, "RATE_LIMITED", "Synced a moment ago — try again in a few seconds.");
        const ctx = await loadOwnerContext(admin, accountOwnerId);
        const results = [];
        for (const l of due.slice(0, MAX_LINKS_PER_SYNC)) results.push({ linkId: l.id, ...(await processLink(admin, l, ctx, { force: true })) });
        return json({ ...(await overview(ctx)), sync: results, remaining: Math.max(0, due.length - MAX_LINKS_PER_SYNC) });
      }

      case "confirm_manual": {
        if (!isUuid(args.linkId)) return fail(404, "NOT_FOUND", "Listing not found.");
        const [link] = await loadLinks({ id: args.linkId });
        if (!link) return fail(404, "NOT_FOUND", "Listing not found.");
        const ctx = await loadOwnerContext(admin, accountOwnerId);
        const canonical = canonicalFor(ctx, link.location_id);
        if (!canonical) return fail(404, "NOT_FOUND", "The location for this listing no longer exists.");
        if (resolveMode(link.platform, platformStatus()[link.platform]) !== "manual") {
          return fail(409, "CONFLICT", "This listing is updated or checked automatically — no confirmation needed.");
        }
        if (blockingIssues(validateCanonical(canonical)).length > 0) return fail(409, "CONFLICT", "Complete the missing business details first.");
        const { error } = await admin
          .from("listing_links")
          .update({ state: "synced", mode: "manual", last_pushed_hash: canonicalHash(canonical), last_pushed_at: nowIso(), blocked_reason: null, last_error: null, drift_fields: [], updated_at: nowIso() })
          .eq("id", link.id)
          .eq("user_id", accountOwnerId);
        if (error) throw error;
        await logLinkEvent(admin, link, "manual_confirm", "ok", [], null);
        return json(await overview(ctx));
      }

      default:
        return fail(400, "INVALID", "Unknown action.");
    }
  } catch (error) {
    if (error instanceof NotConfiguredError) return fail(422, "NOT_CONFIGURED", "This integration isn't enabled on this workspace yet.");
    console.error(JSON.stringify({ event: "listings_failed", action, error: error instanceof Error ? error.message : String(error) }));
    return fail(500, "INTERNAL", "Something went wrong. Please try again.");
  }
});
