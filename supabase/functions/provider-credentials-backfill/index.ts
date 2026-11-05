// supabase/functions/provider-credentials-backfill/index.ts
//
// ONE-OFF, idempotent migration of legacy plaintext credentials into the encrypted vault (provider_credentials):
//   - price_book_connections: jobber_access_token, jobber_refresh_token, st_client_secret, st_app_key, hcp_api_key
//   - integrations (hubspot, google_calendar): config.access_token / config.refresh_token
// It COPIES only (never nulls, never overwrites newer vault values). Scrub the plaintext afterwards with the SQL in
// docs/runbooks/provider-credentials-migration.md once the counts below are verified.
//
// Call (no JWT; authenticated by the shared cron secret, compared in constant time):
//   curl -X POST https://<ref>.supabase.co/functions/v1/provider-credentials-backfill -H "X-Cron-Secret: $CRON_SECRET"
// Secrets: PROVIDER_CREDENTIALS_KEY, CRON_SECRET (existing).
// Deploy:  supabase functions deploy provider-credentials-backfill --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { saveSecrets, credentialKeysFromEnv, type CredentialProvider } from "../_shared/secrets/providerCredentials.ts";
import { timingSafeEqualStr } from "../_shared/price-book/jobberWebhookSignature.ts";

const PAGE = 200;

interface PriceBookRow {
  user_id: string;
  provider: string;
  jobber_access_token: string | null;
  jobber_refresh_token: string | null;
  st_client_secret: string | null;
  st_app_key: string | null;
  hcp_api_key: string | null;
}
interface IntegrationRow {
  user_id: string;
  integration_type: string;
  config: Record<string, unknown> | null;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || !timingSafeEqualStr(req.headers.get("X-Cron-Secret") ?? "", secret)) return json({ error: "Forbidden" }, 403);

  let keys: string[];
  try {
    keys = credentialKeysFromEnv();
  } catch {
    return json({ error: "PROVIDER_CREDENTIALS_KEY is not configured." }, 503);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const stats = { price_book_migrated: 0, integrations_migrated: 0, failed: 0 };

  // --- price_book_connections (keyset pagination on id) ---
  let lastId = "";
  for (;;) {
    let q = admin
      .from("price_book_connections")
      .select("id, user_id, provider, jobber_access_token, jobber_refresh_token, st_client_secret, st_app_key, hcp_api_key")
      .or("jobber_access_token.not.is.null,jobber_refresh_token.not.is.null,st_client_secret.not.is.null,st_app_key.not.is.null,hcp_api_key.not.is.null")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) return json({ error: "read_failed", stats }, 500);
    const rows = (data ?? []) as Array<PriceBookRow & { id: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      try {
        await saveSecrets(
          admin,
          r.user_id,
          r.provider as CredentialProvider,
          {
            jobber_access_token: r.jobber_access_token,
            jobber_refresh_token: r.jobber_refresh_token,
            st_client_secret: r.st_client_secret,
            st_app_key: r.st_app_key,
            hcp_api_key: r.hcp_api_key,
          },
          { preferExisting: true, keys },
        );
        stats.price_book_migrated++;
      } catch (err) {
        stats.failed++;
        console.error(JSON.stringify({ event: "credential_backfill_failed", table: "price_book_connections", provider: r.provider, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE) break;
  }

  // --- integrations (hubspot, google_calendar) ---
  for (const type of ["hubspot", "google_calendar"] as const) {
    let from = 0;
    for (;;) {
      const { data, error } = await admin
        .from("integrations")
        .select("user_id, integration_type, config")
        .eq("integration_type", type)
        .order("user_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return json({ error: "read_failed", stats }, 500);
      const rows = (data ?? []) as IntegrationRow[];
      for (const r of rows) {
        const cfg = r.config ?? {};
        const access = typeof cfg.access_token === "string" ? cfg.access_token : null;
        const refresh = typeof cfg.refresh_token === "string" ? cfg.refresh_token : null;
        if (!access && !refresh) continue;
        try {
          await saveSecrets(admin, r.user_id, type, { access_token: access, refresh_token: refresh }, { preferExisting: true, keys });
          stats.integrations_migrated++;
        } catch (err) {
          stats.failed++;
          console.error(JSON.stringify({ event: "credential_backfill_failed", table: "integrations", provider: type, error: err instanceof Error ? err.message : String(err) }));
        }
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  }

  return json({ ok: stats.failed === 0, stats });
});
