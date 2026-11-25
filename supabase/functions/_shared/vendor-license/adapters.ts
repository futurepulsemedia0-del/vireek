// supabase/functions/_shared/vendor-license/adapters.ts
//
// Provider-adapter interface for subcontractor licence look-ups.
//
// Rules (same trust model as the Verification Network):
//   - An adapter NEVER throws and NEVER returns "verified" on its own failure. Anything that goes
//     wrong (no connector, bad config, HTTP error, timeout) becomes `manual_required`.
//   - A result is only produced by evaluateLicenseRecords(): holder-name match + active status +
//     unexpired date, from a primary source.
//   - No state is hard-coded. A state connector is DATA (a verification_sources row of provider
//     "socrata"); with no row for a state, that state is manual-only.
//
// Pure module: no Deno / Node globals except what the injected `fetchImpl` brings. Unit-tested.

import {
  evaluateLicenseRecords,
  isValidJurisdiction,
  licenseNumberCandidates,
  type Decision,
  type StatusMap,
} from "../verification-network/engine.ts";
import { querySocrata, validateSocrataConfig, type FetchLike } from "../verification-network/socrata.ts";

export interface LicenseLookupRequest {
  licenseNumber: string;
  jurisdiction: string; // US-XX
  /** Names the licence may be issued to: the vendor's legal / trading names. */
  holderNames: string[];
  today: string; // YYYY-MM-DD
}

export type ManualReason = "no_connector" | "invalid_request" | "invalid_config" | "lookup_failed";

export type LicenseLookupOutcome =
  | { kind: "result"; decision: Decision; sourceKey: string }
  | { kind: "manual_required"; reason: ManualReason; detail?: string };

export interface LicenseProviderAdapter {
  readonly key: string;
  supports(jurisdiction: string): boolean;
  lookup(req: LicenseLookupRequest): Promise<LicenseLookupOutcome>;
}

/** Always available fall-back: tells the caller to use the manual verification workflow. */
export const manualAdapter: LicenseProviderAdapter = {
  key: "manual",
  supports: () => true,
  lookup: async () => ({ kind: "manual_required", reason: "no_connector" }),
};

export interface SocrataSourceRow {
  source_key: string;
  jurisdiction: string;
  config: unknown;
}

/** Wraps one verification_sources row (provider = socrata, kind = license). */
export function createSocrataAdapter(source: SocrataSourceRow, fetchImpl: FetchLike, appToken?: string): LicenseProviderAdapter {
  const validated = validateSocrataConfig(source.config);
  return {
    key: source.source_key,
    supports: (j) => validated.ok && j === source.jurisdiction,
    async lookup(req) {
      if (!validated.ok) return { kind: "manual_required", reason: "invalid_config", detail: validated.error };
      if (!isValidJurisdiction(req.jurisdiction) || req.jurisdiction !== source.jurisdiction) {
        return { kind: "manual_required", reason: "invalid_request", detail: "jurisdiction mismatch" };
      }
      const candidates = licenseNumberCandidates(req.licenseNumber);
      if (candidates.length === 0) return { kind: "manual_required", reason: "invalid_request", detail: "licence number empty" };
      try {
        const records = await querySocrata(validated.config, candidates, fetchImpl, appToken);
        const statusMap: StatusMap = validated.config.status_map;
        const decision = evaluateLicenseRecords(records, { holderNames: req.holderNames, today: req.today, statusMap });
        return { kind: "result", decision, sourceKey: source.source_key };
      } catch (e) {
        // Do not echo upstream bodies: keep the detail short and generic.
        return { kind: "manual_required", reason: "lookup_failed", detail: e instanceof Error ? e.message.slice(0, 120) : "error" };
      }
    },
  };
}

/** First adapter that supports the state; manual when none does. */
export function resolveAdapter(adapters: LicenseProviderAdapter[], jurisdiction: string): LicenseProviderAdapter {
  return adapters.find((a) => a.key !== "manual" && a.supports(jurisdiction)) ?? manualAdapter;
}

/** Maps a primary-source decision onto the vendor_license_checks columns (status is never upgraded). */
export function decisionToLicenseCheck(decision: Decision): {
  license_status: "active" | "inactive" | "expired" | "suspended" | "revoked" | "unknown";
  expires_on: string | null;
  holder_name: string | null;
  needs_review: boolean;
} {
  return {
    license_status: decision.licenseStatus ?? "unknown",
    expires_on: decision.expiresOn,
    holder_name: decision.holderName,
    // Only a primary-source match may be stored as verified; everything else is a human's call.
    needs_review: decision.status !== "verified_primary" && decision.status !== "adverse",
  };
}
