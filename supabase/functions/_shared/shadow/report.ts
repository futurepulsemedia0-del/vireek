// supabase/functions/_shared/shadow/report.ts
//
// Day-7 "Proof of Value" — pure payload builder + HTML and PDF renderers.
// Shadow numbers are ESTIMATES: every money figure is labelled as such, the formula is printed, and
// nothing here ever calls them "recovered" or "realized". Server-rendered strings: en + es (other
// locales fall back to English; Persian/Arabic cannot be drawn by jsPDF's built-in fonts, so the PDF is
// Latin-script only — the HTML report is full Unicode).

import {
  ESTIMATE_LABEL, computeEstimate, computeReadiness, redactPii,
  type Estimate, type Readiness, type ReviewStats,
} from "./logic.ts";
import { pdfSafe } from "../executive-report/pdf.ts";

export type ReportLocale = "en" | "es";

export interface ReportCounts {
  callsSeen: number; analyzed: number; unanswered: number; slowAnswers: number; afterHours: number;
  emergencies: number; capturable: number; reviewed: number; approved: number; blockedConsent: number; noTranscript: number;
}
export interface ReviewRow {
  verdict: "good" | "bad"; severity: "minor" | "critical"; category: string;
  proposalTarget: "none" | "faq" | "script"; proposalStatus: "none" | "pending" | "accepted" | "rejected" | "applied";
  mistakeResolved: boolean; correctedText: string | null;
}
export interface Mistake {
  category: string; count: number; critical: boolean; example: string; status: "fixed" | "open"; fix: string;
}
export interface ReportPayload {
  version: 1;
  generatedAt: string;
  trial: { startedAt: string; endsAt: string; timezone: string };
  counts: ReportCounts;
  estimate: Estimate;
  readiness: Readiness;
  topMistakes: Mistake[];
  setup: { forwarding: boolean; hours: boolean; emergency_rules: boolean; test_call: boolean };
  notes: string[];
}

/** Top 3 mistake categories: critical first, then by frequency, then name (deterministic). */
export function topMistakes(rows: ReviewRow[]): Mistake[] {
  const bad = rows.filter((r) => r.verdict === "bad");
  const by = new Map<string, ReviewRow[]>();
  for (const r of bad) by.set(r.category, [...(by.get(r.category) ?? []), r]);
  const out: Mistake[] = [];
  for (const [category, list] of by) {
    const fixedCount = list.filter((r) => r.mistakeResolved || r.proposalStatus === "accepted" || r.proposalStatus === "applied").length;
    const allFixed = fixedCount === list.length;
    const withFix = list.find((r) => r.proposalStatus === "accepted" || r.proposalStatus === "applied");
    const example = redactPii(list.find((r) => r.correctedText)?.correctedText ?? "").slice(0, 240);
    out.push({
      category,
      count: list.length,
      critical: list.some((r) => r.severity === "critical"),
      example,
      status: allFixed ? "fixed" : "open",
      fix: withFix ? (withFix.proposalTarget === "faq" ? "Added to business FAQs" : "Script updated") : allFixed ? "Resolved by owner" : "Not fixed yet",
    });
  }
  return out
    .sort((a, b) => Number(b.critical) - Number(a.critical) || b.count - a.count || a.category.localeCompare(b.category))
    .slice(0, 3);
}

export function buildReportPayload(input: {
  nowIso: string;
  trial: { startedAt: string; endsAt: string; timezone: string; setup: ReportPayload["setup"] };
  counts: ReportCounts;
  avgTicketCents: number | null;
  closeRate: number | null;
  capturableCards: Array<{ wouldBook: boolean; capturable: boolean }>;
  emergencyCardsReviewed: number;
  emergencyCardsApproved: number;
  reviews: ReviewRow[];
  openCritical: number;
}): ReportPayload {
  const setupDone = Object.values(input.trial.setup).filter(Boolean).length;
  const stats: ReviewStats = {
    cardsTotal: input.counts.analyzed,
    cardsReviewed: input.counts.reviewed,
    approved: input.counts.approved,
    emergencyCards: input.emergencyCardsReviewed,
    emergencyApproved: input.emergencyCardsApproved,
    openCriticalMistakes: input.openCritical,
    setupItemsDone: setupDone,
  };
  const notes = [
    "Figures marked as estimates are projections from calls observed in Shadow Mode. They are not realized revenue and are not included in your ROI dashboards.",
  ];
  if (input.counts.blockedConsent > 0) notes.push(`${input.counts.blockedConsent} call(s) were not analysed because consent requirements were not met.`);
  if (input.counts.noTranscript > 0) notes.push(`${input.counts.noTranscript} call(s) had no transcript, so Sarah could not review them.`);
  return {
    version: 1,
    generatedAt: input.nowIso,
    trial: { startedAt: input.trial.startedAt, endsAt: input.trial.endsAt, timezone: input.trial.timezone },
    counts: input.counts,
    estimate: computeEstimate({ avgTicketCents: input.avgTicketCents, closeRate: input.closeRate, cards: input.capturableCards }),
    readiness: computeReadiness(stats),
    topMistakes: topMistakes(input.reviews),
    setup: input.trial.setup,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------
const T: Record<ReportLocale, Record<string, string>> = {
  en: {
    title: "Shadow Mode — Proof of Value", sub: "7-day risk-free trial. Sarah listened; she never spoke to a caller.",
    seen: "Calls seen", unanswered: "Missed / voicemail / abandoned", afterHours: "After-hours calls", emergencies: "Emergencies flagged",
    capture: "Calls Sarah would have captured", est: "Estimated revenue (range)", readiness: "Readiness score", mistakes: "Top mistakes Sarah would have made",
    none: "No mistakes were recorded.", fixed: "Fixed", open: "Open", formula: "How this estimate is calculated", checklist: "Go-live checklist",
    forwarding: "Call forwarding set up", hours: "Business hours confirmed", emergency_rules: "Emergency rules confirmed", test_call: "Test call completed",
    notScored: "Not enough reviewed calls to score yet", noTicket: "Add your average ticket to see a dollar estimate", done: "Done", todo: "To do",
    point: "Point estimate", generated: "Generated", count: "Count", category: "Category", status: "Status", fix: "How it was fixed",
  },
  es: {
    title: "Modo Sombra — Prueba de valor", sub: "Prueba de 7 días sin riesgo. Sarah escuchó; nunca habló con ningún cliente.",
    seen: "Llamadas vistas", unanswered: "Perdidas / buzón / abandonadas", afterHours: "Llamadas fuera de horario", emergencies: "Emergencias detectadas",
    capture: "Llamadas que Sarah habría captado", est: "Ingresos estimados (rango)", readiness: "Puntuación de preparación", mistakes: "Principales errores que Sarah habría cometido",
    none: "No se registraron errores.", fixed: "Corregido", open: "Abierto", formula: "Cómo se calcula esta estimación", checklist: "Lista para activar",
    forwarding: "Desvío de llamadas configurado", hours: "Horario confirmado", emergency_rules: "Reglas de emergencia confirmadas", test_call: "Llamada de prueba realizada",
    notScored: "Aún no hay suficientes llamadas revisadas", noTicket: "Añade tu ticket promedio para ver una estimación en dinero", done: "Hecho", todo: "Pendiente",
    point: "Estimación puntual", generated: "Generado", count: "Cantidad", category: "Categoría", status: "Estado", fix: "Cómo se corrigió",
  },
};

export function tr(locale: string, key: string): string {
  const l: ReportLocale = locale === "es" ? "es" : "en";
  return T[l][key] ?? T.en[key] ?? key;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export function money(cents: number | null, currency = "USD", locale = "en-US"): string {
  if (cents === null || !Number.isFinite(cents)) return "—";
  try { return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100); }
  catch { return `${currency} ${Math.round(cents / 100)}`; }
}

function estimateText(p: ReportPayload, locale: string, currency: string): string {
  const e = p.estimate;
  if (e.reason === "no_avg_ticket") return tr(locale, "noTicket");
  return `${money(e.lowCents, currency)} – ${money(e.highCents, currency)}`;
}

function readinessText(p: ReportPayload, locale: string): string {
  return p.readiness.state === "scored" ? `${p.readiness.score}/100` : tr(locale, "notScored");
}

// ---------------------------------------------------------------------------
// HTML (self-contained, escaped, printable, light/dark safe)
// ---------------------------------------------------------------------------
export function renderReportHtml(p: ReportPayload, opts: { companyName?: string; locale?: string; currency?: string } = {}): string {
  const locale = opts.locale === "es" ? "es" : "en";
  const cur = opts.currency ?? "USD";
  const t = (k: string) => esc(tr(locale, k));
  const c = p.counts;
  const stat = (label: string, value: string) => `<div class="stat"><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  const mistakes = p.topMistakes.length
    ? `<table><caption class="sr">${t("mistakes")}</caption><thead><tr><th scope="col">${t("category")}</th><th scope="col">${t("count")}</th><th scope="col">${t("status")}</th><th scope="col">${t("fix")}</th></tr></thead><tbody>${
      p.topMistakes.map((m) => `<tr><th scope="row">${esc(m.category)}${m.critical ? " ⚠" : ""}</th><td>${m.count}</td><td>${m.status === "fixed" ? t("fixed") : t("open")}</td><td>${esc(m.fix)}${m.example ? `<br><small>${esc(m.example)}</small>` : ""}</td></tr>`).join("")
    }</tbody></table>`
    : `<p>${t("none")}</p>`;
  const items = (["forwarding", "hours", "emergency_rules", "test_call"] as const)
    .map((k) => `<li>${p.setup[k] ? "✔" : "○"} ${t(k)} — ${p.setup[k] ? t("done") : t("todo")}</li>`).join("");
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t("title")}</title>
<style>
:root{--bg:#fff;--fg:#171717;--muted:#6e6e78;--line:#e1e1e8;--accent:#203ad8;--warn:#9a5b00}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#f2f2f4;--muted:#a0a0ab;--line:#2c2c33;--accent:#8ea0ff;--warn:#f0b35a}}
body{font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px;max-width:860px;margin-inline:auto}
h1{font-size:1.6rem;margin:.2em 0}h2{font-size:1.1rem;margin-top:1.8em;border-bottom:1px solid var(--line);padding-bottom:.3em}
.muted{color:var(--muted)}.banner{border:1px solid var(--warn);color:var(--warn);padding:.6em .9em;border-radius:8px;margin:1em 0}
dl.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:0}
.stat{border:1px solid var(--line);border-radius:10px;padding:12px}.stat dt{color:var(--muted);font-size:.85rem}.stat dd{margin:.2em 0 0;font-size:1.4rem;font-weight:650}
table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid var(--line);padding:8px;text-align:start;vertical-align:top}
.sr{position:absolute;left:-9999px}@media print{body{padding:0}}
</style></head><body>
<header><h1>${t("title")}</h1><p class="muted">${esc(opts.companyName ?? "")} ${opts.companyName ? "·" : ""} ${t("sub")}</p></header>
<div class="banner" role="note">${esc(ESTIMATE_LABEL)}. ${esc(p.notes[0])}</div>
<main>
<h2>${t("seen")}</h2>
<dl class="grid">
${stat(t("seen"), String(c.callsSeen))}${stat(t("unanswered"), String(c.unanswered))}${stat(t("afterHours"), String(c.afterHours))}
${stat(t("emergencies"), String(c.emergencies))}${stat(t("capture"), String(c.capturable))}${stat(t("readiness"), readinessText(p, locale))}
</dl>
<h2>${t("est")}</h2>
<p><strong>${esc(estimateText(p, locale, cur))}</strong> <span class="muted">(${esc(ESTIMATE_LABEL)})</span></p>
${p.estimate.reason === "ok" ? `<p class="muted">${t("point")}: ${esc(money(p.estimate.pointCents, cur))}</p>` : ""}
<details open><summary>${t("formula")}</summary><p class="muted">${esc(p.estimate.formula)} ${esc(p.estimate.avgTicketCents !== null ? `Average ticket: ${money(p.estimate.avgTicketCents, cur)}; close rate: ${Math.round(p.estimate.closeRate * 100)}%.` : "")}</p></details>
<h2>${t("mistakes")}</h2>${mistakes}
<h2>${t("checklist")}</h2><ul>${items}</ul>
${p.notes.slice(1).map((n) => `<p class="muted">${esc(n)}</p>`).join("")}
</main>
<footer class="muted"><p>${t("generated")}: ${esc(p.generatedAt)}</p></footer>
</body></html>`;
}

// ---------------------------------------------------------------------------
// PDF (jsPDF injected; same pattern as money-recovered/pdf.ts)
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type PdfDoc = any;
export type JsPdfCtor = new (opts: Record<string, unknown>) => PdfDoc;

export function buildReportPdf(JsPDF: JsPdfCtor, p: ReportPayload, opts: { companyName?: string; locale?: string; currency?: string } = {}): Uint8Array {
  const locale = opts.locale === "es" ? "es" : "en";
  const cur = opts.currency ?? "USD";
  const doc: PdfDoc = new JsPDF({ unit: "pt", format: "a4", compress: true });
  const M = 48, W = 595.28, BOTTOM = 841.89 - 64;
  let y = M;
  const line = (txt: string, size = 11, bold = false, gap = 6) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const rows = doc.splitTextToSize(pdfSafe(txt), W - M * 2) as string[];
    for (const r of rows) {
      if (y > BOTTOM) { doc.addPage(); y = M; }
      doc.text(r, M, y);
      y += size + 3;
    }
    y += gap;
  };
  line(tr(locale, "title"), 20, true, 4);
  line(`${opts.companyName ?? ""} ${tr(locale, "sub")}`.trim(), 10, false, 10);
  line(`${ESTIMATE_LABEL}. ${p.notes[0]}`, 10, true, 10);
  const c = p.counts;
  line(`${tr(locale, "seen")}: ${c.callsSeen}`);
  line(`${tr(locale, "unanswered")}: ${c.unanswered}`);
  line(`${tr(locale, "afterHours")}: ${c.afterHours}`);
  line(`${tr(locale, "emergencies")}: ${c.emergencies}`);
  line(`${tr(locale, "capture")}: ${c.capturable}`);
  line(`${tr(locale, "readiness")}: ${readinessText(p, locale)}`, 11, true, 10);
  line(`${tr(locale, "est")}: ${estimateText(p, locale, cur)} (${ESTIMATE_LABEL})`, 12, true, 4);
  line(`${tr(locale, "formula")}: ${p.estimate.formula}`, 9, false, 10);
  line(tr(locale, "mistakes"), 13, true, 4);
  if (!p.topMistakes.length) line(tr(locale, "none"));
  for (const m of p.topMistakes) line(`- ${m.category}${m.critical ? " (critical)" : ""} x${m.count} - ${m.status === "fixed" ? tr(locale, "fixed") : tr(locale, "open")}: ${m.fix}`);
  line(tr(locale, "checklist"), 13, true, 4);
  for (const k of ["forwarding", "hours", "emergency_rules", "test_call"] as const) line(`[${p.setup[k] ? "x" : " "}] ${tr(locale, k)}`);
  for (const n of p.notes.slice(1)) line(n, 9);
  line(`${tr(locale, "generated")}: ${p.generatedAt}`, 9);
  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}
