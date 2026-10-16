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

/** Returns null for drafts and unknown statuses — those are not customer-facing. */
export function normalizeInvoice(inv: StripeInvoiceLike): InvoiceDto | null {
  if (!inv.status || !VISIBLE_STATUSES.has(inv.status)) return null;
  const line = inv.lines?.data?.[0];
  const rawDescription = line?.description?.trim() ?? "";
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
