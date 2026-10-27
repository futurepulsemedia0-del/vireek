// supabase/functions/_shared/listings/sync.ts
//
// Plans and runs the sync of ONE link (location x directory): validates the
// canonical record, decides push / check / manual / blocked (engine.decideAction),
// calls the provider boundary, then records state, drift and an audit event.
// Used by BOTH the cron-driven listings-sync function and the on-demand
// "Sync now" / "Link" actions of the listings function.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  LISTING_PLATFORM_LABEL,
  DRIFT_FIELD_LABEL,
  blockingIssues,
  buildCanonical,
  canonicalHash,
  compareRemote,
  decideAction,
  manualState,
  resolveMode,
  validateCanonical,
  type Canonical,
  type DriftField,
  type LinkState,
  type SyncAction,
} from "./engine.ts";
import {
  UnsupportedError,
  fetchRemote,
  isReauthError,
  platformStatus,
  pushListing,
  type LinkRow,
} from "./providers.ts";

export interface LocationRow {
  id: string;
  name: string;
  status: string;
  is_primary: boolean;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  business_hours: unknown;
  brand_id: string | null;
}

export interface SettingsRow {
  auto_sync: boolean;
  website_url: string | null;
  description: string | null;
}

export interface OwnerContext {
  settings: SettingsRow;
  locations: Map<string, { row: LocationRow; website: string | null }>;
}

export const DEFAULT_LISTING_SETTINGS: SettingsRow = { auto_sync: true, website_url: null, description: null };

const LOCATION_COLUMNS =
  "id, name, status, is_primary, phone, address_line1, address_line2, city, state, postal_code, country, business_hours, brand_id, brand:business_brands(website_url)";
const MAX_LOCATIONS = 500;

export async function loadSettings(admin: SupabaseClient, ownerId: string): Promise<SettingsRow> {
  const { data } = await admin.from("listing_settings").select("auto_sync, website_url, description").eq("user_id", ownerId).maybeSingle();
  return { ...DEFAULT_LISTING_SETTINGS, ...(data ?? {}) };
}

export async function loadOwnerContext(admin: SupabaseClient, ownerId: string): Promise<OwnerContext> {
  const [settings, { data }] = await Promise.all([
    loadSettings(admin, ownerId),
    admin.from("business_locations").select(LOCATION_COLUMNS).eq("user_id", ownerId).neq("status", "archived").order("created_at", { ascending: true }).limit(MAX_LOCATIONS),
  ]);
  const locations = new Map<string, { row: LocationRow; website: string | null }>();
  for (const raw of (data ?? []) as unknown as (LocationRow & { brand: { website_url: string | null } | { website_url: string | null }[] | null })[]) {
    const brand = Array.isArray(raw.brand) ? raw.brand[0] : raw.brand;
    locations.set(raw.id, { row: raw, website: brand?.website_url ?? null });
  }
  return { settings, locations };
}

export function canonicalFor(ctx: OwnerContext, locationId: string): Canonical | null {
  const loc = ctx.locations.get(locationId);
  return loc ? buildCanonical(loc.row, ctx.settings, loc.website) : null;
}

export interface LinkResult {
  action: SyncAction | "missing_location" | "inactive";
  state: LinkState;
  fields: DriftField[];
  error: string | null;
}

async function logEvent(
  admin: SupabaseClient,
  link: LinkRow,
  kind: "push" | "check" | "manual_confirm" | "link" | "unlink",
  outcome: "ok" | "drift" | "blocked" | "error",
  fields: string[] = [],
  detail: string | null = null,
) {
  await admin.from("listing_sync_events").insert({
    user_id: link.user_id,
    location_id: link.location_id,
    link_id: link.id,
    platform: link.platform,
    kind,
    outcome,
    fields,
    detail: detail ? detail.slice(0, 500) : null,
  });
}

export const logLinkEvent = logEvent;

async function notify(admin: SupabaseClient, link: LinkRow, locationName: string, title: string, message: string) {
  await admin.from("notifications").insert({
    user_id: link.user_id,
    type: "system",
    title,
    message: `${locationName}: ${message}`.slice(0, 500),
    action_url: "/dashboard/listings",
  });
}

export async function processLink(
  admin: SupabaseClient,
  link: LinkRow,
  ctx: OwnerContext,
  opts: { force?: boolean; now?: Date } = {},
): Promise<LinkResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const loc = ctx.locations.get(link.location_id);
  if (!loc) return { action: "missing_location", state: link.state, fields: [], error: null };
  if (loc.row.status !== "active") return { action: "inactive", state: link.state, fields: [], error: null };

  const label = LISTING_PLATFORM_LABEL[link.platform];
  const canonical = buildCanonical(loc.row, ctx.settings, loc.website);
  const hash = canonicalHash(canonical);
  const blocking = blockingIssues(validateCanonical(canonical));
  const mode = resolveMode(link.platform, platformStatus()[link.platform]);

  const update = async (patch: Record<string, unknown>) => {
    await admin.from("listing_links").update({ mode, ...patch, updated_at: nowIso }).eq("id", link.id).eq("user_id", link.user_id);
  };

  const action = decideAction({
    mode,
    state: link.state,
    hasBlocking: blocking.length > 0,
    currentHash: hash,
    lastPushedHash: link.last_pushed_hash,
    lastPushedAt: link.last_pushed_at,
    lastCheckedAt: link.last_checked_at,
    force: opts.force === true,
    now,
  });

  switch (action) {
    case "blocked": {
      const reason = blocking[0]?.message ?? "Missing business details.";
      await update({ state: "blocked", blocked_reason: reason, drift_fields: [] });
      if (link.state !== "blocked") await logEvent(admin, link, "check", "blocked", [], reason);
      return { action, state: "blocked", fields: [], error: null };
    }

    case "manual": {
      const state = manualState(hash, link.last_pushed_hash);
      await update({ state, blocked_reason: null, drift_fields: [], last_error: null });
      return { action, state, fields: [], error: null };
    }

    case "skip": {
      if (mode !== link.mode) await update({});
      return { action, state: link.state, fields: [], error: null };
    }

    case "push": {
      try {
        const sent = await pushListing(admin, link, canonical);
        await update({ state: "synced", last_pushed_hash: hash, last_pushed_at: nowIso, last_checked_at: nowIso, drift_fields: [], blocked_reason: null, last_error: null });
        await logEvent(admin, link, "push", "ok", sent);
        if (link.connection_id) {
          await admin.from("listing_connections").update({ status: "active", last_error: null, last_synced_at: nowIso, updated_at: nowIso }).eq("id", link.connection_id).eq("user_id", link.user_id);
        }
        return { action, state: "synced", fields: sent, error: null };
      } catch (e) {
        return await failLink(admin, link, loc.row.name, e, label, "push", update, nowIso);
      }
    }

    case "check": {
      try {
        const remote = await fetchRemote(admin, link);
        const drift = compareRemote(canonical, remote);
        const snapshot = JSON.parse(JSON.stringify(remote));
        if (drift.length === 0) {
          await update({ state: "synced", last_pushed_hash: hash, last_checked_at: nowIso, drift_fields: [], remote_snapshot: snapshot, blocked_reason: null, last_error: null });
          if (link.state === "drift") await logEvent(admin, link, "check", "ok", [], "Listing matches again.");
          return { action, state: "synced", fields: [], error: null };
        }
        await update({ state: "drift", last_pushed_hash: hash, last_checked_at: nowIso, drift_fields: drift, remote_snapshot: snapshot, blocked_reason: null, last_error: null });
        if (link.state !== "drift") {
          await logEvent(admin, link, "check", "drift", drift);
          await notify(admin, link, loc.row.name, `${label} listing is out of date`, `${drift.map((f) => DRIFT_FIELD_LABEL[f]).join(", ")} no longer match your business details.`);
        }
        return { action, state: "drift", fields: drift, error: null };
      } catch (e) {
        return await failLink(admin, link, loc.row.name, e, label, "check", update, nowIso);
      }
    }
  }
}

async function failLink(
  admin: SupabaseClient,
  link: LinkRow,
  locationName: string,
  e: unknown,
  label: string,
  kind: "push" | "check",
  update: (patch: Record<string, unknown>) => Promise<void>,
  nowIso: string,
): Promise<LinkResult> {
  const reauth = isReauthError(e);
  const unsupported = e instanceof UnsupportedError;
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const state: LinkState = reauth ? "needs_reauth" : "error";
  await update({ state, last_checked_at: nowIso, last_error: message });
  await logEvent(admin, link, kind, "error", [], message);
  if (reauth && link.connection_id) {
    await admin.from("listing_connections").update({ status: "needs_reauth", last_error: message, updated_at: nowIso }).eq("id", link.connection_id).eq("user_id", link.user_id);
  }
  if (link.state !== state && !unsupported) {
    await notify(admin, link, locationName, reauth ? `Reconnect ${label}` : `${label} sync failed`, reauth ? `Vireek lost access to this ${label} listing. Reconnect to resume syncing.` : message);
  }
  return { action: "check", state, fields: [], error: message };
}
