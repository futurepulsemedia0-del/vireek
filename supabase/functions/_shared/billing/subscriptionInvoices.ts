// supabase/functions/_shared/billing/subscriptionInvoices.ts
//
// Pure helpers behind the billing-invoices edge function: Stripe -> DTO
// mapping and the "may this person see billing?" rule. No Deno or Stripe SDK
// imports on purpose, so vitest covers all of it without mocking anything.

export type InvoiceStatus = "open" | "paid" | "void" | "uncollectible";

export interface StripeInvoiceLike {
  id: string;
  number?: string | null;
  status?: string | null;
  created: number;
  currency: string;
  total: number;
  amount_due: number;
  amount_paid: number;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  period_start?: number | null;
  period_end?: number | null;
  next_payment_attempt?: number | null;
  attempt_count?: number | null;
  total_excluding_tax?: number | null;
  tax?: number | null;
  customer_tax_exempt?: string | null;
  customer_tax_ids?: Array<{ type?: string | null; value?: string | null }> | null;
  /** `tax_rate` is an id unless the request expanded `data.total_tax_amounts.tax_rate`. */
  total_tax_amounts?: Array<{
    amount?: number | null;
    inclusive?: boolean | null;
    taxability_reason?: string | null;
    tax_rate?: string | { display_name?: string | null; percentage?: number | null; jurisdiction?: string | null } | null;
  }> | null;
  lines?: {
    data?: Array<{ description?: string | null; period?: { start?: number | null; end?: number | null } | null }>;
  } | null;
}

export interface InvoiceDto {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  description: string | null;
  currency: string;
  total: number;
  amountDue: number;
  amountPaid: number;
  pdfUrl: string | null;
  hostedUrl: string | null;
  attemptCount: number;
  nextPaymentAttemptAt: string | null;
  /** Total before tax; null when Stripe did not report it. */
  totalExcludingTax: number | null;
  taxTotal: number;
  taxLines: InvoiceTaxLineDto[];
  /** True when Stripe applied reverse charge (business customer accounts for the tax). */
  reverseCharge: boolean;
  customerTaxIds: InvoiceTaxIdDto[];
}
export interface InvoiceTaxLineDto {
  /** Stripe's own label (for example "VAT"); null when the rate was not expanded. */
  label: string | null;
  /** Rate as reported by Stripe; never computed or hardcoded here. */
  percentage: number | null;
  jurisdiction: string | null;
  amount: number;
  inclusive: boolean;
  taxabilityReason: string | null;
}

export interface InvoiceTaxIdDto {
  /** Stripe tax-ID type such as "eu_vat". */
  type: string;
  value: string;
}
export interface StripePaymentMethodLike {
  id: string;
  card?: {
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
    funding?: string | null;
  } | null;
}

export interface CardDto {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  funding: string | null;
  isDefault: boolean;
}

const VISIBLE_STATUSES: ReadonlySet<string> = new Set(["open", "paid", "void", "uncollectible"]);

/** Only https URLs ever reach the browser (blocks javascript:/data: schemes). */
export function httpsUrlOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function isoFromUnix(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}
const cleanText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

function normalizeTaxLines(inv: StripeInvoiceLike): InvoiceTaxLineDto[] {
  const raw = Array.isArray(inv.total_tax_amounts) ? inv.total_tax_amounts : [];
  const lines: InvoiceTaxLineDto[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry.amount !== "number" || !Number.isFinite(entry.amount)) continue;
    const rate = entry.tax_rate && typeof entry.tax_rate === "object" ? entry.tax_rate : null;
    lines.push({
      label: cleanText(rate?.display_name, 40),
      percentage: typeof rate?.percentage === "number" && Number.isFinite(rate.percentage) ? rate.percentage : null,
      jurisdiction: cleanText(rate?.jurisdiction, 60),
      amount: entry.amount,
      inclusive: entry.inclusive === true,
      taxabilityReason: cleanText(entry.taxability_reason, 40),
    });
  }
  return lines;
}

function normalizeTaxIds(inv: StripeInvoiceLike): InvoiceTaxIdDto[] {
  const raw = Array.isArray(inv.customer_tax_ids) ? inv.customer_tax_ids : [];
  const ids: InvoiceTaxIdDto[] = [];
  for (const entry of raw) {
    const type = cleanText(entry?.type, 32);
    const value = cleanText(entry?.value, 64);
    if (type && value) ids.push({ type, value });
    if (ids.length >= 5) break;
  }
  return ids;
}
/** Returns null for drafts and unknown statuses — those are not customer-facing. */
export function normalizeInvoice(inv: StripeInvoiceLike): InvoiceDto | null {
  if (!inv.status || !VISIBLE_STATUSES.has(inv.status)) return null;
  const line = inv.lines?.data?.[0];
  const rawDescription = line?.description?.trim() ?? "";
  const taxLines = normalizeTaxLines(inv);
  return {
    id: inv.id,
    number: inv.number ?? null,
    status: inv.status as InvoiceStatus,
    createdAt: isoFromUnix(inv.created) ?? new Date(0).toISOString(),
    periodStart: isoFromUnix(line?.period?.start ?? inv.period_start),
    periodEnd: isoFromUnix(line?.period?.end ?? inv.period_end),
    description: rawDescription ? rawDescription.slice(0, 140) : null,
    currency: inv.currency.toUpperCase(),
    total: inv.total,
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    pdfUrl: httpsUrlOrNull(inv.invoice_pdf),
    hostedUrl: httpsUrlOrNull(inv.hosted_invoice_url),
    attemptCount: inv.attempt_count ?? 0,
    nextPaymentAttemptAt: isoFromUnix(inv.next_payment_attempt),
    totalExcludingTax: typeof inv.total_excluding_tax === "number" ? inv.total_excluding_tax : null,
    taxTotal: taxLines.length > 0 ? taxLines.reduce((sum, l) => sum + l.amount, 0) : (typeof inv.tax === "number" ? inv.tax : 0),
    taxLines,
    reverseCharge: inv.customer_tax_exempt === "reverse" || taxLines.some((l) => l.taxabilityReason === "reverse_charge"),
    customerTaxIds: normalizeTaxIds(inv),
  };
}

export function normalizeCard(pm: StripePaymentMethodLike, defaultId: string | null): CardDto | null {
  const card = pm.card;
  if (!card?.last4 || !card.exp_month || !card.exp_year) return null;
  return {
    id: pm.id,
    brand: (card.brand ?? "card").toLowerCase(),
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year,
    funding: card.funding ?? null,
    isDefault: pm.id === defaultId,
  };
}

/** Default card first, then the rest in Stripe's order. */
export function sortCards(cards: CardDto[]): CardDto[] {
  return [...cards].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

type PermissionMap = Partial<Record<string, boolean>> | null | undefined;

export interface BillingAccessInput {
  profileRole: string | null | undefined;
  /** null when the signed-in user has no team_members row. */
  member: { inviteStatus: string | null | undefined; permissions: PermissionMap; customRolePermissions: PermissionMap } | null;
}

/**
 * Mirrors AuthContext: owners always pass; everyone else needs an active
 * team_members row whose permissions — with the custom role layered on top,
 * exactly as the client merges them — grant can_view_billing.
 */
export function canViewBilling({ profileRole, member }: BillingAccessInput): boolean {
  if (profileRole === "owner") return true;
  if (!member || member.inviteStatus !== "active") return false;
  const merged = { ...(member.permissions ?? {}), ...(member.customRolePermissions ?? {}) };
  return merged.can_view_billing === true;
}
