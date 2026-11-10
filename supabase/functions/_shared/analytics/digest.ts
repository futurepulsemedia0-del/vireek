// supabase/functions/_shared/analytics/digest.ts
//
// Digest email content + mail adapter. Pure except ResendMailer (fetch). The default adapter is the MOCK:
// nothing is sent unless ANALYTICS_DIGEST_MODE=live AND RESEND_API_KEY is set.

import { CUSTOMER_METRICS, type Anomaly, type KpiValues, type MetricId } from "./customerKpis.ts";

export interface DigestMessage { to: string; subject: string; html: string; text: string }
export interface DigestMailer { send(m: DigestMessage): Promise<{ ok: boolean; id?: string; error?: string }> }

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const pct = (b: number | null) => (b === null ? "n/a" : `${(b / 100).toFixed(1)}%`);
const usd = (c: number | null) => (c === null ? "n/a" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);
const delta = (cur: number | null, prev: number | null, unit: "pp" | "usd") => {
  if (cur === null || prev === null) return "";
  const d = cur - prev;
  if (d === 0) return " (no change)";
  const sign = d > 0 ? "+" : "-";
  return unit === "pp" ? ` (${sign}${(Math.abs(d) / 100).toFixed(1)} pts)` : ` (${sign}${usd(Math.abs(d))})`;
};

export function buildDigest(
  k: KpiValues, prev: KpiValues | null, period: { from: string; to: string }, alerts: readonly Anomaly[], link: string, cadence: "weekly" | "monthly",
): { subject: string; text: string; html: string } {
  const rows: [string, string][] = [
    ["Jobs completed", String(k.jobsCompleted)],
    ["Revenue", usd(k.revenueCents)],
    [CUSTOMER_METRICS.first_time_fix_rate.label, pct(k.firstTimeFixRateBp) + delta(k.firstTimeFixRateBp, prev?.firstTimeFixRateBp ?? null, "pp")],
    [CUSTOMER_METRICS.callback_rate.label, pct(k.callbackRateBp) + delta(k.callbackRateBp, prev?.callbackRateBp ?? null, "pp")],
    [CUSTOMER_METRICS.revenue_per_technician.label, usd(k.revenuePerTechnicianCents) + delta(k.revenuePerTechnicianCents, prev?.revenuePerTechnicianCents ?? null, "usd")],
    [CUSTOMER_METRICS.job_profitability.label, pct(k.jobProfitabilityBp) + delta(k.jobProfitabilityBp, prev?.jobProfitabilityBp ?? null, "pp")],
    [CUSTOMER_METRICS.utilization.label, pct(k.utilizationBp) + delta(k.utilizationBp, prev?.utilizationBp ?? null, "pp")],
    [CUSTOMER_METRICS.quote_conversion.label, pct(k.quoteConversionBp) + delta(k.quoteConversionBp, prev?.quoteConversionBp ?? null, "pp")],
  ];
  const alertLines = alerts.map((a) => `${CUSTOMER_METRICS[a.metric as MetricId].label} moved ${a.direction} to ${a.metric === "revenue_per_technician" ? usd(a.value) : pct(a.value)} (usual ${a.metric === "revenue_per_technician" ? usd(a.baselineMean) : pct(a.baselineMean)})${a.bad ? " - needs attention" : ""}`);
  const title = `Your ${cadence} business digest (${period.from} to ${period.to})`;
  const text = [title, "", ...rows.map(([a, b]) => `${a}: ${b}`), ...(alertLines.length ? ["", "Unusual changes:", ...alertLines.map((l) => `- ${l}`)] : []),
    "", `Open the dashboard: ${link}`, "You receive this because you turned on the digest. Turn it off any time in Analytics settings."].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="margin:0 0 12px">${escapeHtml(title)}</h2><table style="border-collapse:collapse;width:100%">${
    rows.map(([a, b]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${escapeHtml(a)}</td><td style="padding:6px 0;border-bottom:1px solid #eee;text-align:right"><strong>${escapeHtml(b)}</strong></td></tr>`).join("")}</table>${
    alertLines.length ? `<h3>Unusual changes</h3><ul>${alertLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}<p><a href="${escapeHtml(link)}">Open the dashboard</a></p><p style="color:#666;font-size:12px">You receive this because you turned on the digest. Turn it off any time in Analytics settings.</p></div>`;
  return { subject: title, text, html };
}

export class MockMailer implements DigestMailer {
  sent: DigestMessage[] = [];
  async send(m: DigestMessage) { this.sent.push(m); return { ok: true, id: `mock-${this.sent.length}` }; }
}

export class ResendMailer implements DigestMailer {
  private apiKey: string;
  private from: string;
  private fetchImpl: typeof fetch;
  constructor(apiKey: string, from: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.from = from;
    this.fetchImpl = fetchImpl;
  }
  async send(m: DigestMessage) {
    try {
      const res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
      });
      if (!res.ok) return { ok: false, error: `provider status ${res.status}` };
      const j = await res.json().catch(() => ({}));
      return { ok: true, id: typeof j?.id === "string" ? j.id : undefined };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "send failed" };
    }
  }
}

export function mailerFromEnv(get: (k: string) => string | undefined): { mailer: DigestMailer; mode: "live" | "mock" } {
  const key = get("RESEND_API_KEY");
  if (get("ANALYTICS_DIGEST_MODE") === "live" && key) return { mailer: new ResendMailer(key, get("RESEND_FROM_EMAIL") || "Vireek <onboarding@resend.dev>"), mode: "live" };
  return { mailer: new MockMailer(), mode: "mock" };
}

/** Due-ness: weekly >= 6.5 days since the last send, monthly >= 27 days; never sent = due. */
export function digestIsDue(lastSentIso: string | null, cadence: "weekly" | "monthly", nowMs: number): boolean {
  if (!lastSentIso) return true;
  const last = Date.parse(lastSentIso);
  if (!Number.isFinite(last)) return true;
  const need = cadence === "weekly" ? 6.5 : 27;
  return nowMs - last >= need * 86_400_000;
}

/** Last fully elapsed period before `today` (UTC): Monday-Sunday week or calendar month. */
export function lastCompletePeriod(todayIso: string, cadence: "weekly" | "monthly"): { from: string; to: string } {
  const t = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error("Invalid day.");
  const d = new Date(t);
  if (cadence === "monthly") {
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
    return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
  }
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = t - dow * 86_400_000;
  return { from: new Date(thisMonday - 7 * 86_400_000).toISOString().slice(0, 10), to: new Date(thisMonday - 86_400_000).toISOString().slice(0, 10) };
}
