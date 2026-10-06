// Deploy: supabase functions deploy ads-oauth-callback --no-verify-jwt
import { verifyState } from "../_shared/price-book/oauthState.ts";
import { adminClient, encryptToken, log } from "../_shared/ads/common.ts";
import { discoverCustomers, exchangeGoogleCode, lsaAccountReports } from "../_shared/ads/google.ts";
import { exchangeMetaCode, listMetaAdAccounts } from "../_shared/ads/meta.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const site = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");
  const back = (p: Record<string, string>) => {
    const d = new URL(`${site}/dashboard/demand-os`);
    for (const [k, v] of Object.entries(p)) d.searchParams.set(k, v);
    return Response.redirect(d.toString(), 302);
  };

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back({ ads: "error", reason: "denied" });
  if (!code || !state) return back({ ads: "error", reason: "missing_code_or_state" });

  const verified = await verifyState(state, Deno.env.get("ADS_STATE_SECRET") ?? "");
  const [ownerId, platform] = (verified ?? "").split("~");
  if (!ownerId || (platform !== "google" && platform !== "meta")) return back({ ads: "error", reason: "invalid_state" });

  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ads-oauth-callback`;
  const admin = adminClient();

  const saveAccount = async (a: { platform: string; id: string; name: string; currency: string; login?: string | null }, refresh: string | null, access: string, expiresIn: number) => {
    const { data: row, error } = await admin.from("ad_accounts").upsert({
      user_id: ownerId, platform: a.platform, external_account_id: a.id, login_customer_id: a.login ?? null,
      display_name: a.name, currency: a.currency, status: "active", last_error: null,
    }, { onConflict: "user_id,platform,external_account_id" }).select("id").single();
    if (error || !row) throw error ?? new Error("account upsert failed");
    await admin.from("ad_account_credentials").upsert({
      account_id: row.id, user_id: ownerId,
      encrypted_refresh_token: refresh ? await encryptToken(refresh) : null,
      encrypted_access_token: await encryptToken(access),
      access_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    });
  };

  try {
    let count = 0;
    if (platform === "google") {
      const t = await exchangeGoogleCode(code, redirectUri);
      if (!t.refresh_token) return back({ ads: "error", reason: "no_refresh_token" });
      const { customers, managers } = await discoverCustomers(t.access_token);
      for (const c of customers) {
        await saveAccount({ platform: "google_ads", id: c.id, name: c.name, currency: c.currency, login: c.loginCustomerId }, t.refresh_token, t.access_token, t.expires_in);
        count++;
      }
      // LSA is reached through a MANAGER account; add it only if it actually has LSA accounts.
      for (const m of managers) {
        try {
          if ((await lsaAccountReports(t.access_token, m)).length > 0) {
            await saveAccount({ platform: "google_lsa", id: m, name: `Local Services (MCC ${m})`, currency: "USD" }, t.refresh_token, t.access_token, t.expires_in);
            count++;
          }
        } catch { /* no LSA access on this manager */ }
      }
    } else {
      const t = await exchangeMetaCode(code, redirectUri);
      for (const a of await listMetaAdAccounts(t.access_token)) {
        await saveAccount({ platform: "meta_ads", id: a.id, name: a.name, currency: a.currency }, null, t.access_token, t.expires_in);
        count++;
      }
    }
    if (count === 0) return back({ ads: "error", reason: "no_accounts_found" });
    log("ads_connected", { user_id: ownerId, platform, accounts: count });
    return back({ ads: "connected", platform, accounts: String(count) });
  } catch (e) {
    log("ads_oauth_callback_failed", { user_id: ownerId, platform, error: e instanceof Error ? e.message : String(e) });
    return back({ ads: "error", reason: "exchange_failed" });
  }
});
