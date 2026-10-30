// Thin, typed Stripe REST calls for instant payouts (no SDK, same style as ../stripe/client.ts).
// `fetchImpl` is injectable so tests can mock Stripe without touching the network.
import { StripeApiError } from "../stripe/client.ts";
import type { ExternalAccountSummary, InstantBalance } from "./logic.ts";
import { INSTANT_PAYOUT_CURRENCY } from "./logic.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface StripeCtx {
  secretKey: string;
  fetchImpl?: FetchLike;
}

function flatten(params: Record<string, unknown>, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const path = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((item) => out.push([`${path}[]`, String(item)]));
    else if (typeof value === "object") out.push(...flatten(value as Record<string, unknown>, path));
    else out.push([path, String(value)]);
  }
  return out;
}

async function call(
  ctx: StripeCtx,
  method: "GET" | "POST",
  path: string,
  opts: { params?: Record<string, unknown>; stripeAccount?: string; idempotencyKey?: string } = {},
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const doFetch: FetchLike = ctx.fetchImpl ?? ((input, init) => fetch(input, init));
  const pairs = flatten(opts.params ?? {});
  const query = new URLSearchParams(pairs).toString();
  const url = `https://api.stripe.com/v1/${path}${method === "GET" && query ? `?${query}` : ""}`;

  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.secretKey}` };
  if (opts.stripeAccount) headers["Stripe-Account"] = opts.stripeAccount;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";

  const res = await doFetch(url, { method, headers, body: method === "POST" ? new URLSearchParams(pairs).toString() : undefined });
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    throw new StripeApiError(data?.error?.message || `Stripe API error (${res.status})`, res.status, data?.error?.code);
  }
  if (data === null || typeof data !== "object") throw new StripeApiError("Stripe returned an unreadable response.", 502);
  return data;
}

/** Instant balance of the connected account, with the per-destination net (after platform fee) expanded. */
export async function getInstantBalance(ctx: StripeCtx, accountId: string): Promise<InstantBalance | null> {
  const data = await call(ctx, "GET", "balance", { params: { expand: ["instant_available.net_available"] }, stripeAccount: accountId });
  // deno-lint-ignore no-explicit-any
  const entry = (data.instant_available ?? []).find((e: any) => e?.currency === INSTANT_PAYOUT_CURRENCY);
  if (!entry) return null;
  const netByDestination: Record<string, number> = {};
  // deno-lint-ignore no-explicit-any
  for (const n of (entry.net_available ?? []) as any[]) {
    if (typeof n?.destination === "string" && Number.isInteger(n.amount)) netByDestination[n.destination] = n.amount;
  }
  return { currency: INSTANT_PAYOUT_CURRENCY, grossCents: Number.isInteger(entry.amount) ? entry.amount : 0, netByDestination };
}

export async function listExternalAccounts(ctx: StripeCtx, accountId: string): Promise<ExternalAccountSummary[]> {
  const data = await call(ctx, "GET", `accounts/${encodeURIComponent(accountId)}/external_accounts`, { params: { limit: 20 } });
  // deno-lint-ignore no-explicit-any
  return ((data.data ?? []) as any[])
    .filter((a) => a && typeof a.id === "string" && (a.object === "card" || a.object === "bank_account"))
    .map((a) => {
      const isCard = a.object === "card";
      const last4 = typeof a.last4 === "string" ? a.last4 : null;
      const name = isCard ? `${a.brand ?? "Card"}${a.funding === "debit" ? " debit" : ""}` : a.bank_name || "Bank account";
      return {
        id: a.id,
        type: a.object,
        label: last4 ? `${name} •••• ${last4}` : name,
        last4,
        currency: String(a.currency ?? "").toLowerCase(),
        defaultForCurrency: a.default_for_currency === true,
        instantCapable: Array.isArray(a.available_payout_methods) && a.available_payout_methods.includes("instant"),
        usable: !["errored", "verification_failed"].includes(a.status) && a.funding !== "prepaid",
      } satisfies ExternalAccountSummary;
    });
}

export interface InstantPayoutResult {
  id: string;
  status: string;
  amount: number;
  arrivalDate: string | null;
  applicationFeeCents: number | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export async function createInstantPayout(
  ctx: StripeCtx,
  accountId: string,
  input: { amountCents: number; destinationId: string; idempotencyKey: string; payoutRowId: string },
): Promise<InstantPayoutResult> {
  const p = await call(ctx, "POST", "payouts", {
    stripeAccount: accountId,
    idempotencyKey: input.idempotencyKey,
    params: {
      amount: input.amountCents,
      currency: INSTANT_PAYOUT_CURRENCY,
      method: "instant",
      destination: input.destinationId,
      metadata: { instant_payout_id: input.payoutRowId },
    },
  });
  return {
    id: String(p.id),
    status: String(p.status ?? "in_transit"),
    amount: Number.isInteger(p.amount) ? p.amount : input.amountCents,
    arrivalDate: Number.isFinite(p.arrival_date) ? new Date(p.arrival_date * 1000).toISOString() : null,
    applicationFeeCents: Number.isInteger(p.application_fee_amount) ? p.application_fee_amount : null,
    failureCode: p.failure_code ?? null,
    failureMessage: p.failure_message ?? null,
  };
}

/** One-time link into the connected account's Express dashboard (add a debit card, fix verification). */
export async function createExpressLoginLink(ctx: StripeCtx, accountId: string): Promise<string> {
  const link = await call(ctx, "POST", `accounts/${encodeURIComponent(accountId)}/login_links`);
  if (typeof link.url !== "string") throw new StripeApiError("Stripe did not return a dashboard link.", 502);
  return link.url;
}
