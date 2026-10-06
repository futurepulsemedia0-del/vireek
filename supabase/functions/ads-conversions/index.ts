// Deploy: supabase functions deploy ads-conversions
// Sends COMPLETED + PAID job value (gross profit by default) back to Google Ads and Meta so their
// bidding learns what a profitable job looks like. Idempotent: one event per (job, platform).
// Body: { dry_run?: boolean }  — dry_run uses Google's validateOnly and changes no state. Run it first.
import { adminClient, authenticate, corsHeaders, digits10, isCron, json, log, sha256Hex, type AdAccountRow } from "../_shared/ads/common.ts";
import { ingestGoogleConversions } from "../_shared/ads/google.ts";
import { sendMetaPurchases } from "../_shared/ads/meta.ts";
import { tokenFor } from "../_shared/ads/tokens.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const BATCH = 200;
const MAX_ATTEMPTS = 5;

async function processOwner(admin: SupabaseClient, ownerId: string, dryRun: boolean) {
  const summary = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  const { data: q } = await admin.rpc("demand_os_enqueue_conversions", { p_user_id: ownerId });
  summary.queued = (q as number) ?? 0;

  const { data: settings } = await admin.from("demand_os_settings").select("google_conversion_action_id, meta_pixel_id").eq("user_id", ownerId).maybeSingle();
  const { data: events } = await admin.from("ad_conversion_events").select("*").eq("user_id", ownerId).eq("status", "pending").lt("attempts", MAX_ATTEMPTS).limit(BATCH);
  if (!events?.length) return summary;

  const leadIds = [...new Set<string>(events.map((e: any) => e.lead_id).filter(Boolean))];
  const jobIds = events.map((e: any) => e.job_id);
  const [{ data: attrs }, { data: jobs }, { data: leads }, { data: touches }] = await Promise.all([
    admin.from("ad_lead_attributions").select("lead_id, campaign_id, click_id, click_id_type").in("lead_id", leadIds),
    admin.from("jobs").select("id, completed_at, created_at").in("id", jobIds),
    admin.from("leads").select("id, phone, email").in("id", leadIds),
    admin.from("marketing_attribution_touches").select("lead_id, fbc, fbp, occurred_at").in("lead_id", leadIds).or("fbc.not.is.null,fbp.not.is.null").order("occurred_at", { ascending: false }),
  ]);
  const campIds = [...new Set<string>((attrs ?? []).map((a: any) => a.campaign_id).filter(Boolean))];
  const { data: camps } = await admin.from("ad_campaigns").select("id, account_id").in("id", campIds);
  const accIds = [...new Set<string>((camps ?? []).map((c: any) => c.account_id))];
  const { data: accs } = await admin.from("ad_accounts").select("id, user_id, platform, external_account_id, login_customer_id, currency").in("id", accIds);

  const attrBy = new Map<string, any>((attrs ?? []).map((a: any) => [a.lead_id, a] as [string, any]));
  const jobBy = new Map<string, any>((jobs ?? []).map((j: any) => [j.id, j] as [string, any]));
  const leadBy = new Map<string, any>((leads ?? []).map((l: any) => [l.id, l] as [string, any]));
  const touchBy = new Map<string, any>();
  for (const t of touches ?? []) if (!touchBy.has(t.lead_id)) touchBy.set(t.lead_id, t);
  const campBy = new Map<string, any>((camps ?? []).map((c: any) => [c.id, c] as [string, any]));
  const accBy = new Map<string, any>((accs ?? []).map((a: any) => [a.id, a as AdAccountRow]));

  const mark = async (ids: string[], status: "sent" | "failed" | "skipped", error: string | null = null) => {
    if (dryRun || !ids.length) return;
    for (const id of ids) {
      const ev = events.find((e: any) => e.id === id) as any;
      await admin.from("ad_conversion_events").update({
        status: status === "failed" && ev.attempts + 1 < MAX_ATTEMPTS ? "pending" : status,
        attempts: ev.attempts + (status === "failed" ? 1 : 0), last_error: error,
        sent_at: status === "sent" ? new Date().toISOString() : null,
      }).eq("id", id);
    }
    summary[status] += ids.length;
  };

  // ---- Google ----
  const gEvents = events.filter((e: any) => e.platform === "google_ads");
  if (gEvents.length) {
    if (!settings?.google_conversion_action_id) await mark(gEvents.map((e: any) => e.id), "failed", "Set the Google conversion action id in Demand OS settings.");
    else {
      const groups = new Map<string, any[]>();
      for (const e of gEvents) {
        const acc = accBy.get(campBy.get(attrBy.get(e.lead_id)?.campaign_id)?.account_id);
        if (acc) groups.set(acc.id, [...(groups.get(acc.id) ?? []), e]);
        else await mark([e.id], "skipped", "no_account");
      }
      for (const [accId, evs] of groups) {
        const acc = accBy.get(accId) as AdAccountRow;
        try {
          const token = await tokenFor(admin, acc);
          const res = await ingestGoogleConversions({
            token, customerId: acc.external_account_id, loginCustomerId: acc.login_customer_id,
            conversionActionId: settings.google_conversion_action_id, validateOnly: dryRun,
            events: evs.map((e: any) => {
              const a = attrBy.get(e.lead_id);
              const job = jobBy.get(e.job_id);
              return {
                transactionId: e.job_id, eventTimestamp: new Date(job?.completed_at ?? job?.created_at ?? Date.now()).toISOString(),
                valueUnits: e.value_cents / 100, currency: acc.currency,
                gclid: a?.click_id_type === "gclid" ? a.click_id : undefined,
                gbraid: a?.click_id_type === "gbraid" ? a.click_id : undefined,
                wbraid: a?.click_id_type === "wbraid" ? a.click_id : undefined,
              };
            }),
          });
          log("ads_google_conversions", { user_id: ownerId, dry_run: dryRun, count: evs.length, request_id: res.requestId });
          if (dryRun) summary.sent += evs.length; // validated only
          else await mark(evs.map((e: any) => e.id), "sent");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("ads_google_conversions_failed", { user_id: ownerId, error: msg });
          await mark(evs.map((e: any) => e.id), "failed", msg);
          if (dryRun) summary.failed += evs.length;
        }
      }
    }
  }

  // ---- Meta (Conversions API) ----
  const mEvents = events.filter((e: any) => e.platform === "meta_ads");
  if (mEvents.length && !dryRun) {
    if (!settings?.meta_pixel_id) await mark(mEvents.map((e: any) => e.id), "failed", "Set the Meta pixel / dataset id in Demand OS settings.");
    else {
      const groups = new Map<string, any[]>();
      for (const e of mEvents) {
        const acc = accBy.get(campBy.get(attrBy.get(e.lead_id)?.campaign_id)?.account_id);
        if (acc) groups.set(acc.id, [...(groups.get(acc.id) ?? []), e]);
        else await mark([e.id], "skipped", "no_account");
      }
      for (const [accId, evs] of groups) {
        const acc = accBy.get(accId) as AdAccountRow;
        const payload: Parameters<typeof sendMetaPurchases>[2] = [];
        const sendable: string[] = [];
        for (const e of evs) {
          const lead = leadBy.get(e.lead_id);
          const t = touchBy.get(e.lead_id);
          const d = digits10(lead?.phone);
          const email = (lead?.email ?? "").trim().toLowerCase();
          const ph = d ? await sha256Hex(`1${d}`) : undefined; // assumes US/CA numbers
          const em = email ? await sha256Hex(email) : undefined;
          if (!ph && !em && !t?.fbc) { await mark([e.id], "skipped", "no_match_keys"); continue; }
          const job = jobBy.get(e.job_id);
          payload.push({
            eventId: e.job_id, eventTime: Math.floor(new Date(job?.completed_at ?? job?.created_at ?? Date.now()).getTime() / 1000),
            valueUnits: e.value_cents / 100, currency: acc.currency, ph, em, fbc: t?.fbc, fbp: t?.fbp,
          });
          sendable.push(e.id);
        }
        if (!payload.length) continue;
        try {
          await sendMetaPurchases(await tokenFor(admin, acc), settings.meta_pixel_id, payload);
          await mark(sendable, "sent");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("ads_meta_conversions_failed", { user_id: ownerId, error: msg });
          await mark(sendable, "failed", msg);
        }
      }
    }
  }
  return summary;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = adminClient();
  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run === true;
  try {
    if (isCron(req)) {
      const { data: owners } = await admin.from("ad_accounts").select("user_id");
      const unique = [...new Set<string>((owners ?? []).map((o: any) => o.user_id as string))];
      for (const o of unique) await processOwner(admin, o, false).catch((e) => log("ads_conversions_owner_failed", { user_id: o, error: String(e) }));
      return json({ owners: unique.length });
    }
    const who = await authenticate(req);
    if (!who) return json({ error: "Unauthorized." }, 401);
    return json(await processOwner(admin, who.ownerId, dryRun));
  } catch (e) {
    log("ads_conversions_error", { error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Something went wrong." }, 500);
  }
});
