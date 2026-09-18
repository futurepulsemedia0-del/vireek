// supabase/functions/_shared/financing/providers/wisetack.ts
//
// ============================================================
// VERIFY BEFORE PRODUCTION USE — same rule this project already
// follows in _shared/price-book/servicetitan.ts.
// ============================================================
// Wisetack's real partner-API base URL, exact endpoint path, request/
// response field names, and webhook signature header format are behind
// a signed partner agreement and were NOT verified against live
// documentation for this file. Everything below is a best-effort
// implementation of the common BNPL "create transaction, get an
// application URL back, receive a signed webhook on status change"
// shape used across this category of provider — the STRUCTURE (how
// this plugs into financing-create-offer / financing-webhook) is
// solid; the literal endpoint path, field names, and signature scheme
// marked below MUST be checked against Wisetack's actual partner docs
// (developer.wisetack.com, partner-only) before this adapter is used
// with real money.
//
// Needs verification:
//   - WISETACK_API_BASE / the exact endpoint path
//   - request field names (amountCents, merchantId, description, ...)
//   - response field names (transactionId vs id, applicationUrl vs url)
//   - webhook header name + signature scheme (this assumes a Stripe-
//     style "t=<ts>,v1=<hmac>" header; Wisetack's may differ)
//   - webhook payload field names / event type strings

import type {
  FinancingProviderAdapter,
  CreateFinancingOfferParams,
  CreateFinancingOfferResult,
  FinancingWebhookEvent,
  FinancingOfferStatus,
} from "../types.ts";

const WISETACK_API_BASE = "https://api.wisetack.com/v1"; // VERIFY

function apiKey(): string | undefined {
  return Deno.env.get("WISETACK_API_KEY");
}

async function verifyHmacSignature(payload: string, header: string, secret: string, toleranceSeconds = 300): Promise<boolean> {
  // Generic timestamped-HMAC verifier, same mechanism as
  // _shared/stripe/client.ts's verifyStripeSignature. Wisetack's actual
  // header format may not match "t=...,v1=..." — VERIFY.
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

// Best-effort mapping from a Wisetack-style event/status string to our
// own FinancingOfferStatus enum — VERIFY the left-hand strings against
// real webhook payloads.
const STATUS_MAP: Record<string, FinancingOfferStatus> = {
  transaction_created: "sent",
  application_started: "clicked",
  application_submitted: "applied",
  loan_approved: "approved",
  loan_declined: "declined",
  transaction_expired: "expired",
  loan_confirmed: "loan_confirmed",
  loan_funded: "funded",
  transaction_canceled: "canceled",
};

export const wisetackAdapter: FinancingProviderAdapter = {
  id: "wisetack",

  isConfigured(): boolean {
    return Boolean(apiKey());
  },

  async createOffer(params: CreateFinancingOfferParams): Promise<CreateFinancingOfferResult> {
    const key = apiKey();
    if (!key) throw new Error("WISETACK_API_KEY is not configured.");

    const res = await fetch(`${WISETACK_API_BASE}/transactions`, {
      // VERIFY: path
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // VERIFY: every field name below against real docs.
        merchantId: params.externalMerchantId,
        amount: params.amountCents,
        description: params.description,
        customer: {
          name: params.customerName,
          email: params.customerEmail,
          phone: params.customerPhone,
        },
        successUrl: params.successUrl,
        cancelUrl: params.cancelUrl,
        referenceId: params.referenceId,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Wisetack API error (${res.status}): ${text}`);
    }

    const data = await res.json();
    // VERIFY: response field names.
    const externalTransactionId = data?.transactionId ?? data?.id;
    const applicationUrl = data?.applicationUrl ?? data?.url;
    if (!externalTransactionId || !applicationUrl) {
      throw new Error("Unexpected Wisetack response shape — verify the adapter against current API docs.");
    }

    return { externalTransactionId, applicationUrl };
  },

  async verifyWebhookSignature(payload: string, headers: Headers): Promise<boolean> {
    const secret = Deno.env.get("WISETACK_WEBHOOK_SECRET");
    const signatureHeader = headers.get("Wisetack-Signature"); // VERIFY header name
    if (!secret || !signatureHeader) return false;
    return verifyHmacSignature(payload, signatureHeader, secret);
  },

  parseWebhookEvent(payload: string): FinancingWebhookEvent | null {
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      return null;
    }

    // VERIFY: every field path below.
    const externalTransactionId = json?.transactionId ?? json?.data?.transactionId;
    const eventType = json?.type ?? json?.event;
    if (!externalTransactionId || !eventType) return null;

    const status = STATUS_MAP[eventType];
    if (!status) return null;

    return {
      externalTransactionId,
      eventType,
      status,
      approvedAmountCents: json?.approvedAmount ?? json?.data?.approvedAmount,
      aprBps: json?.aprBps ?? json?.data?.aprBps,
      termMonths: json?.termMonths ?? json?.data?.termMonths,
      declineReason: json?.declineReason ?? json?.data?.declineReason,
    };
  },
};
