// Meta Marketing API (reporting + campaign budgets) and Conversions API.
// Pin the Graph version with META_GRAPH_VERSION (default "v23.0").
// Secrets: META_APP_ID, META_APP_SECRET

import { fetchJson } from "./common.ts";
import type { CampaignSnapshot } from "./google.ts";

const G = () => `https://graph.facebook.com/${Deno.env.get("META_GRAPH_VERSION") ?? "v23.0"}`;
const DIALOG = () => `https://www.facebook.com/${Deno.env.get("META_GRAPH_VERSION") ?? "v23.0"}/dialog/oauth`;

export function metaAuthUrl(redirectUri: string, state: string): string {
  const u = new URL(DIALOG());
  u.searchParams.set("client_id", Deno.env.get("META_APP_ID") ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", "ads_management,ads_read,business_management");
  return u.toString();
}

const tokenUrl = (params: Record<string, string>) => {
  const u = new URL(`${G()}/oauth/access_token`);
  u.searchParams.set("client_id", Deno.env.get("META_APP_ID") ?? "");
  u.searchParams.set("client_secret", Deno.env.get("META_APP_SECRET") ?? "");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

/** code -> short-lived token -> long-lived (~60 day) token. */
export async function exchangeMetaCode(code: string, redirectUri: string): Promise<{ access_token: string; expires_in: number }> {
  const short = await fetchJson<{ access_token: string }>(tokenUrl({ code, redirect_uri: redirectUri }), {}, 1);
  const long = await fetchJson<{ access_token: string; expires_in?: number }>(
    tokenUrl({ grant_type: "fb_exchange_token", fb_exchange_token: short.access_token }), {}, 1);
  return { access_token: long.access_token, expires_in: long.expires_in ?? 60 * 86_400 };
}

/** Meta has no refresh token: re-exchange the current token (extends it when allowed). */
export async function reExchangeMeta(current: string): Promise<{ access_token: string; expires_in: number }> {
  const r = await fetchJson<{ access_token: string; expires_in?: number }>(tokenUrl({ grant_type: "fb_exchange_token", fb_exchange_token: current }), {}, 1);
  return { access_token: r.access_token, expires_in: r.expires_in ?? 60 * 86_400 };
}

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function paged<T>(url: string, token: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const r: { data?: T[]; paging?: { next?: string } } = await fetchJson(next, auth(token));
    out.push(...(r.data ?? []));
    next = r.paging?.next;
  }
  return out;
}

export async function listMetaAdAccounts(token: string) {
  const rows = await paged<any>(`${G()}/me/adaccounts?fields=account_id,name,currency,account_status&limit=100`, token);
  return rows.filter((a) => a.account_status === 1).map((a) => ({ id: String(a.account_id), name: a.name as string, currency: (a.currency as string) ?? "USD" }));
}

export async function fetchMetaCampaigns(token: string, accountId: string): Promise<CampaignSnapshot[]> {
  const rows = await paged<any>(`${G()}/act_${accountId}/campaigns?fields=id,name,effective_status,daily_budget&limit=200`, token);
  return rows.filter((c) => c.effective_status !== "DELETED" && c.effective_status !== "ARCHIVED").map((c) => ({
    external_id: String(c.id),
    name: c.name,
    status: c.effective_status === "ACTIVE" ? "enabled" : c.effective_status === "PAUSED" ? "paused" : "unknown",
    // daily_budget exists only for campaign-level (CBO) budgets; ad-set budgets are not touched.
    daily_budget_cents: c.daily_budget ? Number(c.daily_budget) : null,
    external_budget_ref: null,
    budget_editable: !!c.daily_budget,
  }));
}

export async function fetchMetaDaily(token: string, accountId: string, since: string, until: string) {
  const range = encodeURIComponent(JSON.stringify({ since, until }));
  const rows = await paged<any>(
    `${G()}/act_${accountId}/insights?level=campaign&time_increment=1&fields=campaign_id,spend,impressions,clicks&time_range=${range}&limit=500`, token);
  return rows.map((r) => ({
    external_id: String(r.campaign_id), day: r.date_start as string,
    impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0),
    cost_cents: Math.round(Number(r.spend ?? 0) * 100),
  }));
}

export async function setMetaBudget(token: string, campaignId: string, newCents: number) {
  await fetchJson(`${G()}/${campaignId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ daily_budget: String(newCents) }),
  }, 1);
}

/** Conversions API. user_data values must already be SHA-256 hashed (lowercased/trimmed first). */
export async function sendMetaPurchases(token: string, pixelId: string, events: {
  eventId: string; eventTime: number; valueUnits: number; currency: string;
  ph?: string; em?: string; fbc?: string; fbp?: string;
}[]) {
  return fetchJson(`${G()}/${pixelId}/events`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: events.map((e) => ({
        event_name: "Purchase", event_time: e.eventTime, event_id: e.eventId, action_source: "system_generated",
        user_data: { ...(e.ph ? { ph: [e.ph] } : {}), ...(e.em ? { em: [e.em] } : {}), ...(e.fbc ? { fbc: e.fbc } : {}), ...(e.fbp ? { fbp: e.fbp } : {}) },
        custom_data: { value: e.valueUnits, currency: e.currency },
      })),
    }),
  }, 1);
}
