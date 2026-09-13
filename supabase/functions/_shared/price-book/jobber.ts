// Jobber: OAuth2 authorization_code grant + GraphQL API. Verify
// JOBBER_API_VERSION and the `products` query field names against
// https://developer.getjobber.com/docs/ (GraphiQL explorer) before
// production use.

import type { NormalizedPriceItem } from "./types.ts";

const JOBBER_API_VERSION = "2025-04-16";
const JOBBER_TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";

export interface JobberTokenState {
  access_token: string;
  refresh_token: string;
  expires_at: string | null;
}

export interface JobberRefreshResult {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export async function exchangeJobberCode(code: string, redirectUri: string): Promise<JobberRefreshResult> {
  const clientId = Deno.env.get("JOBBER_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("JOBBER_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) throw new Error("jobber_not_configured");

  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`jobber_code_exchange_http_${res.status}`);
  const json = await res.json();
  if (!json?.access_token || !json?.refresh_token) throw new Error("jobber_code_exchange_missing_tokens");

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export async function refreshJobberTokenIfNeeded(state: JobberTokenState): Promise<JobberRefreshResult | null> {
  const expiresAt = state.expires_at ? new Date(state.expires_at).getTime() : 0;
  const stillValid = expiresAt - Date.now() > 5 * 60 * 1000;
  if (stillValid) return null;

  const clientId = Deno.env.get("JOBBER_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("JOBBER_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) throw new Error("jobber_not_configured");

  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: state.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`jobber_refresh_http_${res.status}`);
  const json = await res.json();
  if (!json?.access_token || !json?.refresh_token) throw new Error("jobber_refresh_missing_tokens");

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export async function fetchJobberProducts(accessToken: string): Promise<NormalizedPriceItem[]> {
  const query = `
    query PriceBookSync($cursor: String) {
      products(first: 100, after: $cursor) {
        nodes { id name category defaultUnitCost }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const items: NormalizedPriceItem[] = [];
  let cursor: string | null = null;

  while (true) {
    const res = await fetch(JOBBER_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { cursor } }),
    });
    if (!res.ok) throw new Error(`jobber_graphql_http_${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`jobber_graphql_error_${json.errors[0]?.message ?? "unknown"}`);

    const conn = json.data?.products;
    for (const node of conn?.nodes ?? []) {
      if (typeof node.defaultUnitCost !== "number" || typeof node.name !== "string") continue;
      items.push({
        external_id: String(node.id),
        service_name: node.name,
        category: typeof node.category === "string" ? node.category : null,
        price_cents: Math.round(node.defaultUnitCost * 100),
        active: true,
      });
    }

    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return items;
}
