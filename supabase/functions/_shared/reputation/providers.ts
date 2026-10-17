// supabase/functions/_shared/reputation/providers.ts
//
// THE API BOUNDARY for Reputation Management. This is the only file that
// talks to Google Business Profile, Yelp Fusion and the Facebook Graph API.
// Everything above it (sync, inbox, AI drafting, alerts, trends) works on
// normalized reviews, so swapping/upgrading a provider touches only this file.
//
// Fail-closed: every entry point checks platformConfig() first; with keys
// missing the UI shows "not enabled on this workspace" and nothing is called.
//
// NOT LIVE-VERIFIED against the real APIs. Endpoints and payload shapes follow
// each provider's documentation as last known — re-check before production:
//   Google  https://developers.google.com/my-business/reference/rest  (Business Profile APIs;
//           review endpoints live on mybusiness.googleapis.com v4 and need Google's access approval)
//   Yelp    https://docs.developer.yelp.com/reference/v3_business_reviews  (Fusion; 3 excerpts, read-only)
//   Meta    https://developers.facebook.com/docs/graph-api/reference/page/ratings/  (Page ratings;
//           needs app review for pages_read_user_content)
// Required keys are documented in docs/reputation-integrations.md.

import { fetchJson, encryptToken, decryptToken } from "../ads/common.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  normalizeFacebookRating,
  normalizeGoogleReview,
  normalizeYelpReview,
  type NormalizedReview,
  type Platform,
} from "./engine.ts";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

/** Which env keys each platform needs (names only; never values). */
const REQUIRED: Record<Platform, string[]> = {
  google: ["GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_SECRET", "REPUTATION_STATE_SECRET", "ADS_TOKEN_ENCRYPTION_KEY"],
  facebook: ["META_APP_ID", "META_APP_SECRET", "REPUTATION_STATE_SECRET", "ADS_TOKEN_ENCRYPTION_KEY"],
  yelp: ["YELP_API_KEY"],
};

export function platformConfig(): Record<Platform, { configured: boolean; missing: string[] }> {
  const out = {} as Record<Platform, { configured: boolean; missing: string[] }>;
  for (const p of Object.keys(REQUIRED) as Platform[]) {
    const missing = REQUIRED[p].filter((k) => !env(k));
    out[p] = { configured: missing.length === 0, missing };
  }
  return out;
}

export class NotConfiguredError extends Error {
  constructor(public platform: Platform) {
    super(`${platform} integration is not configured on this server.`);
  }
}
export class ReauthRequiredError extends Error {}
export class UnsupportedError extends Error {}

export function assertConfigured(platform: Platform) {
  if (!platformConfig()[platform].configured) throw new NotConfiguredError(platform);
}

// ---------------------------------------------------------------------
// Google Business Profile
// ---------------------------------------------------------------------

const G_ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const G_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const G_V4 = "https://mybusiness.googleapis.com/v4";
export const GOOGLE_BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

export function googleAuthUrl(redirectUri: string, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env("GOOGLE_BUSINESS_CLIENT_ID"));
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_BUSINESS_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}

const googleToken = (params: Record<string, string>) =>
  fetchJson<{ access_token: string; expires_in: number; refresh_token?: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GOOGLE_BUSINESS_CLIENT_ID"), client_secret: env("GOOGLE_BUSINESS_CLIENT_SECRET"), ...params }),
  }, 1);

export const exchangeGoogleCode = (code: string, redirectUri: string) =>
  googleToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
const refreshGoogle = (refresh_token: string) => googleToken({ grant_type: "refresh_token", refresh_token });

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

/** Every location the user manages, as `accounts/{a}/locations/{l}` (the path the v4 review API wants). */
export async function listGoogleLocations(token: string): Promise<{ id: string; name: string }[]> {
  const accounts = await fetchJson<{ accounts?: { name: string }[] }>(`${G_ACCOUNTS}/accounts?pageSize=20`, bearer(token));
  const out: { id: string; name: string }[] = [];
  for (const a of accounts.accounts ?? []) {
    let pageToken = "";
    do {
      const url = `${G_INFO}/${a.name}/locations?readMask=name,title&pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const r = await fetchJson<{ locations?: { name: string; title?: string }[]; nextPageToken?: string }>(url, bearer(token));
      for (const l of r.locations ?? []) out.push({ id: `${a.name}/${l.name}`, name: l.title || l.name });
      pageToken = r.nextPageToken ?? "";
    } while (pageToken && out.length < 500);
  }
  return out;
}

export async function fetchGoogleReviews(token: string, externalId: string, maxPages = 5): Promise<NormalizedReview[]> {
  const out: NormalizedReview[] = [];
  let pageToken = "";
  for (let i = 0; i < maxPages; i++) {
    const url = `${G_V4}/${externalId}/reviews?pageSize=50&orderBy=updateTime%20desc${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const r = await fetchJson<{ reviews?: unknown[]; nextPageToken?: string }>(url, bearer(token));
    for (const raw of r.reviews ?? []) {
      const n = normalizeGoogleReview(raw);
      if (n) out.push(n);
    }
    pageToken = r.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}

export async function postGoogleReply(token: string, externalId: string, reviewId: string, comment: string): Promise<void> {
  await fetchJson(`${G_V4}/${externalId}/reviews/${encodeURIComponent(reviewId)}/reply`, {
    method: "PUT",
    ...bearer(token),
    body: JSON.stringify({ comment }),
  }, 1);
}

// ---------------------------------------------------------------------
// Yelp Fusion (read-only, 3 excerpts)
// ---------------------------------------------------------------------

const YELP = "https://api.yelp.com/v3";
const yelpHeaders = () => ({ headers: { Authorization: `Bearer ${env("YELP_API_KEY")}`, Accept: "application/json" } });

export async function lookupYelpBusiness(businessId: string): Promise<{ id: string; name: string }> {
  const b = await fetchJson<{ id?: string; name?: string }>(`${YELP}/businesses/${encodeURIComponent(businessId)}`, yelpHeaders());
  if (!b?.id) throw new Error("Yelp business not found.");
  return { id: b.id, name: b.name || b.id };
}

export async function fetchYelpReviews(businessId: string): Promise<NormalizedReview[]> {
  const r = await fetchJson<{ reviews?: unknown[] }>(`${YELP}/businesses/${encodeURIComponent(businessId)}/reviews?limit=3&sort_by=newest`, yelpHeaders());
  return (r.reviews ?? []).map(normalizeYelpReview).filter((x): x is NormalizedReview => !!x);
}

// ---------------------------------------------------------------------
// Facebook Pages
// ---------------------------------------------------------------------

const graph = () => `https://graph.facebook.com/${env("META_GRAPH_VERSION") || "v23.0"}`;
export const FACEBOOK_SCOPES = "pages_show_list,pages_read_engagement,pages_read_user_content";

export function facebookAuthUrl(redirectUri: string, state: string): string {
  const u = new URL(`https://www.facebook.com/${env("META_GRAPH_VERSION") || "v23.0"}/dialog/oauth`);
  u.searchParams.set("client_id", env("META_APP_ID"));
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", FACEBOOK_SCOPES);
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

export async function fetchFacebookRatings(pageToken: string, pageId: string): Promise<NormalizedReview[]> {
  const url = `${graph()}/${encodeURIComponent(pageId)}/ratings?fields=created_time,recommendation_type,review_text,reviewer{id,name},rating,open_graph_story{id}&limit=50`;
  const r = await fetchJson<{ data?: unknown[] }>(url, { headers: { Authorization: `Bearer ${pageToken}` } });
  return (r.data ?? []).map(normalizeFacebookRating).filter((x): x is NormalizedReview => !!x);
}

// ---------------------------------------------------------------------
// Credentials vault + unified fetch / reply
// ---------------------------------------------------------------------

export interface ConnectionRow {
  id: string;
  user_id: string;
  platform: Platform;
  external_id: string;
  display_name: string;
}

export async function saveCredentials(
  admin: SupabaseClient,
  connectionId: string,
  userId: string,
  creds: { access: string; refresh?: string | null; expiresInSec?: number | null },
) {
  const { error } = await admin.from("review_connection_credentials").upsert({
    connection_id: connectionId,
    user_id: userId,
    encrypted_access_token: await encryptToken(creds.access),
    encrypted_refresh_token: creds.refresh ? await encryptToken(creds.refresh) : null,
    access_expires_at: creds.expiresInSec ? new Date(Date.now() + creds.expiresInSec * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/** A usable access token for the connection; refreshes Google automatically, flags re-auth otherwise. */
export async function accessTokenFor(admin: SupabaseClient, conn: ConnectionRow): Promise<string> {
  const { data: cred } = await admin.from("review_connection_credentials").select("*").eq("connection_id", conn.id).maybeSingle();
  if (!cred?.encrypted_access_token) throw new ReauthRequiredError("No credentials stored; reconnect required.");
  const expiresAt = cred.access_expires_at ? new Date(cred.access_expires_at).getTime() : Infinity;
  if (expiresAt - Date.now() > 120_000) return decryptToken(cred.encrypted_access_token);
  if (conn.platform !== "google" || !cred.encrypted_refresh_token) throw new ReauthRequiredError("Token expired; reconnect required.");
  const fresh = await refreshGoogle(await decryptToken(cred.encrypted_refresh_token));
  await saveCredentials(admin, conn.id, conn.user_id, {
    access: fresh.access_token,
    refresh: await decryptToken(cred.encrypted_refresh_token),
    expiresInSec: fresh.expires_in,
  });
  return fresh.access_token;
}

export async function fetchReviewsFor(admin: SupabaseClient, conn: ConnectionRow): Promise<NormalizedReview[]> {
  assertConfigured(conn.platform);
  if (conn.platform === "yelp") return fetchYelpReviews(conn.external_id);
  const token = await accessTokenFor(admin, conn);
  return conn.platform === "google" ? fetchGoogleReviews(token, conn.external_id) : fetchFacebookRatings(token, conn.external_id);
}

export async function postReplyFor(
  admin: SupabaseClient,
  conn: ConnectionRow,
  reviewExternalId: string,
  text: string,
): Promise<void> {
  assertConfigured(conn.platform);
  if (conn.platform !== "google") throw new UnsupportedError(`${conn.platform} doesn't support replying through its API.`);
  await postGoogleReply(await accessTokenFor(admin, conn), conn.external_id, reviewExternalId, text);
}
