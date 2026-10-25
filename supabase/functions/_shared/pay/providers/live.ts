// supabase/functions/_shared/pay/providers/live.ts
//
// THE PROVIDER BOUNDARY. Nothing here moves money, issues cards or underwrites credit.
// These are the exact seams where a contracted, licensed partner plugs in. Until an adapter
// below is replaced with a real implementation AND its secrets are set, isConfigured() is
// false and every call refuses — the system never falls back to sandbox in live mode and
// never pretends a live action succeeded.
//
// To integrate a partner (e.g. a licensed payout/EWA processor, a card-issuing program
// manager, a commercial lending partner):
//   1. Create providers/<partner>.ts implementing PayoutProvider / CardIssuer / LendingPartner
//      (see types.ts). Verify every endpoint, field name and webhook-signature scheme against
//      the partner's signed documentation — do NOT guess (same rule as financing/wisetack.ts).
//   2. Register it in registry.ts (one line) behind an env switch, e.g. PAY_LIVE_PAYOUT_PROVIDER.
//   3. Set its secrets, complete the checklist in docs/PAY_AND_CAPITAL.md, have counsel
//      mark the disclosures reviewed, and only then flip the product to live in /staff/pay-controls.

import type { CardIssuer, LendingPartner, PayoutProvider } from "../types.ts";
import { ProviderBoundaryError } from "../types.ts";

const refuse = (what: string): never => {
  throw new ProviderBoundaryError("provider_not_configured", `No licensed ${what} partner is configured for live mode.`);
};

export const unconfiguredPayoutProvider: PayoutProvider = {
  id: "unconfigured", mode: "live",
  isConfigured: () => false,
  createPayout: async () => refuse("payout"),
  verifyWebhookSignature: async () => false,
  parseWebhookEvent: () => null,
};

export const unconfiguredCardIssuer: CardIssuer = {
  id: "unconfigured", mode: "live",
  isConfigured: () => false,
  issueCard: async () => refuse("card-issuing"),
  setCardStatus: async () => refuse("card-issuing"),
  verifyWebhookSignature: async () => false,
  parseAuthorizationEvent: () => null,
};

export const unconfiguredLendingPartner: LendingPartner = {
  id: "unconfigured", mode: "live",
  isConfigured: () => false,
  submitApplication: async () => refuse("lending"),
  acceptOffer: async () => refuse("lending"),
  withdrawApplication: async () => refuse("lending"),
  verifyWebhookSignature: async () => false,
};
