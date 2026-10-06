// Deploy: supabase functions deploy ads-optimizer
// Body: { action?: "run" | "approve" | "reject" | "revert", recommendation_id?: uuid }
//   cron (X-Cron-Secret)  -> "run" for every account that is not in mode "off"
//   logged-in user        -> run / approve / reject / revert for their own account only
// Modes: off | recommend (proposals wait for a human) | autopilot (applies guard-railed proposals).
import { allocateBudgets, type AllocatorSettings, type CampaignEconomics } from "../_shared/ads/allocator.ts";
import { adminClient, authenticate, corsHeaders, dateOnly, daysAgo, isCron, json, log, type AdAccountRow } from "../_shared/ads/common.ts";
import { setGoogleBudget } from "../_shared/ads/google.ts";
import { setMetaBudget } from "../_shared/ads/meta.ts";
import { tokenFor } from "../_shared/ads/tokens.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "HUF"]); // budget units differ: never touch

const DEFAULTS = {
  mode: "recommend", max_shift_pct: 15, cooldown_days: 7, min_spend_cents: 30000, min_jobs: 5,
  maturation_days: 14, lookback_days: 60, allow_growth: false, total_daily_cap_cents: null as number | null,
};

type Rec = {
  id: string; user_id: string; campaign_id: string; status: string; current_budget_cents: number;
  proposed_budget_cents: number; applyable: boolean; expires_at: string;
};

async function loadCampaignAccount(admin: SupabaseClient, campaignId: string) {
  const { data: c } = await admin.from("ad_campaigns").select("*").eq("id", campaignId).single();
  if (!c) throw new Error("Campaign not found.");
  const { data: a } = await admin.from("ad_accounts").select("id, user_id, platform, external_account_id, login_customer_id, currency").eq("id", c.account_id).single();
  if (!a) throw new Error("Account not found.");
  return { campaign: c, account: a as AdAccountRow };
}

async function pushBudget(admin: SupabaseClient, campaign: any, account: AdAccountRow, cents: number) {
  if (account.platform === "google_lsa" || !campaign.budget_editable) throw new Error("This campaign's budget can't be changed through the API.");
  if (ZERO_DECIMAL.has(account.currency.toUpperCase())) throw new Error(`Budget changes aren't supported for ${account.currency} accounts.`);
  const token = await tokenFor(admin, account);
  if (account.platform === "google_ads") await setGoogleBudget(token, account.external_account_id, account.login_customer_id, campaign.external_budget_ref, cents);
  else await setMetaBudget(token, campaign.external_id, cents);
}

/** Applies one recommendation. Claim-then-act so concurrent approvals can never double-apply. */
async function applyRecommendation(admin: SupabaseClient, recId: string, actor: string): Promise<{ ok: boolean; error?: string }> {
  const { data: claimed } = await admin.from("ad_budget_recommendations")
    .update({ status: "applied", decided_at: new Date().toISOString(), decided_by: actor })
    .eq("id", recId).eq("status", "pending").gt("expires_at", new Date().toISOString()).eq("applyable", true)
    .select("*").maybeSingle();
  if (!claimed) return { ok: false, error: "Recommendation is no longer pending (expired, applied, or advisory-only)." };
  const rec = claimed as Rec;
  const fail = async (error: string) => {
    await admin.from("ad_budget_recommendations").update({ status: "failed", error: error.slice(0, 500) }).eq("id", recId);
    return { ok: false, error };
  };
  try {
    const { campaign, account } = await loadCampaignAccount(admin, rec.campaign_id);
    if (campaign.status !== "enabled") return fail("Campaign is no longer enabled.");
    if (Number(campaign.daily_budget_cents) !== Number(rec.current_budget_cents)) return fail("Budget changed since this was proposed — a new recommendation will follow.");
    await pushBudget(admin, campaign, account, rec.proposed_budget_cents);
    await admin.from("ad_campaigns").update({ daily_budget_cents: rec.proposed_budget_cents, last_budget_change_at: new Date().toISOString() }).eq("id", campaign.id);
    await admin.from("ad_budget_actions").insert({
      user_id: rec.user_id, recommendation_id: rec.id, campaign_id: campaign.id, platform: account.platform,
      old_budget_cents: rec.current_budget_cents, new_budget_cents: rec.proposed_budget_cents, actor, kind: "apply",
    });
    return { ok: true };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function revertRecommendation(admin: SupabaseClient, recId: string, ownerId: string, actor: string) {
  const { data: rec } = await admin.from("ad_budget_recommendations").select("*").eq("id", recId).eq("user_id", ownerId).eq("status", "applied").maybeSingle();
  if (!rec) return { ok: false, error: "Only applied recommendations can be reverted." };
  try {
    const { campaign, account } = await loadCampaignAccount(admin, rec.campaign_id);
    if (Number(campaign.daily_budget_cents) !== Number(rec.proposed_budget_cents)) return { ok: false, error: "Budget has changed since; revert it in the ad platform." };
    await pushBudget(admin, campaign, account, rec.current_budget_cents);
    await admin.from("ad_campaigns").update({ daily_budget_cents: rec.current_budget_cents, last_budget_change_at: new Date().toISOString() }).eq("id", campaign.id);
    await admin.from("ad_budget_recommendations").update({ status: "reverted" }).eq("id", rec.id);
    await admin.from("ad_budget_actions").insert({
      user_id: ownerId, recommendation_id: rec.id, campaign_id: campaign.id, platform: account.platform,
      old_budget_cents: rec.proposed_budget_cents, new_budget_cents: rec.current_budget_cents, actor, kind: "revert",
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function runForOwner(admin: SupabaseClient, ownerId: string, force: boolean) {
  const { data: stored } = await admin.from("demand_os_settings").select("*").eq("user_id", ownerId).maybeSingle();
  const s = { ...DEFAULTS, ...(stored ?? {}) };
  if (s.mode === "off" && !force) return { skipped: "mode_off" };

  const end = daysAgo(s.maturation_days);
  const start = new Date(end.getTime() - s.lookback_days * 86_400_000);
  const { data: econ, error } = await admin.rpc("demand_os_campaign_economics", { p_user_id: ownerId, p_start: dateOnly(start), p_end: dateOnly(end) });
  if (error) throw error;
  const { data: camps } = await admin.from("ad_campaigns").select("*").eq("user_id", ownerId);
  const byId = new Map<string, any>((camps ?? []).map((c: any) => [c.id as string, c] as [string, any]));

  const rows: CampaignEconomics[] = (econ ?? []).flatMap((e: any) => {
    const c = byId.get(e.campaign_id);
    if (!c) return [];
    return [{
      campaignId: c.id, platform: c.platform, name: c.name, market: c.market_label, status: c.status,
      dailyBudgetCents: c.daily_budget_cents, budgetEditable: c.budget_editable, lastBudgetChangeAt: c.last_budget_change_at,
      spendCents: Number(e.spend_cents), leads: Number(e.leads), jobsWon: Number(e.jobs_won),
      revenueCents: Number(e.revenue_cents), grossProfitCents: Number(e.gross_profit_cents),
    }];
  });

  const settings: AllocatorSettings = {
    maxShiftPct: s.max_shift_pct, cooldownDays: s.cooldown_days, minSpendCents: Number(s.min_spend_cents), minJobs: s.min_jobs,
    allowGrowth: s.allow_growth, totalDailyCapCents: s.total_daily_cap_cents === null ? null : Number(s.total_daily_cap_cents),
  };
  const result = allocateBudgets(rows, settings);

  // A new run supersedes older open proposals.
  await admin.from("ad_budget_recommendations").update({ status: "expired" }).eq("user_id", ownerId).eq("status", "pending");
  const runId = crypto.randomUUID();
  let inserted: { id: string; direction: string; applyable: boolean; proposed_budget_cents: number; current_budget_cents: number }[] = [];
  if (result.recommendations.length) {
    const { data, error: insErr } = await admin.from("ad_budget_recommendations").insert(result.recommendations.map((r) => ({
      user_id: ownerId, campaign_id: r.campaignId, run_id: runId, direction: r.direction,
      current_budget_cents: r.currentBudgetCents, proposed_budget_cents: r.proposedBudgetCents,
      applyable: r.applyable, reason: r.reason, evidence: r.evidence,
    }))).select("id, direction, applyable, proposed_budget_cents, current_budget_cents");
    if (insErr) throw insErr;
    inserted = data ?? [];
  }

  let applied = 0;
  if (s.mode === "autopilot" && !force) {
    // Decreases first; increases only spend what the applied decreases actually freed (unless growth is allowed).
    let freed = 0;
    let raised = 0;
    for (const r of inserted.filter((x) => x.applyable && x.direction === "decrease")) {
      if ((await applyRecommendation(admin, r.id, "autopilot")).ok) { applied++; freed += r.current_budget_cents - r.proposed_budget_cents; }
    }
    for (const r of inserted.filter((x) => x.applyable && x.direction === "increase")) {
      const delta = r.proposed_budget_cents - r.current_budget_cents;
      if (!s.allow_growth && raised + delta > freed) continue;
      if ((await applyRecommendation(admin, r.id, "autopilot")).ok) { applied++; raised += delta; }
    }
  }
  return { runId, proposed: inserted.length, applied, skipped: result.skipped.length, portfolio: result.portfolio };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = adminClient();
  const body = await req.json().catch(() => ({}));
  const action: string = body.action ?? "run";

  try {
    if (isCron(req)) {
      const { data: owners } = await admin.from("ad_accounts").select("user_id");
      const unique = [...new Set<string>((owners ?? []).map((o: any) => o.user_id as string))];
      const out: Record<string, unknown> = {};
      for (const o of unique) {
        try { out[o] = await runForOwner(admin, o, false); }
        catch (e) { log("ads_optimizer_failed", { user_id: o, error: e instanceof Error ? e.message : String(e) }); out[o] = { error: "failed" }; }
      }
      return json({ owners: unique.length, out });
    }

    const who = await authenticate(req);
    if (!who) return json({ error: "Unauthorized." }, 401);
    const actor = `user:${who.userId}`;

    if (action === "run") return json(await runForOwner(admin, who.ownerId, true));

    if (who.userId !== who.ownerId) return json({ error: "Only the account owner can change ad budgets." }, 403);
    const id = String(body.recommendation_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "recommendation_id is required." }, 400);
    const { data: rec } = await admin.from("ad_budget_recommendations").select("id, user_id").eq("id", id).maybeSingle();
    if (!rec || rec.user_id !== who.ownerId) return json({ error: "Not found." }, 404);

    if (action === "approve") { const r = await applyRecommendation(admin, id, actor); return json(r, r.ok ? 200 : 409); }
    if (action === "revert") { const r = await revertRecommendation(admin, id, who.ownerId, actor); return json(r, r.ok ? 200 : 409); }
    if (action === "reject") {
      await admin.from("ad_budget_recommendations").update({ status: "rejected", decided_at: new Date().toISOString(), decided_by: actor }).eq("id", id).eq("status", "pending");
      return json({ ok: true });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    log("ads_optimizer_error", { action, error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Something went wrong." }, 500);
  }
});
