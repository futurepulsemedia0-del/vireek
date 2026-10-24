// supabase/functions/slo-evaluate/index.ts
//
// Every 5 minutes: read SLI counts, evaluate multi-window burn-rate rules per SLO and region,
// open/escalate/resolve incidents automatically, notify status subscribers and (optionally) on-call.
//
// Optional secrets:
//   SLO_ALERT_WEBHOOK_URL            Slack-compatible incoming webhook for on-call
//   STATUS_NOTIFY_WEBHOOK_SECRET     same value notify-status-subscribers already uses
// Deploy: supabase functions deploy slo-evaluate --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isAuthorizedCaller, json } from "../_shared/synthetic/auth.ts";
import {
  HOUR_WINDOW_MINUTES,
  evaluateBurnAlerts,
  incidentCopy,
  incidentKey,
  pickCounts,
  regionsFor,
  shouldResolve,
  windowsFor,
  type SloDefinition,
  type WindowCountRow,
} from "../_shared/synthetic/slo.ts";

type Admin = ReturnType<typeof createClient>;

async function notify(title: string, impact: "minor" | "major", status: "investigating" | "resolved", summary: string) {
  const base = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("STATUS_NOTIFY_WEBHOOK_SECRET");
  const hook = Deno.env.get("SLO_ALERT_WEBHOOK_URL");
  const jobs: Promise<unknown>[] = [];
  if (base && service) {
    jobs.push(
      fetch(`${base}/functions/v1/notify-status-subscribers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${service}`, ...(secret ? { "X-Webhook-Secret": secret } : {}) },
        body: JSON.stringify({ title, impact, status, summary }),
      }).catch(() => null),
    );
  }
  if (hook) {
    jobs.push(
      fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${status === "resolved" ? "✅ Resolved" : impact === "major" ? "🚨 Major" : "⚠️ Minor"}: ${title}\n${summary}` }),
      }).catch(() => null),
    );
  }
  await Promise.all(jobs);
}

async function evaluate(admin: Admin) {
  const { data: defs, error: defErr } = await admin.from("slo_definitions").select("*").eq("active", true);
  if (defErr) return json({ error: defErr.message }, 500);
  const slos = (defs ?? []) as SloDefinition[];
  if (slos.length === 0) return json({ opened: 0, resolved: 0 });

  const windows = Array.from(new Set(slos.flatMap((d) => windowsFor(d.window_days)))).slice(0, 8);
  const { data: rowsData, error: rowsErr } = await admin.rpc("slo_multi_window_counts", { p_windows_minutes: windows });
  if (rowsErr) return json({ error: rowsErr.message }, 500);
  const rows = (rowsData ?? []) as WindowCountRow[];

  let opened = 0;
  let resolved = 0;
  const handled = new Set<string>();

  for (const slo of slos) {
    const regions = slo.region ? [slo.region] : regionsFor(rows, slo.sli);
    for (const region of regions) {
      const key = incidentKey(slo.key, region);
      handled.add(key);
      const countsFor = (m: number) => pickCounts(rows, m, slo.sli, region);
      const decision = evaluateBurnAlerts(countsFor, Number(slo.objective));

      if (decision.firing && decision.impact) {
        const copy = incidentCopy(slo, region, decision);
        const { data } = await admin.rpc("synthetic_open_incident", {
          p_dedupe_key: key, p_title: copy.title, p_impact: decision.impact,
          p_component_id: slo.component_id, p_region: region, p_message: copy.message,
        });
        const res = data as { created?: boolean; escalated?: boolean } | null;
        if (res?.created || res?.escalated) {
          opened += 1;
          await notify(copy.title, decision.impact, "investigating", copy.message);
        }
      } else if (shouldResolve(countsFor(HOUR_WINDOW_MINUTES))) {
        const { data } = await admin.rpc("synthetic_resolve_incident", {
          p_dedupe_key: key, p_message: "Automated test calls have been healthy for the last hour. This incident is resolved.",
        });
        const res = data as { resolved?: boolean; title?: string; impact?: "minor" | "major" } | null;
        if (res?.resolved) {
          resolved += 1;
          await notify(res.title ?? "Voice AI recovered", res.impact ?? "minor", "resolved", "Service has recovered.");
        }
      }
    }
  }

  // Open synthetic incidents whose region/SLO produced no recent data are left open on purpose
  // (no data is not recovery); staff can resolve them manually.
  return json({ opened, resolved, evaluated: handled.size });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorizedCaller(req)) return json({ error: "Unauthorized" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server not configured" }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return await evaluate(admin);
});
