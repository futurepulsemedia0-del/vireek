// supabase/functions/sla-credit-run/index.ts
//
// Monthly SLA settlement. Suggested schedule: daily at 02:00 UTC (idempotent).
//
// For every account with an sla_policies row it computes the PREVIOUS month's uptime from
// confirmed sla_incidents (shared logic: src/lib/trustPack/sla.ts — same code the dashboard
// shows), writes one sla_credits row per (account, month), and — when a credit is due and
// auto_credit is on — applies it as a Stripe customer-balance credit (negative balance
// transaction) with an idempotency key, so a retry can never double-credit.
//
// Auth: header X-Cron-Secret = TRUST_CRON_SECRET, or a staff JWT (manual re-run).
// Body (optional): { period: "YYYY-MM" } to settle a specific month.
//
// Secrets: STRIPE_SECRET_KEY, TRUST_CRON_SECRET
// Deploy:  supabase functions deploy sla-credit-run

import { authenticate, corsHeaders, cronAuthorized, json, readJson } from "../_shared/trust/http.ts";
import { adminClient } from "../_shared/trust/vault.ts";
import { stripeRequest } from "../_shared/stripe/client.ts";
import { isRegionCode } from "../../../src/lib/trustPack/regions.ts";
import {
  DEFAULT_SLA_TIERS, computeMonthlyReport, isPeriod, previousPeriod, quoteCredit, validateTiers,
  type Incident, type SlaTier,
} from "../../../src/lib/trustPack/sla.ts";

interface PolicyRow {
  user_id: string;
  monthly_fee_cents: number | null;
  currency: string;
  tiers: unknown;
  auto_credit: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!cronAuthorized(req)) {
    const auth = await authenticate(req);
    if (auth instanceof Response) return auth;
    if (!auth.isStaff) return json({ error: "Forbidden" }, 403);
  }

  const body = (await readJson(req)) ?? {};
  const now = Date.now();
  const period = isPeriod(body.period) ? body.period : previousPeriod(now);
  const admin = adminClient();
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");

  const [y, m] = period.split("-").map(Number);
  const windowStart = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const windowEnd = new Date(Date.UTC(y, m, 1)).toISOString();
  if (Date.UTC(y, m, 1) > now) return json({ error: "That month has not ended yet." }, 400);

  const { data: incidents, error: incErr } = await admin.from("sla_incidents").select("*")
    .eq("confirmed", true).lt("started_at", windowEnd).or(`ended_at.is.null,ended_at.gt.${windowStart}`);
  if (incErr) return json({ error: "Could not load incidents." }, 500);

  const { data: policies, error: polErr } = await admin.from("sla_policies").select("user_id,monthly_fee_cents,currency,tiers,auto_credit");
  if (polErr) return json({ error: "Could not load SLA policies." }, 500);

  const summary = { period, accounts: 0, credited: 0, pending: 0, none: 0, failed: 0, skipped: 0 };

  for (const policy of (policies ?? []) as PolicyRow[]) {
    summary.accounts++;
    try {
      const { data: existing } = await admin.from("sla_credits").select("id,status").eq("user_id", policy.user_id).eq("period", period).maybeSingle();
      if (existing && existing.status !== "failed" && existing.status !== "pending") { summary.skipped++; continue; }

      const { data: res } = await admin.from("tenant_residency").select("region").eq("user_id", policy.user_id).maybeSingle();
      const region = isRegionCode(res?.region) ? res.region : "us";
      const tiers: SlaTier[] = validateTiers(policy.tiers) ? policy.tiers : DEFAULT_SLA_TIERS;

      const report = computeMonthlyReport(period, { id: policy.user_id, region }, (incidents ?? []) as Incident[], now);
      const quote = quoteCredit(report.uptimePct, tiers, policy.monthly_fee_cents);

      let status: "none" | "pending" | "applied" | "failed" = quote.creditPct === 0 ? "none" : "pending";
      let stripeRef: string | null = null;
      let error: string | null = null;

      if (status === "pending" && policy.auto_credit && quote.creditCents > 0 && stripeKey) {
        const { data: profile } = await admin.from("profiles").select("stripe_customer_id").eq("id", policy.user_id).maybeSingle();
        if (profile?.stripe_customer_id) {
          try {
            const tx = await stripeRequest(
              `customers/${profile.stripe_customer_id}/balance_transactions`,
              {
                amount: -quote.creditCents, // negative = credit toward the next invoice
                currency: policy.currency,
                description: `SLA service credit ${period} (${quote.creditPct}%)`,
                metadata: { vireek_sla_period: period, vireek_user_id: policy.user_id },
              },
              stripeKey,
              { idempotencyKey: `sla-credit-${policy.user_id}-${period}` },
            );
            status = "applied";
            stripeRef = tx.id;
          } catch (e) {
            status = "failed";
            error = e instanceof Error ? e.message.slice(0, 300) : "Stripe error";
          }
        }
      }

      const row = {
        user_id: policy.user_id, period,
        uptime_pct: Number(report.uptimePct.toFixed(5)),
        measured_minutes: Number(report.measuredMinutes.toFixed(2)),
        downtime_minutes: Number(report.downtimeMinutes.toFixed(2)),
        credit_pct: quote.creditPct, monthly_fee_cents: policy.monthly_fee_cents, credit_cents: quote.creditCents,
        status, stripe_ref: stripeRef, error, computed_at: new Date().toISOString(),
        applied_at: status === "applied" ? new Date().toISOString() : null,
      };
      const { error: upErr } = await admin.from("sla_credits").upsert(row, { onConflict: "user_id,period" });
      if (upErr) throw upErr;
      summary[status === "applied" ? "credited" : status]++;
    } catch (e) {
      summary.failed++;
      console.error("sla-credit-run account failed", policy.user_id, e instanceof Error ? e.message : e);
    }
  }
  return json(summary);
});
