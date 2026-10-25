// supabase/functions/_shared/value-scoreboard/render.ts
// Monthly Results email (HTML + plain text). Pure: no Deno / network / DOM.

import { formatHours, formatMoney, formatMultiple, formatShare, methodology, type Scoreboard } from "./engine.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Safe for a Subject header: no CR/LF, bounded length. */
const oneLine = (s: string, n = 70) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export interface ValueEmailInput { companyName: string; board: Scoreboard; siteUrl: string }

export function costLine(b: Scoreboard): string {
  const c = b.cost;
  if (c.reason === "free_plan") return "You are on the free plan, so there is no subscription cost to compare against.";
  if (c.reason === "currency_mismatch") return "Your plan is billed in a different currency, so we do not compare it with your results.";
  if (c.reason === "no_plan" || c.subscriptionCents === null) return "Add your monthly subscription cost in Results settings to see value versus cost.";
  const cur = b.currency;
  return `Subscription ${formatMoney(c.subscriptionCents, cur)} per month. Verified (measured) value alone is ${formatMultiple(c.measuredMultiple)} the cost; including estimates it is ${formatMultiple(c.multiple)}.`;
}

export function renderValueEmail(input: ValueEmailInput): { subject: string; html: string; text: string } {
  const { board: b } = input;
  const cur = b.currency;
  const m = (c: number) => formatMoney(c, cur);
  const url = `${input.siteUrl.replace(/\/$/, "")}/dashboard/results`;
  const company = input.companyName || "Your business";
  const subject = oneLine(`${company}: Vireek results for ${b.window.label} - ${m(b.money.measuredCents)} verified`);

  const rows = b.byFeature.slice(0, 8).map((r) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee">${escapeHtml(r.label)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${m(r.measuredCents)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#9a5b00">${m(r.estimatedCents)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#666">${r.measuredMinutes + r.estimatedMinutes > 0 ? formatHours(r.measuredMinutes + r.estimatedMinutes) : "-"}</td>
    </tr>`).join("");

  const other = b.otherCurrencies.length
    ? `<p style="color:#666;font-size:12px">Also recorded in other currencies (not added above): ${b.otherCurrencies.map((o) => escapeHtml(`${formatMoney(o.measuredCents + o.estimatedCents, o.currency)}`)).join(", ")}.</p>`
    : "";

  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f8;font-family:Helvetica,Arial,sans-serif;color:#171717">
<div style="max-width:620px;margin:0 auto;padding:24px">
  <div style="background:#fff;border-radius:14px;padding:28px;border:1px solid #e6e6ee">
    <p style="margin:0;color:#203ad8;font-weight:700;font-size:13px">${escapeHtml(company)}</p>
    <h1 style="margin:6px 0 2px;font-size:22px">Your Vireek results for ${escapeHtml(b.window.label)}</h1>
    <p style="margin:0 0 20px;color:#666;font-size:12px">Method ${escapeHtml(b.methodVersion)} - months in ${escapeHtml(b.window.timezone)}</p>
    <div style="font-size:34px;font-weight:800;color:#15704a">${m(b.money.measuredCents)}</div>
    <div style="color:#444;font-size:13px;margin-bottom:14px">verified revenue (measured against paid invoices)</div>
    <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:6px"><tr>
      <td style="padding:10px;background:#fff4e0;border-radius:8px"><div style="font-size:11px;color:#9a5b00">ESTIMATED (separate)</div><div style="font-size:17px;font-weight:700">${m(b.money.estimatedCents)}</div></td>
      <td width="10"></td>
      <td style="padding:10px;background:#eef2ff;border-radius:8px"><div style="font-size:11px;color:#203ad8">TIME SAVED (estimated)</div><div style="font-size:17px;font-weight:700">${formatHours(b.hours.totalMinutes)}</div></td>
    </tr></table>
    <p style="font-size:13px;color:#333">${escapeHtml(costLine(b))}</p>
    ${rows ? `<h2 style="font-size:15px;margin:22px 0 4px">By feature</h2>
    <table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px">
      <tr style="color:#666;font-size:11px"><td>FEATURE</td><td style="text-align:right">MEASURED</td><td style="text-align:right">ESTIMATED</td><td style="text-align:right">TIME</td></tr>${rows}</table>` : ""}
    ${other}
    <p style="margin:22px 0 0"><a href="${escapeHtml(url)}" style="background:#203ad8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;display:inline-block">See every item and how it was calculated</a></p>
    <p style="color:#777;font-size:11px;margin-top:18px">Measured value is backed by a paid invoice in your account. Estimated value uses assumptions you control and is never added to the measured total. Anything that was not really due to Vireek can be removed on the Results page.</p>
  </div>
</div></body></html>`;

  const text = [
    `${company} - Vireek results for ${b.window.label}`,
    `Verified revenue: ${m(b.money.measuredCents)}`,
    `Estimated (separate): ${m(b.money.estimatedCents)}`,
    `Time saved (estimated): ${formatHours(b.hours.totalMinutes)}`,
    costLine(b),
    ...b.byFeature.slice(0, 8).map((r) => `- ${r.label}: ${m(r.measuredCents)} measured, ${m(r.estimatedCents)} estimated (${formatShare(r.shareBp)})`),
    "",
    `Details and calculation: ${url}`,
    methodology[0].body,
  ].join("\n");

  return { subject, html, text };
}
