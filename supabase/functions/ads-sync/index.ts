// Deploy: supabase functions deploy ads-sync
// Pulls campaigns + daily spend (+ LSA leads) for every connected account, then links leads -> campaigns.
// Callers: cron (X-Cron-Secret, all accounts) or a logged-in user (own accounts only).
import { adminClient, authenticate, corsHeaders, dateOnly, daysAgo, digits10, HttpError, isCron, json, log, type AdAccountRow } from "../_shared/ads/common.ts";
import { fetchGoogleCampaigns, fetchGoogleDaily, lsaLeads } from "../_shared/ads/google.ts";
import { fetchMetaCampaigns, fetchMetaDaily } from "../_shared/ads/meta.ts";
import { tokenFor } from "../_shared/ads/tokens.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const LOOKBACK_DAYS = 45; // re-pull recent days so late-reported spend self-corrects

async function upsertCampaigns(admin: SupabaseClient, acc: AdAccountRow, rows: any[]): Promise<Map<string, string>> {
  if (rows.length) {
    const { error } = await admin.from("ad_campaigns").upsert(
      rows.map((c) => ({ ...c, user_id: acc.user_id, account_id: acc.id, platform: acc.platform, updated_at: new Date().toISOString() })),
      { onConflict: "account_id,external_id", ignoreDuplicates: false },
    );
    if (error) throw error;
  }
  const { data } = await admin.from("ad_campaigns").select("id, external_id").eq("account_id", acc.id);
  return new Map<string, any>((data ?? []).map((r: any) => [r.external_id as string, r.id as string] as [string, string]));
}

async function upsertDaily(admin: SupabaseClient, acc: AdAccountRow, ids: Map<string, string>, rows: any[]) {
  const payload = rows.filter((r) => ids.has(r.external_id)).map((r) => ({
    campaign_id: ids.get(r.external_id), user_id: acc.user_id, day: r.day,
    impressions: r.impressions, clicks: r.clicks, cost_cents: r.cost_cents,
  }));
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await admin.from("ad_campaign_daily").upsert(payload.slice(i, i + 500), { onConflict: "campaign_id,day" });
    if (error) throw error;
  }
}

async function syncAccount(admin: SupabaseClient, acc: AdAccountRow) {
  const since = dateOnly(daysAgo(LOOKBACK_DAYS));
  const until = dateOnly(new Date());

  if (acc.platform === "google_ads") {
    const token = await tokenFor(admin, acc);
    const camps = await fetchGoogleCampaigns(token, acc.external_account_id, acc.login_customer_id);
    const ids = await upsertCampaigns(admin, acc, camps);
    await upsertDaily(admin, acc, ids, await fetchGoogleDaily(token, acc.external_account_id, acc.login_customer_id, since, until));
  } else if (acc.platform === "meta_ads") {
    const token = await tokenFor(admin, acc);
    const camps = await fetchMetaCampaigns(token, acc.external_account_id);
    const ids = await upsertCampaigns(admin, acc, camps);
    await upsertDaily(admin, acc, ids, await fetchMetaDaily(token, acc.external_account_id, since, until));
  } else {
    // google_lsa: leads only. Spend is logged by the owner (the API exposes no per-lead cost).
    const token = await tokenFor(admin, acc);
    const reports = await lsaLeads(token, acc.external_account_id, daysAgo(LOOKBACK_DAYS), new Date());
    const byAccount = new Map<string, any[]>();
    for (const r of reports) byAccount.set(String(r.accountId), [...(byAccount.get(String(r.accountId)) ?? []), r]);
    const camps = [...byAccount.entries()].map(([id, rs]) => ({
      external_id: `lsa:${id}`, name: `LSA — ${rs[0]?.businessName ?? id}`, status: "enabled" as const,
      daily_budget_cents: null, external_budget_ref: null, budget_editable: false,
    }));
    const ids = await upsertCampaigns(admin, acc, camps);
    const leads = reports.flatMap((r) => {
      const campaignId = ids.get(`lsa:${r.accountId}`);
      const phone = r.phoneLead?.consumerPhoneNumber ?? r.messageLead?.consumerPhoneNumber ?? r.bookingLead?.consumerPhoneNumber;
      const created = r.leadCreationTimestamp;
      if (!campaignId || !r.leadId || !created) return [];
      return [{
        user_id: acc.user_id, account_id: acc.id, campaign_id: campaignId, external_lead_id: String(r.leadId),
        lead_type: r.leadType ?? null, consumer_phone_digits: digits10(phone), created_at_platform: created,
      }];
    });
    for (let i = 0; i < leads.length; i += 500) {
      const { error } = await admin.from("ad_lsa_leads").upsert(leads.slice(i, i + 500), { onConflict: "account_id,external_lead_id" });
      if (error) throw error;
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = adminClient();
  let ownerFilter: string | null = null;
  if (!isCron(req)) {
    const who = await authenticate(req);
    if (!who) return json({ error: "Unauthorized." }, 401);
    ownerFilter = who.ownerId;
  }

  let q = admin.from("ad_accounts").select("id, user_id, platform, external_account_id, login_customer_id, currency").neq("status", "needs_reauth");
  if (ownerFilter) q = q.eq("user_id", ownerFilter);
  const { data: accounts, error } = await q;
  if (error) return json({ error: "Could not load accounts." }, 500);

  const results: { account: string; ok: boolean; error?: string }[] = [];
  const owners = new Set<string>();
  for (const acc of (accounts ?? []) as AdAccountRow[]) {
    try {
      await syncAccount(admin, acc);
      await admin.from("ad_accounts").update({ last_synced_at: new Date().toISOString(), last_error: null, status: "active" }).eq("id", acc.id);
      owners.add(acc.user_id);
      results.push({ account: acc.id, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const authFailure = (e instanceof HttpError && e.status === 401) || /invalid_grant|reconnect required|expired/i.test(msg);
      await admin.from("ad_accounts").update({ last_error: msg.slice(0, 500), status: authFailure ? "needs_reauth" : "error" }).eq("id", acc.id);
      log("ads_sync_failed", { account_id: acc.id, platform: acc.platform, error: msg });
      results.push({ account: acc.id, ok: false, error: authFailure ? "reconnect_required" : "sync_failed" });
    }
  }
  let linked = 0;
  for (const owner of owners) {
    const { data } = await admin.rpc("demand_os_link_leads", { p_user_id: owner });
    linked += (data as number) ?? 0;
  }
  return json({ synced: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, leadsLinked: linked, results });
});
