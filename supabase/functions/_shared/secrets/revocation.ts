// supabase/functions/_shared/secrets/revocation.ts
//
// Best-effort revocation of a connection AT THE PROVIDER, called by provider-disconnect BEFORE the local credentials
// are deleted. Only mechanisms documented by the provider are implemented; everything else is reported honestly as
// "unsupported" so the UI can tell the user what to do manually.
//
//   google_calendar / google_business_profile  POST https://oauth2.googleapis.com/revoke (RFC 7009)
//       https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
//   jobber           GraphQL mutation `appDisconnect` with the access token (invalidates the connection's tokens)
//       https://developer.getjobber.com/docs/building_your_app/app_authorization  (section "User disconnects from your app")
//   hubspot          DELETE https://api.hubapi.com/oauth/v1/refresh-tokens/{token}
//       https://developers.hubspot.com/docs/api-reference/auth-oauth-v1/refresh-tokens/delete-oauth-v1-refresh-tokens-token
//       HubSpot documents that this removes ONLY the refresh token: already-issued access tokens keep working until they
//       expire and the app stays installed in the HubSpot account. => outcome "revoked" but manualActionRequired=true.
//   service_titan    NO revocation endpoint is documented (client-credentials grant; the customer owns the credentials in
//                    their tenant). => "unsupported".
//   housecall_pro    NO revocation endpoint is documented; an account admin deletes the key under
//                    My Apps -> API Key Management (https://help.housecallpro.com/en/articles/8505035-api-overview). => "unsupported".
//
// Docs were read on the date of implementation; re-verify before relying on them in an audit [VERIFY].
//
// SECURITY: tokens are only ever placed in request bodies / URL path of the provider call. `detail` is a stable code
// (status numbers and fixed strings only) and never contains a token, a provider response body or an exception message.
// This module is pure (no Deno globals), so it runs in Vitest.

import type { CredentialProvider, SecretBag } from "./providerCredentials.ts";

export type RevocationOutcome = "revoked" | "failed" | "unsupported" | "no_credentials";

export interface RevocationResult {
  outcome: RevocationOutcome;
  /** Stable machine code, safe to log and return to the client. */
  detail: string;
  /** True when the user must still do something at the provider for the access to be fully removed. */
  manualActionRequired: boolean;
}

export interface RevocationDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /**
   * Jobber only: exchanges a refresh token for a fresh access token (used when the stored access token is missing or
   * rejected). Must never throw token material; return null when it cannot refresh.
   */
  refreshJobberAccessToken?: (refreshToken: string) => Promise<string | null>;
}

const DEFAULT_TIMEOUT_MS = 8000;

const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const HUBSPOT_REFRESH_TOKEN_URL = "https://api.hubapi.com/oauth/v1/refresh-tokens/";
const JOBBER_GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
// Keep in sync with JOBBER_API_VERSION in ../price-book/jobber.ts (duplicated so this module stays dependency-free).
const JOBBER_API_VERSION = "2025-04-16";

const JOBBER_DISCONNECT_MUTATION = `mutation Disconnect { appDisconnect { app { name } userErrors { message } } }`;

const done = (outcome: RevocationOutcome, detail: string, manualActionRequired = false): RevocationResult => ({ outcome, detail, manualActionRequired });

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------------------------------------- Google

async function revokeGoogle(bag: SecretBag, deps: Required<Pick<RevocationDeps, "fetchFn" | "timeoutMs">>): Promise<RevocationResult> {
  // Revoking the refresh token also invalidates the access tokens issued from it.
  const token = nonEmpty(bag.refresh_token) ?? nonEmpty(bag.access_token);
  if (!token) return done("no_credentials", "google_no_token");
  try {
    const res = await deps.fetchFn(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (res.ok) return done("revoked", "google_revoked");
    // RFC 7009 / Google: an already expired or revoked token answers 400 invalid_token => nothing left to revoke.
    if (res.status === 400) {
      const body = await safeJson(res);
      if (body?.error === "invalid_token") return done("revoked", "google_token_already_invalid");
    }
    return done("failed", `google_http_${res.status}`);
  } catch {
    return done("failed", "google_network_error");
  }
}

// ----------------------------------------------------------------------------------------------------------- HubSpot

async function revokeHubspot(bag: SecretBag, deps: Required<Pick<RevocationDeps, "fetchFn" | "timeoutMs">>): Promise<RevocationResult> {
  const refresh = nonEmpty(bag.refresh_token);
  // HubSpot offers no endpoint to revoke an access token, so without a refresh token there is nothing we can do remotely.
  if (!refresh) return done("no_credentials", "hubspot_no_refresh_token", true);
  try {
    const res = await deps.fetchFn(`${HUBSPOT_REFRESH_TOKEN_URL}${encodeURIComponent(refresh)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    // 204 = deleted. 404 = HubSpot does not know the token (already removed/invalid).
    if (res.status === 204 || res.ok) return done("revoked", "hubspot_refresh_token_deleted", true);
    if (res.status === 404) return done("revoked", "hubspot_token_already_invalid", true);
    return done("failed", `hubspot_http_${res.status}`, true);
  } catch {
    return done("failed", "hubspot_network_error", true);
  }
}

// ----------------------------------------------------------------------------------------------------------- Jobber

type JobberAttempt = "ok" | "auth" | "failed_throttled" | "failed";

async function callJobberDisconnect(accessToken: string, deps: Required<Pick<RevocationDeps, "fetchFn" | "timeoutMs">>): Promise<{ kind: JobberAttempt; detail: string }> {
  try {
    const res = await deps.fetchFn(JOBBER_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: JOBBER_DISCONNECT_MUTATION }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (res.status === 401) return { kind: "auth", detail: "jobber_http_401" };
    if (!res.ok) return { kind: "failed", detail: `jobber_http_${res.status}` };
    const body = await safeJson(res);
    const errors = Array.isArray(body?.errors) ? (body?.errors as Array<{ extensions?: { code?: unknown } }>) : [];
    if (errors.length > 0) {
      const code = errors[0]?.extensions?.code;
      if (code === "THROTTLED") return { kind: "failed_throttled", detail: "jobber_throttled" };
      if (code === "UNAUTHENTICATED") return { kind: "auth", detail: "jobber_unauthenticated" };
      return { kind: "failed", detail: "jobber_graphql_error" };
    }
    const data = body?.data as { appDisconnect?: { userErrors?: unknown } | null } | undefined;
    if (!data?.appDisconnect) return { kind: "failed", detail: "jobber_unexpected_response" };
    const userErrors = data.appDisconnect.userErrors;
    if (Array.isArray(userErrors) && userErrors.length > 0) return { kind: "failed", detail: "jobber_user_errors" };
    return { kind: "ok", detail: "jobber_app_disconnected" };
  } catch {
    return { kind: "failed", detail: "jobber_network_error" };
  }
}

async function revokeJobber(bag: SecretBag, deps: Required<Pick<RevocationDeps, "fetchFn" | "timeoutMs">> & Pick<RevocationDeps, "refreshJobberAccessToken">): Promise<RevocationResult> {
  const access = nonEmpty(bag.jobber_access_token);
  const refresh = nonEmpty(bag.jobber_refresh_token);
  if (!access && !refresh) return done("no_credentials", "jobber_no_token");

  // Access tokens live ~60 minutes, so the stored one is often expired: try it first, then fall back to a refresh.
  if (access) {
    const first = await callJobberDisconnect(access, deps);
    if (first.kind === "ok") return done("revoked", first.detail);
    if (first.kind !== "auth") return done("failed", first.detail);
  }
  if (!refresh || !deps.refreshJobberAccessToken) return done("failed", "jobber_token_rejected_no_refresh");
  let fresh: string | null = null;
  try {
    fresh = await deps.refreshJobberAccessToken(refresh);
  } catch {
    fresh = null;
  }
  if (!fresh) return done("failed", "jobber_refresh_failed");
  const second = await callJobberDisconnect(fresh, deps);
  return second.kind === "ok" ? done("revoked", second.detail) : done("failed", second.detail);
}

// --------------------------------------------------------------------------------------------------------- Dispatch

export async function revokeProviderAccess(provider: CredentialProvider, bag: SecretBag, deps: RevocationDeps = {}): Promise<RevocationResult> {
  const resolved = { fetchFn: deps.fetchFn ?? fetch, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  switch (provider) {
    case "google_calendar":
    case "google_business_profile":
      return revokeGoogle(bag, resolved);
    case "hubspot":
      return revokeHubspot(bag, resolved);
    case "jobber":
      return revokeJobber(bag, { ...resolved, refreshJobberAccessToken: deps.refreshJobberAccessToken });
    case "service_titan":
      return done("unsupported", "servicetitan_no_revocation_endpoint", true);
    case "housecall_pro":
      return done("unsupported", "housecallpro_no_revocation_endpoint", true);
    default: {
      void (provider satisfies never);
      return done("unsupported", "unknown_provider", true);
    }
  }
}
