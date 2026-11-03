// supabase/functions/_shared/revenue-realization/mappers.ts
//
// Pure row → fact mappers for revenue-realization-run. Column names below were verified against the
// migrations in this repo (see the notes on each mapper). No I/O so they can be unit tested.

import type { AgreementFact, DeclinedRecFact, DiscountFact, UnderpricedFact, WarrantyFact } from "./engine.ts";

const DAY = 86_400_000;
const cents = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));

export interface LineItem { quantity?: number; unit_price_cents?: number }

/** subtotal·(1+tax%) in cents — same shape/maths as quote_line_items_subtotal_cents + tax_percent. */
export function lineItemsTotalCents(items: unknown, taxPercent: unknown): number {
  const list = Array.isArray(items) ? (items as LineItem[]) : [];
  const sub = list.reduce((s, li) => s + Math.max(0, Number(li?.quantity) || 0) * Math.max(0, Number(li?.unit_price_cents) || 0), 0);
  return Math.round(sub * (1 + Math.max(0, Number(taxPercent) || 0) / 100));
}

// ---- findings_package_items (declined) + findings_packages + quotes
export interface FindingItemRow { id: string; package_id: string; severity: "urgent" | "recommended" | "monitor"; options: unknown; recommended_option_id: string | null; decided_at: string | null }
export interface FindingPackageRow { id: string; job_id: string | null; customer_name: string; customer_email: string | null; customer_phone: string | null; tax_percent: number }
export interface QuoteContactRow { customer_email: string | null; customer_phone: string | null; created_at: string }

interface OptionRow { id?: string; line_items?: unknown; recommended?: boolean }
const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");

export function mapDeclined(items: FindingItemRow[], pkgs: FindingPackageRow[], quotes: QuoteContactRow[]): DeclinedRecFact[] {
  const pk = new Map(pkgs.map((p) => [p.id, p]));
  const out: DeclinedRecFact[] = [];
  for (const it of items) {
    const p = pk.get(it.package_id);
    if (!p || !it.decided_at) continue;
    const opts = (Array.isArray(it.options) ? it.options : []) as OptionRow[];
    const chosen = opts.find((o) => o.id === it.recommended_option_id) ?? opts.find((o) => o.recommended) ?? opts[0];
    if (!chosen) continue;
    const email = (p.customer_email ?? "").trim().toLowerCase(), phone = digits(p.customer_phone);
    const later = quotes.some((q) => Date.parse(q.created_at) > Date.parse(it.decided_at as string) &&
      ((email && (q.customer_email ?? "").trim().toLowerCase() === email) || (phone.length >= 7 && digits(q.customer_phone) === phone)));
    out.push({
      itemId: it.id, packageId: p.id, jobId: p.job_id, severity: it.severity, decidedAt: it.decided_at,
      optionTotalCents: lineItemsTotalCents(chosen.line_items, p.tax_percent),
      equipmentAgeYears: null, endOfLifeYears: null, // equipment age is not joined yet → only the severity path fires
      customerName: p.customer_name, ownerId: null, laterQuoteOrJob: later,
    });
  }
  return out;
}

// ---- margin_guardrail_checks (verdict 'overridden') + quotes
export interface GuardrailRow { id: string; quote_id: string; requested_by: string | null; revenue_cents: number; estimated_cost_cents: number; margin_floor_pct: number; verdict: string; override_reason: string | null; created_at: string }
export interface QuoteStatusRow { id: string; status: string; customer_name: string }
export function mapDiscounts(checks: GuardrailRow[], quotes: QuoteStatusRow[]): DiscountFact[] {
  const q = new Map(quotes.map((x) => [x.id, x]));
  return checks.filter((c) => c.verdict === "overridden" && q.has(c.quote_id)).map((c) => ({
    checkId: c.id, quoteId: c.quote_id, quoteStatus: q.get(c.quote_id)!.status, revenueCents: cents(c.revenue_cents),
    costCents: cents(c.estimated_cost_cents), floorPct: Number(c.margin_floor_pct) || 0, overrideReason: c.override_reason,
    ownerId: c.requested_by, occurredAt: c.created_at, customerName: q.get(c.quote_id)!.customer_name,
  }));
}

// ---- warranty_claims
export interface WarrantyRow { id: string; job_id: string | null; customer_name: string; status: string; claimed_amount_cents: number | null; part_cost_cents: number | null; labor_cost_cents: number | null; claim_deadline: string | null; created_at: string }
export const mapWarranty = (rows: WarrantyRow[]): WarrantyFact[] => rows.map((r) => ({
  id: r.id, jobId: r.job_id, status: r.status, claimedCents: r.claimed_amount_cents === null ? null : cents(r.claimed_amount_cents),
  partCostCents: cents(r.part_cost_cents), laborCostCents: cents(r.labor_cost_cents), claimDeadline: r.claim_deadline,
  occurredAt: r.created_at, customerName: r.customer_name,
}));

// ---- recurring_agreements
export interface AgreementRow { id: string; customer_id: string | null; customer_name: string; title: string; service_type: string | null; interval_unit: "week" | "month" | "year"; interval_count: number; start_date: string; end_date: string | null; price_amount: number | null; status: string; preferred_technician_id: string | null }
export function occurrencesPerYear(unit: AgreementRow["interval_unit"], count: number): number {
  const n = Math.max(1, Math.round(count) || 1);
  return unit === "week" ? 52 / n : unit === "month" ? 12 / n : 1 / n;
}
export function mapAgreements(expiring: AgreementRow[], allActive: AgreementRow[]): AgreementFact[] {
  return expiring.map((a) => {
    const end = Date.parse(a.end_date ?? "");
    const successor = allActive.some((b) => b.id !== a.id && b.status === "active" && b.customer_id !== null && b.customer_id === a.customer_id &&
      (b.service_type ?? "") === (a.service_type ?? "") && Date.parse(b.start_date) >= end - DAY * 30);
    return {
      id: a.id, title: a.title, customerName: a.customer_name, status: a.status, endDate: a.end_date,
      annualValueCents: Math.round(cents(Number(a.price_amount ?? 0) * 100) * occurrencesPerYear(a.interval_unit, a.interval_count)),
      successorExists: successor, ownerId: a.preferred_technician_id,
    };
  });
}

// ---- jobs vs price_book_items (flat-priced services only; hourly/range/starting_at are not comparable)
export interface JobPriceRow { id: string; customer_name: string; service_type: string | null; invoice_amount: number | null; assigned_technician_id: string | null; scheduled_datetime: string | null; created_at: string }
export interface PriceBookRow { service_name: string; pricing_model: string; price_cents: number; keywords: string[] | null; active: boolean }
export function mapUnderpriced(jobs: JobPriceRow[], book: PriceBookRow[]): UnderpricedFact[] {
  const flat = book.filter((b) => b.active && b.pricing_model === "flat" && b.price_cents > 0);
  const out: UnderpricedFact[] = [];
  for (const j of jobs) {
    const svc = (j.service_type ?? "").trim().toLowerCase();
    if (!svc) continue;
    const exact = flat.find((b) => b.service_name.trim().toLowerCase() === svc);
    const kw = exact ? undefined : flat.find((b) => (b.keywords ?? []).some((k) => k.trim().toLowerCase() === svc));
    const hit = exact ?? kw;
    if (!hit) continue;
    out.push({
      jobId: j.id, service: j.service_type as string, invoicedCents: cents(Number(j.invoice_amount ?? 0) * 100), bookCents: hit.price_cents,
      match: exact ? "exact" : "keyword", technicianId: j.assigned_technician_id, occurredAt: j.scheduled_datetime ?? j.created_at, customerName: j.customer_name,
    });
  }
  return out;
}

// ---- captured revenue (cash actually received), bucketed by UTC month
export interface CashRow { cents: number; at: string }
export const monthKey = (iso: string) => iso.slice(0, 7) + "-01";
export function capturedByMonth(rows: CashRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!Number.isFinite(Date.parse(r.at)) || !(r.cents > 0)) continue;
    const k = monthKey(new Date(r.at).toISOString());
    out[k] = (out[k] ?? 0) + Math.round(r.cents);
  }
  return out;
}
