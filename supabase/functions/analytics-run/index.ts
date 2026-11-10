// supabase/functions/analytics-run/index.ts
//
// Scheduled job (cron only): anomaly alerts + email digests.  Header: X-Cron-Secret = CRON_SECRET.
//   { "action": "cron" }
// Schedule hourly (alerts are idempotent per week, digests are claimed atomically, so overlap and retries are safe):
//   select cron.schedule('vireek-analytics-run', '5 * * * *', $$
//     select net.http_post(url := '<SUPABASE_URL>/functions/v1/analytics-run',
//       headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
//       body := '{"action":"cron"}'::jsonb) $$);
// Env: CRON_SECRET (required), ANALYTICS_DIGEST_MODE=live + RESEND_API_KEY + RESEND_FROM_EMAIL (otherwise a MOCK mailer is used
//      and nothing is sent), SITE_URL (dashboard link, default https://vireek.com).
// Rollups themselves are refreshed nightly in SQL (analytics_refresh_all).

import { adminClient, corsHeaders, isCron, json } from "../_shared/data-platform/http.ts";
import { computeCustomerKpis, computeKpiSeries, detectAnomaly, type Anomaly, type MetricId } from "../_shared/analytics/customerKpis.ts";
import { buildDigest, digestIsDue, lastCompletePeriod, mailerFromEnv } from "../_shared/analytics/digest.ts";
import { loadRollups, loadSettings, loadTechs } from "../_shared/analytics/service.ts";

const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

type Pick = { metric: MetricId; value: (k: ReturnType<typeof computeCustomerKpis>) => number | null; volume: (k: ReturnType<typeof computeCustomerKpis>) => number };
const WATCHED: Pick[] = [
  { metric: "first_time_fix_rate", value: (k) => k.firstTimeFixRateBp, volume: (k) => k.jobsCompleted },
  { metric: "callback_rate", value: (k) => k.callbackRateBp, volume: (k) => k.jobsCompleted },
  { metric: "job_profitability", value: (k) => k.jobProfitabilityBp, volume: (k) => k.jobsCompleted },
  { metric: "utilization", value: (k) => k.utilizationBp, volume: (k) => k.jobsCompleted },
  { metric: "quote_conversion", value: (k) => k.quoteConversionBp, volume: (k) => k.quotesSent },
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!isCron(req)) return json({ error: "Unauthorized." }, 401);

  const admin = adminClient();
  const { mailer, mode } = mailerFromEnv((k) => Deno.env.get(k));
  const site = Deno.env.get("SITE_URL") || "https://vireek.com";
  const today = new Date().toISOString().slice(0, 10);
  const out = { accounts: 0, alertsCreated: 0, digestsSent: 0, digestsFailed: 0, mode };

  const { data: tenants, error } = await admin.from("analytics_settings").select("user_id").or("digest_enabled.eq.true,alerts_enabled.eq.true").limit(5000);
  if (error) { console.error("[analytics-run]", error.message); return json({ error: "Could not list accounts." }, 500); }

  for (const t of tenants ?? []) {
    const owner = t.user_id as string;
    try {
      const { data: on } = await admin.rpc("analytics_feature_on", { p_owner: owner });
      if (on !== true) continue;
      out.accounts++;
      const settings = await loadSettings(admin, owner);
      const techs = await loadTechs(admin, owner);
      const week = lastCompletePeriod(today, "weekly");
      const histFrom = addDays(week.from, -56);
      const { rows } = await loadRollups(admin, owner, histFrom, week.to);
      const opt = { fromDay: histFrom, toDay: week.to, hoursPerDay: settings.hoursPerDay };
      const weeks = computeKpiSeries(rows, techs.capacity, opt, "week");
      const cur = weeks[weeks.length - 1];
      const hist = weeks.slice(0, -1);
      const anomalies: Anomaly[] = [];
      if (cur) for (const w of WATCHED) {
        const a = detectAnomaly(w.metric, hist.map((p) => w.value(p.values)), w.value(cur.values), w.volume(cur.values));
        if (a) anomalies.push(a);
      }

      if (settings.alertsEnabled && cur) {
        for (const a of anomalies) {
          const { error: e } = await admin.from("analytics_alerts").upsert({
            user_id: owner, metric: a.metric, severity: a.severity, direction: a.direction, bad: a.bad, period_start: cur.start, period_end: cur.end,
            value: a.value, baseline_mean: a.baselineMean, z: a.z,
          }, { onConflict: "user_id,metric,period_start", ignoreDuplicates: true });
          if (!e) out.alertsCreated++;
        }
      }

      if (settings.digestEnabled) {
        const { data: row } = await admin.from("analytics_settings").select("digest_last_sent_at").eq("user_id", owner).maybeSingle();
        const last = (row?.digest_last_sent_at as string | null) ?? null;
        if (!digestIsDue(last, settings.digestCadence, Date.now())) continue;
        // Atomic claim: only one concurrent run can move digest_last_sent_at away from the value it read.
        const nowIso = new Date().toISOString();
        let claim = admin.from("analytics_settings").update({ digest_last_sent_at: nowIso }).eq("user_id", owner);
        claim = last === null ? claim.is("digest_last_sent_at", null) : claim.eq("digest_last_sent_at", last);
        const { data: claimed } = await claim.select("user_id");
        if (!claimed || claimed.length === 0) continue;

        const period = lastCompletePeriod(today, settings.digestCadence);
        const span = Math.round((Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / DAY_MS) + 1;
        const prevFrom = addDays(period.from, -span);
        const { rows: pr } = await loadRollups(admin, owner, prevFrom, period.to);
        const o2 = { fromDay: period.from, toDay: period.to, hoursPerDay: settings.hoursPerDay };
        const k = computeCustomerKpis(pr, techs.capacity, o2);
        const prev = computeCustomerKpis(pr, techs.capacity, { ...o2, fromDay: prevFrom, toDay: addDays(period.from, -1) });
        const { data: prof } = await admin.from("profiles").select("email").eq("id", owner).maybeSingle();
        const to = (prof?.email as string | undefined) ?? "";
        if (!to) { await admin.from("analytics_settings").update({ digest_last_sent_at: last }).eq("user_id", owner).eq("digest_last_sent_at", nowIso); continue; }
        const msg = buildDigest(k, prev, period, settings.alertsEnabled ? anomalies : [], `${site}/dashboard/business-kpis`, settings.digestCadence);
        const res = await mailer.send({ to, ...msg });
        if (res.ok) out.digestsSent++;
        else {
          out.digestsFailed++;
          // release the claim so the next run retries (compare-and-set: never clobbers a newer value)
          await admin.from("analytics_settings").update({ digest_last_sent_at: last }).eq("user_id", owner).eq("digest_last_sent_at", nowIso);
          console.error("[analytics-run] digest failed:", res.error);
        }
      }
    } catch (e) {
      console.error("[analytics-run] account failed:", e instanceof Error ? e.message : e); // never log addresses or metrics
    }
  }
  return json(out, 200);
});
