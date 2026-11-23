// supabase/functions/_shared/compliance-rules/canadaGate.ts
//
// I/O side of the Canada gate: "no Canadian outbound contact until the Canada rule pack is enabled".
// Used by the central outbound gate (messaging/quietHours.ts -> gateOutbound) and by speed-to-lead.
// NOT LEGAL ADVICE — [COUNSEL][VERIFY]. Fail-closed: if the catalog cannot be read for a Canadian
// recipient, the contact is blocked.
//
// Detection limits (documented, not hidden): a recipient is only recognised as Canadian from a Canadian
// postal code / "Canada" in the address or a Canadian NANP area code. An email-only contact with no
// address, or a Canadian number whose area code is missing from CA_AREA_CODES, is NOT detected.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { selectEffective } from "./engine.ts";
import { canadaGateMessage, canadaPackStatus, isCaGatedSurface, type CaGatedSurface } from "./canada.ts";
import { resolveCounterpartyCountry } from "./jurisdiction.ts";
import type { RuleVersion } from "./types.ts";

export type CanadaBlock =
  | { blocked: false }
  | { blocked: true; reason: "pack_not_enabled" | "catalog_unavailable"; missing: string[]; message: string };

/** Pure: decide from an already-loaded catalog (unit-tested). */
export function canadaBlockFromCatalog(catalog: readonly RuleVersion[], surface: CaGatedSurface, dateKey: string): CanadaBlock {
  const status = canadaPackStatus(selectEffective(catalog, dateKey), surface);
  return status.enabled ? { blocked: false } : { blocked: true, reason: "pack_not_enabled", missing: status.missing, message: canadaGateMessage(surface, status.missing) };
}

export interface CanadaBlockInput {
  channel: string;
  /** Phone (sms/call) or email address. */
  to: string;
  phone?: string | null;
  address?: string | null;
  explicitCountry?: string | null;
}

export async function canadaOutboundBlock(admin: SupabaseClient, input: CanadaBlockInput, now: Date = new Date()): Promise<CanadaBlock> {
  if (!isCaGatedSurface(input.channel)) return { blocked: false };
  const resolved = resolveCounterpartyCountry({
    explicitCountry: input.explicitCountry,
    address: input.address,
    phone: input.channel === "email" ? input.phone : input.to,
  });
  if (resolved.country !== "CA") return { blocked: false };
  try {
    const { data, error } = await admin.rpc("compliance_catalog");
    if (error) throw new Error(error.message);
    return canadaBlockFromCatalog((data ?? []) as RuleVersion[], input.channel, now.toISOString().slice(0, 10));
  } catch (e) {
    console.error(JSON.stringify({ event: "canada_gate_catalog_failed", error: String(e) }));
    const message = canadaGateMessage(input.channel, ["catalog unavailable"]);
    return { blocked: true, reason: "catalog_unavailable", missing: ["catalog unavailable"], message };
  }
}
