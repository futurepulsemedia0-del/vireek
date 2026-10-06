// One place that knows how to obtain a usable access token per platform.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { decryptToken, encryptToken, getAccessToken, type AdAccountRow } from "./common.ts";
import { refreshGoogleToken } from "./google.ts";
import { reExchangeMeta } from "./meta.ts";

const TEN_DAYS = 10 * 86_400_000;

export async function tokenFor(admin: SupabaseClient, acc: AdAccountRow): Promise<string> {
  if (acc.platform !== "meta_ads") return getAccessToken(admin, acc, refreshGoogleToken);

  const { data: cred } = await admin.from("ad_account_credentials").select("encrypted_access_token, access_expires_at").eq("account_id", acc.id).maybeSingle();
  if (!cred?.encrypted_access_token) throw new Error("No credentials stored; reconnect required.");
  const current = await decryptToken(cred.encrypted_access_token);
  const expiresAt = cred.access_expires_at ? new Date(cred.access_expires_at).getTime() : 0;
  if (expiresAt - Date.now() > TEN_DAYS) return current;
  try {
    // Meta has no refresh token; re-exchanging a long-lived token extends it when Meta allows.
    const fresh = await reExchangeMeta(current);
    await admin.from("ad_account_credentials").update({
      encrypted_access_token: await encryptToken(fresh.access_token),
      access_expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("account_id", acc.id);
    return fresh.access_token;
  } catch (e) {
    if (expiresAt > Date.now()) return current; // still valid: use it, flag nothing yet
    throw new Error(`Meta token expired; reconnect required. ${e instanceof Error ? e.message : ""}`);
  }
}
