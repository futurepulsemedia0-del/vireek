// Thin Microsoft Graph / Microsoft identity platform client (Deno).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { classifyGraphFailure, MS_SCOPES, tokenEndpoint, tokenNeedsRefresh } from "./engine.ts";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | undefined, readonly retryAfterMs: number | null = null) {
    super(message);
  }
  get failure() { return classifyGraphFailure(this.status, this.code); }
}

export interface MsConfig { tenant: string; clientId: string; clientSecret: string }
export interface TokenSet { accessToken: string; refreshToken: string | null; expiresAt: string }

async function postToken(cfg: MsConfig, params: Record<string, string>): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(tokenEndpoint(cfg.tenant), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: MS_SCOPES.join(" "), ...params }),
    });
  } catch (e) {
    throw new GraphError(e instanceof Error ? e.message : "Network error", 0, undefined);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new GraphError(json.error_description ?? json.error ?? "Token request failed", res.status, json.error);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export const exchangeCode = (cfg: MsConfig, code: string, redirectUri: string) =>
  postToken(cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri });

export const refreshTokens = (cfg: MsConfig, refreshToken: string) =>
  postToken(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });

/** Returns a valid access token, refreshing (and persisting the ROTATED refresh token) when needed. */
export async function ensureAccessToken(admin: SupabaseClient, connectionId: string, cfg: MsConfig): Promise<string> {
  const { data, error } = await admin
    .from("microsoft_calendar_secrets")
    .select("access_token, refresh_token, expires_at")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.refresh_token) throw new GraphError("No stored credentials.", 401, "invalid_grant");
  if (!tokenNeedsRefresh(data.expires_at) && data.access_token) return data.access_token;

  const t = await refreshTokens(cfg, data.refresh_token);
  const { error: saveError } = await admin.from("microsoft_calendar_secrets").update({
    access_token: t.accessToken,
    refresh_token: t.refreshToken ?? data.refresh_token,
    expires_at: t.expiresAt,
    updated_at: new Date().toISOString(),
  }).eq("connection_id", connectionId);
  if (saveError) throw new Error(saveError.message);
  return t.accessToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Graph request with retry on 429/503/504 and network errors. Absolute URLs must be on graph.microsoft.com. */
export async function graphRequest<T = any>(
  accessToken: string,
  pathOrUrl: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<T | null> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  if (!url.startsWith("https://graph.microsoft.com/")) throw new GraphError("Refusing to call a non-Graph URL.", 400, "invalid_url");
  const prefer = ['outlook.timezone="UTC"', init.prefer].filter(Boolean).join(", ");

  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: prefer,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      if (attempt >= 2) throw new GraphError(e instanceof Error ? e.message : "Network error", 0, undefined);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);

    const retryAfter = Number(res.headers.get("Retry-After"));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 20) * 1000 : null;
    if ([429, 503, 504].includes(res.status) && attempt < 3) {
      await sleep(retryAfterMs ?? 800 * 2 ** attempt);
      continue;
    }
    const err = await res.json().catch(() => ({}));
    throw new GraphError(err?.error?.message ?? `Graph request failed (${res.status})`, res.status, err?.error?.code, retryAfterMs);
  }
}
