// supabase/functions/_shared/listings/providers.ts
//
// THE API BOUNDARY for Listing Sync. This is the only file that talks to
// Apple Business Connect, Bing Places, Yelp Fusion and the Facebook Graph API.
// Everything above it (sync, planning, drift, UI) works on the normalized
// Canonical / RemoteListing shapes from engine.ts, so upgrading a provider
// touches only this file.
//
// Fail-closed: every entry point checks platformStatus() first. With keys
// missing a link runs in "manual" (copy & paste) mode and nothing is called.
// Writes are OFF until the operator flips <PLATFORM>_PUSH_ENABLED=true — the
// same safety rail gbp-sync uses (GBP_APPLY_ENABLED).
//
// NOT LIVE-VERIFIED against the real APIs. Re-check before enabling push:
//   Facebook  https://developers.facebook.com/docs/graph-api/reference/page/  (edit needs pages_manage_metadata + App Review)
//   Yelp      https://docs.developer.yelp.com/reference/v3_business_details   (read-only)
//   Apple     Apple Business Connect API (partner access only) — endpoint paths below are
//             configured via APPLE_BC_API_BASE / APPLE_BC_TOKEN_URL and use the neutral shape
//             from engine.toPartnerPayload; confirm the real paths/field names with Apple's partner docs.
//   Bing      Bing Places partner API — same caveat via BING_PLACES_API_BASE.
// Required keys: docs/listings-integrations.md.

import { fetchJson, encryptToken, decryptToken, HttpError } from "../ads/common.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  normalizeFacebookPage,
  normalizePartnerRemote,
  normalizeYelpBusiness,
  toFacebookPayload,
  toPartnerPayload,
  type Canonical,
  type DriftField,
  type LinkMode,
  type LinkState,
  type ListingPlatform,
  type RemoteListing,
} from "./engine.ts";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

const REQUIRED: Record<ListingPlatform, string[]> = {
  apple: ["APPLE_BC_CLIENT_ID", "APPLE_BC_CLIENT_SECRET", "APPLE_BC_TOKEN_URL", "APPLE_BC_API_BASE"],
  bing: ["BING_PLACES_API_KEY", "BING_PLACES_API_BASE"],
  yelp: ["YELP_API_KEY"],
  facebook: ["META_APP_ID", "META_APP_SECRET", "LISTINGS_STATE_SECRET", "ADS_TOKEN_ENCRYPTION_KEY"],
};

const PUSH_FLAG: Record<ListingPlatform, string | null> = {
  apple: "APPLE_BC_PUSH_ENABLED",
  bing: "BING_PLACES_PUSH_ENABLED",
  yelp: null,
  facebook: "FACEBOOK_LISTINGS_PUSH_ENABLED",
};

export interface PlatformStatus {
  configured: boolean;
  pushEnabled: boolean;
  missing: string[];
}

export function platformStatus(): Record<ListingPlatform, PlatformStatus> {
  const out = {} as Record<ListingPlatform, PlatformStatus>;
  for (const p of Object.keys(REQUIRED) as ListingPlatform[]) {
    const missing = REQUIRED[p].filter((k) => !env(k));
    const flag = PUSH_FLAG[p];
    out[p] = { configured: missing.length === 0, pushEnabled: !!flag && env(flag) === "true" && missing.length === 0, missing };
  }
  return out;
}

export class NotConfiguredError extends Error {
  constructor(public platform: ListingPlatform) {
    super(`${platform} integration is not configured on this server.`);
  }
}
export class ReauthRequiredError extends Error {}
export class UnsupportedError extends Error {}

export function assertConfigured(platform: ListingPlatform) {
  if (!platformStatus()[platform].configured) throw new NotConfiguredError(platform);
}

/** 401/403, or a Graph "OAuthException"-style 400, means the stored grant no longer works. */
export function isReauthError(e: unknown): boolean {
  if (e instanceof ReauthRequiredError) return true;
  if (!(e instanceof HttpError)) return false;
  if (e.status === 401 || e.status === 403) return true;
  return e.status === 400 && /access token|session has (expired|been invalidated)|permission|oauth/i.test(e.message);
}

export interface LinkRow {
  id: string;
  user_id: string;
  location_id: string;
  connection_id: string | null;
  platform: ListingPlatform;
  external_location_id: string;
  mode: LinkMode;
  state: LinkState;
  last_pushed_hash: string | null;
  last_pushed_at: string | null;
  last_checked_at: string | null;
}
export const LINK_COLUMNS =
  "id, user_id, location_id, connection_id, platform, external_location_id, mode, state, last_pushed_hash, last_pushed_at, last_checked_at";

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" } });
const trimSlash = (s: string) => s.replace(/\/+$/, "");

// ---------------------------------------------------------------------
// Facebook Pages
// ---------------------------------------------------------------------

const graph = () => `https://graph.facebook.com/${env("META_GRAPH_VERSION") || "v23.0"}`;
export const FACEBOOK_LISTING_SCOPES = "pages_show_list,pages_read_engagement,pages_manage_metadata";
const FB_READ_FIELDS = "name,phone,website,single_line_address,hours,location{street,city,state,zip,country},permanently_closed";

export function facebookAuthUrl(redirectUri: string, state: string): string {
  const u = new URL(`https://www.facebook.com/${env("META_GRAPH_VERSION") || "v23.0"}/dialog/oauth`);
  u.searchParams.set("client_id", env("META_APP_ID"));
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", FACEBOOK_LISTING_SCOPES);
  return u.toString();
}

const fbTokenUrl = (params: Record<string, string>) => {
  const u = new URL(`${graph()}/oauth/access_token`);
  u.searchParams.set("client_id", env("META_APP_ID"));
  u.searchParams.set("client_secret", env("META_APP_SECRET"));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

/** code -> short-lived user token -> long-lived user token (page tokens derived from it don't expire). */
export async function exchangeFacebookCode(code: string, redirectUri: string): Promise<string> {
  const short = await fetchJson<{ access_token: string }>(fbTokenUrl({ code, redirect_uri: redirectUri }), {}, 1);
  const long = await fetchJson<{ access_token: string }>(fbTokenUrl({ grant_type: "fb_exchange_token", fb_exchange_token: short.access_token }), {}, 1);
  return long.access_token;
}

export async function listFacebookPages(userToken: string): Promise<{ id: string; name: string; access_token: string }[]> {
  const r = await fetchJson<{ data?: { id: string; name: string; access_token?: string }[] }>(
    `${graph()}/me/accounts?fields=id,name,access_token&limit=100`,
    { headers: { Authorization: `Bearer ${userToken}` } },
  );
  return (r.data ?? []).filter((p) => p.access_token).map((p) => ({ id: p.id, name: p.name, access_token: p.access_token as string }));
}

async function fetchFacebook(token: string, pageId: string): Promise<RemoteListing> {
  const raw = await fetchJson(`${graph()}/${encodeURIComponent(pageId)}?fields=${encodeURIComponent(FB_READ_FIELDS)}`, { headers: { Authorization: `Bearer ${token}` } });
  return normalizeFacebookPage(raw);
}

async function pushFacebook(token: string, pageId: string, c: Canonical): Promise<DriftField[]> {
  const { fields, body } = toFacebookPayload(c);
  await fetchJson(
    `${graph()}/${encodeURIComponent(pageId)}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) },
    1,
  );
  return fields;
}

// ---------------------------------------------------------------------
// Yelp Fusion (read-only)
// ---------------------------------------------------------------------

const YELP = "https://api.yelp.com/v3";
const yelpHeaders = () => ({ headers: { Authorization: `Bearer ${env("YELP_API_KEY")}`, Accept: "application/json" } });

export async function lookupYelpBusiness(alias: string): Promise<{ id: string; name: string }> {
  const b = await fetchJson<{ id?: string; name?: string }>(`${YELP}/businesses/${encodeURIComponent(alias)}`, yelpHeaders());
  if (!b?.id) throw new Error("Yelp business not found.");
  return { id: b.id, name: b.name || b.id };
}

async function fetchYelp(businessId: string): Promise<RemoteListing> {
  return normalizeYelpBusiness(await fetchJson(`${YELP}/businesses/${encodeURIComponent(businessId)}`, yelpHeaders()));
}

// ---------------------------------------------------------------------
// Apple Business Connect / Bing Places (partner APIs, one set of Vireek credentials)
// ---------------------------------------------------------------------

async function appleToken(): Promise<string> {
  const t = await fetchJson<{ access_token: string }>(
    env("APPLE_BC_TOKEN_URL"),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: env("APPLE_BC_CLIENT_ID"), client_secret: env("APPLE_BC_CLIENT_SECRET") }),
    },
    1,
  );
  if (!t?.access_token) throw new Error("Apple token response had no access_token.");
  return t.access_token;
}

async function partnerRequest(platform: "apple" | "bing", method: "GET" | "PATCH", locationId: string, body?: unknown) {
  const token = platform === "apple" ? await appleToken() : env("BING_PLACES_API_KEY");
  const base = trimSlash(env(platform === "apple" ? "APPLE_BC_API_BASE" : "BING_PLACES_API_BASE"));
  return fetchJson(`${base}/locations/${encodeURIComponent(locationId)}`, { method, ...bearer(token), ...(body ? { body: JSON.stringify(body) } : {}) }, method === "GET" ? 2 : 1);
}

// ---------------------------------------------------------------------
// Credentials vault (Facebook page tokens)
// ---------------------------------------------------------------------

export async function saveCredentials(
  admin: SupabaseClient,
  connectionId: string,
  userId: string,
  creds: { access: string; refresh?: string | null; expiresInSec?: number | null },
) {
  const { error } = await admin.from("listing_connection_credentials").upsert({
    connection_id: connectionId,
    user_id: userId,
    encrypted_access_token: await encryptToken(creds.access),
    encrypted_refresh_token: creds.refresh ? await encryptToken(creds.refresh) : null,
    access_expires_at: creds.expiresInSec ? new Date(Date.now() + creds.expiresInSec * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function accessTokenFor(admin: SupabaseClient, link: LinkRow): Promise<string> {
  if (!link.connection_id) throw new ReauthRequiredError("This listing's connection was removed; reconnect required.");
  const { data: cred } = await admin
    .from("listing_connection_credentials")
    .select("encrypted_access_token, access_expires_at")
    .eq("connection_id", link.connection_id)
    .eq("user_id", link.user_id)
    .maybeSingle();
  if (!cred?.encrypted_access_token) throw new ReauthRequiredError("No credentials stored; reconnect required.");
  const expiresAt = cred.access_expires_at ? new Date(cred.access_expires_at).getTime() : Infinity;
  if (expiresAt - Date.now() <= 120_000) throw new ReauthRequiredError("Token expired; reconnect required.");
  return decryptToken(cred.encrypted_access_token);
}

// ---------------------------------------------------------------------
// Unified read / write used by sync.ts
// ---------------------------------------------------------------------

export async function fetchRemote(admin: SupabaseClient, link: LinkRow): Promise<RemoteListing> {
  assertConfigured(link.platform);
  switch (link.platform) {
    case "facebook":
      return fetchFacebook(await accessTokenFor(admin, link), link.external_location_id);
    case "yelp":
      return fetchYelp(link.external_location_id);
    default:
      return normalizePartnerRemote(await partnerRequest(link.platform, "GET", link.external_location_id));
  }
}

/** Returns the fields that were written. Throws UnsupportedError where the directory has no write API. */
export async function pushListing(admin: SupabaseClient, link: LinkRow, c: Canonical): Promise<DriftField[]> {
  assertConfigured(link.platform);
  if (!platformStatus()[link.platform].pushEnabled) throw new UnsupportedError(`Updates to ${link.platform} are not enabled on this server.`);
  switch (link.platform) {
    case "facebook":
      return pushFacebook(await accessTokenFor(admin, link), link.external_location_id, c);
    case "apple":
    case "bing":
      await partnerRequest(link.platform, "PATCH", link.external_location_id, toPartnerPayload(c));
      return ["name", "phone", "address", "website", "hours", "status"];
    default:
      throw new UnsupportedError(`${link.platform} doesn't support updates through its API.`);
  }
}
