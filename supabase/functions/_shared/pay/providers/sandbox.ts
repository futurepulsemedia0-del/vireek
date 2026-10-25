// supabase/functions/_shared/pay/providers/sandbox.ts
//
// SANDBOX adapters. They move NO money, issue NO real cards and make NO credit decisions.
// Every result is stamped sandbox: true and persisted with sandbox = true; the UI shows a
// permanent "Sandbox" banner. They exist so the full flow (reserve → provider → finalize →
// ledger → UI) can be exercised end to end before a licensed partner is contracted.
//
// Deterministic QA hooks (amounts in cents):
//   payout   amount ending in …13        → failed (sandbox_insufficient_funds)
//   payout   amount ending in …77        → processing (settles later via webhook)
//   lending  requested === 131_300       → declined with a fixture reason
//   card     issueCard never fails
// Lending offers are a FIXTURE with fixed illustrative terms. They are NOT derived from the
// applicant's data, so the sandbox can never be mistaken for (or become) a credit decision.

import type {
  CardAuthorizationEvent, CardIssuer, IssueCardRequest, IssuedCard, LendingDataPackage, LendingPartner,
  LendingSubmitResult, PayoutProvider, PayoutRequest, PayoutResult, PayoutWebhookEvent,
} from "../types.ts";

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Sandbox webhooks are signed `x-sandbox-signature: <hex hmac of body>` with PAY_SANDBOX_WEBHOOK_SECRET. */
async function verifySandboxSignature(payload: string, headers: Headers): Promise<boolean> {
  const secret = typeof Deno !== "undefined" ? Deno.env.get("PAY_SANDBOX_WEBHOOK_SECRET") : undefined;
  const sig = headers.get("x-sandbox-signature");
  if (!secret || !sig) return false;
  return timingSafeEqual(await hmacHex(secret, payload), sig.toLowerCase());
}

export const sandboxPayoutProvider: PayoutProvider = {
  id: "sandbox",
  mode: "sandbox",
  isConfigured: () => true,
  async createPayout(req: PayoutRequest): Promise<PayoutResult> {
    const externalId = `sbx_po_${req.referenceId}`;
    if (req.amountCents % 100 === 13) return { status: "failed", externalId, failureCode: "sandbox_insufficient_funds", sandbox: true };
    if (req.amountCents % 100 === 77) return { status: "processing", externalId, sandbox: true };
    return { status: "paid", externalId, sandbox: true };
  },
  verifyWebhookSignature: verifySandboxSignature,
  parseWebhookEvent(payload: string): PayoutWebhookEvent | null {
    try {
      const j = JSON.parse(payload);
      if (typeof j?.external_id !== "string" || !["processing", "paid", "failed", "reversed"].includes(j?.status)) return null;
      return { externalId: j.external_id, status: j.status, failureCode: typeof j.failure_code === "string" ? j.failure_code : undefined };
    } catch { return null; }
  },
};

export const sandboxCardIssuer: CardIssuer = {
  id: "sandbox",
  mode: "sandbox",
  isConfigured: () => true,
  async issueCard(req: IssueCardRequest): Promise<IssuedCard> {
    // 4242-style fixture last4 derived from the reference so it is stable and obviously fake.
    const digits = req.referenceId.replace(/\D/g, "").padEnd(4, "0").slice(0, 4);
    return { externalCardId: `sbx_card_${req.referenceId}`, last4: digits, brand: "sandbox", sandbox: true };
  },
  async setCardStatus(): Promise<void> { /* no provider to call */ },
  verifyWebhookSignature: verifySandboxSignature,
  parseAuthorizationEvent(payload: string): CardAuthorizationEvent | null {
    try {
      const j = JSON.parse(payload);
      if (typeof j?.auth_id !== "string" || typeof j?.card_id !== "string" || !Number.isSafeInteger(j?.amount_cents)) return null;
      return {
        externalAuthId: j.auth_id, externalCardId: j.card_id, amountCents: j.amount_cents,
        currency: typeof j.currency === "string" ? j.currency : "usd",
        merchantName: typeof j.merchant_name === "string" ? j.merchant_name : null,
        mcc: typeof j.mcc === "string" ? j.mcc : null,
      };
    } catch { return null; }
  },
};

export const sandboxLendingPartner: LendingPartner = {
  id: "sandbox",
  mode: "sandbox",
  isConfigured: () => true,
  async submitApplication(referenceId: string, pkg: LendingDataPackage): Promise<LendingSubmitResult> {
    const externalApplicationId = `sbx_app_${referenceId}`;
    if (pkg.requestedAmountCents === 131_300) {
      return { externalApplicationId, outcome: "declined", offers: [], declineReasons: ["SANDBOX FIXTURE: simulated partner decline."], sandbox: true };
    }
    const amount = pkg.requestedAmountCents;
    const charge = Math.round(amount * 0.12);   // illustrative fixture: 12% flat, 180 days
    return {
      externalApplicationId, outcome: "offers", sandbox: true,
      offers: [{
        externalOfferId: `sbx_offer_${referenceId}`,
        offeredAmountCents: amount,
        totalRepaymentCents: amount + charge,
        financeChargeCents: charge,
        termDays: 180,
        estimatedAprBps: 2400,
        repaymentDescription: "SANDBOX FIXTURE — illustrative only. Not a real offer of credit. A real partner supplies its own terms.",
        termsUrl: null,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }],
    };
  },
  async acceptOffer() { return { status: "accepted" as const, sandbox: true }; },
  async withdrawApplication(): Promise<void> { /* nothing to withdraw */ },
  verifyWebhookSignature: verifySandboxSignature,
};
