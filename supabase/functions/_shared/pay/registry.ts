// supabase/functions/_shared/pay/registry.ts
//
// Mode → adapter. The mode comes from the DATABASE (pay_platform_controls), never from an
// env var, so a staff kill/mode change takes effect on the next request.
// Add a real partner by importing it here and returning it from the matching live branch.

import type { CardIssuer, LendingPartner, PayMode, PayoutProvider } from "./types.ts";
import { sandboxCardIssuer, sandboxLendingPartner, sandboxPayoutProvider } from "./providers/sandbox.ts";
import { unconfiguredCardIssuer, unconfiguredLendingPartner, unconfiguredPayoutProvider } from "./providers/live.ts";

export function getPayoutProvider(mode: PayMode): PayoutProvider {
  if (mode === "sandbox") return sandboxPayoutProvider;
  // LIVE: return your contracted partner here, e.g. `return acmePayoutProvider;`
  return unconfiguredPayoutProvider;
}

export function getCardIssuer(mode: PayMode): CardIssuer {
  if (mode === "sandbox") return sandboxCardIssuer;
  return unconfiguredCardIssuer;
}

export function getLendingPartner(mode: PayMode): LendingPartner {
  if (mode === "sandbox") return sandboxLendingPartner;
  return unconfiguredLendingPartner;
}
