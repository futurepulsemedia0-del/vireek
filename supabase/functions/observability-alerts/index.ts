// supabase/functions/observability-alerts/index.ts
//
// Cron-driven (every 2 min, via public.synthetic_cron_tick). Evaluates REAL-traffic voice SLIs against
// the alert rules in _shared/observability/alertRules.ts and routes pages / chat / tickets.
//
// Secrets (Supabase function secrets):
//   PUSH_DISPATCH_SECRET            already used by slo-evaluate (cron caller auth)
//   PAGERDUTY_ROUTING_KEY           PagerDuty Events API v2 integration key (SEV1/SEV2 pages)    [optional]
//   ALERT_SLACK_WEBHOOK_URL         Slack incoming webhook for #voice-alerts (SEV1-SEV3 + mirrors) [recommended]
//   ALERT_TICKET_WEBHOOK_URL        digest/ticket webhook for SEV4; falls back to the Slack webhook  [optional]
//   ALERT_RUNBOOK_BASE_URL          e.g. https://github.com/<org>/<repo>/blob/main (links in pages)  [recommended]
//   ALERT_SOURCE_NAME               PagerDuty "source" (default vireek-voice)
// With NO destination secret set the function still evaluates and records state + alert_log (delivered=false).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isAuthorizedCaller, json } from "../_shared/synthetic/auth.ts";
import { runAlertCycle, type MetricRow, type RunnerPorts, type SliCountRow } from "../_shared/observability/alertRunner.ts";
import { pagerDutyBody, slackBody, type AlertState, type RoutedNotification } from "../_shared/observability/alertRules.ts";

async function post(url: string, body: unknown, timeoutMs = 4000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    return res.ok;
  } catch { return false; } finally { clearTimeout(t); }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorizedCaller(req)) return json({ error: "Unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server not configured" }, 500);
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const pd = Deno.env.get("PAGERDUTY_ROUTING_KEY");
  const slack = Deno.env.get("ALERT_SLACK_WEBHOOK_URL");
  const ticket = Deno.env.get("ALERT_TICKET_WEBHOOK_URL") ?? slack;
  const runbookBase = Deno.env.get("ALERT_RUNBOOK_BASE_URL") ?? "docs";
  const source = Deno.env.get("ALERT_SOURCE_NAME") ?? "vireek-voice";

  const ports: RunnerPorts = {
    now: () => new Date(),
    async loadMetrics(w) {
      const { data, error } = await admin.rpc("obs_voice_metrics", { p_window_minutes: w });
      if (error) throw new Error(`obs_voice_metrics: ${error.message}`);
      // Agent runtime metrics are additive: a failure here must never blind the voice alerts.
      const agent = await admin.rpc("obs_agent_metrics", { p_window_minutes: w });
      return [...((data ?? []) as MetricRow[]), ...(agent.error ? [] : ((agent.data ?? []) as MetricRow[]))];
    },
    async loadSliCounts(windows) {
      const { data, error } = await admin.rpc("obs_sli_counts", { p_windows: windows });
      if (error) throw new Error(`obs_sli_counts: ${error.message}`);
      return (data ?? []) as SliCountRow[];
    },
    async loadStates() {
      const { data } = await admin.from("observability_alert_state").select("fingerprint, state").limit(2000);
      return new Map(((data ?? []) as Array<{ fingerprint: string; state: AlertState }>).map((r) => [r.fingerprint, r.state]));
    },
    async saveState(fingerprint, ruleKey, scopeKey, state) {
      await admin.from("observability_alert_state").upsert({ fingerprint, rule_key: ruleKey, scope_key: scopeKey, state, updated_at: new Date().toISOString() }, { onConflict: "fingerprint" });
    },
    async loadMaintenance() {
      const { data } = await admin.from("observability_maintenance").select("scope_key, rule_key").lte("starts_at", new Date().toISOString()).gte("ends_at", new Date().toISOString());
      return (data ?? []) as Array<{ scope_key: string; rule_key: string | null }>;
    },
    async pagesLastHour() {
      const { count } = await admin.from("observability_alert_log").select("id", { count: "exact", head: true })
        .eq("channel", "pagerduty").eq("kind", "trigger").eq("delivered", true).gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
      return count ?? 0;
    },
    async deliver(n: RoutedNotification) {
      if (n.channel === "pagerduty") return pd ? await post("https://events.pagerduty.com/v2/enqueue", pagerDutyBody(n, pd, source, runbookBase)) : false;
      const target = n.channel === "ticket" ? ticket : slack;
      return target ? await post(target, slackBody(n, runbookBase)) : false;
    },
    async logDelivery(n, delivered) {
      await admin.from("observability_alert_log").insert({ fingerprint: n.dedupKey, kind: n.kind, severity: n.severity, channel: n.channel, delivered, detail: n.summary.slice(0, 300) });
    },
    async openIncident(a) {
      await admin.rpc("synthetic_open_incident", { p_dedupe_key: a.dedupeKey, p_title: a.title, p_impact: a.impact, p_component_id: a.component, p_region: a.region, p_message: a.message });
    },
    async resolveIncident(a) {
      await admin.rpc("synthetic_resolve_incident", { p_dedupe_key: a.dedupeKey, p_message: a.message });
    },
  };

  try {
    const r = await runAlertCycle(ports);
    return json({ ok: true, evaluated: r.evaluated, opened: r.opened, resolved: r.resolved, renotified: r.renotified, delivered: r.delivered, delivery_failures: r.deliveryFailures });
  } catch (e) {
    console.error(JSON.stringify({ event: "observability_alerts_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ ok: false, error: "evaluation_failed" }, 500);
  }
});
