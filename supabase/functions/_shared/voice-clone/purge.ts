// Orchestrates deleting a cloned voice: block use -> remove sample audio -> delete at the provider -> VERIFY it is gone
// -> record the result. Pure orchestration over injected dependencies, so every branch is unit-tested without a network.
//
// Rules this file enforces:
//  * Use is blocked first, so revocation/expiry takes effect even if the provider call fails.
//  * "Deleted" is only claimed after the provider confirms the voice no longer exists (verifyGone === "gone").
//  * Nothing that is still needed for a retry (provider voice id, sample path) is cleared unless its deletion is confirmed.
//  * Never throws: every failure becomes part of the returned outcome.

export type PurgeReason = "retention_expired" | "revoked" | "owner_deleted" | "provider_cleanup";
export type ProviderDeleteResult = "deleted" | "not_found" | "failed" | "skipped";
export type VerifyGoneResult = "gone" | "still_exists" | "unknown";

export interface PurgeTarget {
  consentId: string;
  userId: string;
  providerVoiceId: string | null;
  /** Exact storage paths inside the `voice-samples` bucket to remove. */
  samplePaths: string[];
  reason: PurgeReason;
  /** Result of switching the live assistant away from the clone first (retention sweep only). Recorded as evidence. */
  assistantRestore?: "not_needed" | "restored" | "no_preset" | "skipped" | "failed";
}

export interface PurgeOutcome {
  /** "purged": provider copy verified gone and sample audio removed. "incomplete": something must be retried. */
  status: "purged" | "incomplete";
  providerDelete: ProviderDeleteResult;
  providerVerified: boolean;
  samplesRemoved: number;
  samplesFailed: boolean;
  blockFailed: boolean;
  error: string | null;
}

export interface PurgeDeps {
  /** Stop live use now (clear the business profile pointer). Must only touch a pointer to THIS voice. */
  blockUse(t: PurgeTarget): Promise<void>;
  deleteVoice(voiceId: string): Promise<"deleted" | "not_found" | "failed">;
  verifyGone(voiceId: string): Promise<VerifyGoneResult>;
  removeSamples(userId: string, paths: string[]): Promise<{ removed: number; failed: boolean }>;
  /** Persist the outcome on the consent row and in the purge log. */
  record(t: PurgeTarget, o: PurgeOutcome): Promise<void>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function purgeClonedVoice(t: PurgeTarget, deps: PurgeDeps): Promise<PurgeOutcome> {
  const out: PurgeOutcome = {
    status: "incomplete", providerDelete: "skipped", providerVerified: false,
    samplesRemoved: 0, samplesFailed: false, blockFailed: false, error: null,
  };
  const errors: string[] = [];

  // 1. Block use first.
  try { await deps.blockUse(t); } catch (e) { out.blockFailed = true; errors.push(`block_use: ${msg(e)}`); }

  // 2. Raw sample audio (the most sensitive artefact: a recording of a person's voice).
  try {
    const r = await deps.removeSamples(t.userId, t.samplePaths);
    out.samplesRemoved = r.removed;
    out.samplesFailed = r.failed;
    if (r.failed) errors.push("samples_not_removed");
  } catch (e) { out.samplesFailed = true; errors.push(`samples: ${msg(e)}`); }

  // 3. Provider-side voice: delete, then verify.
  if (!t.providerVoiceId) {
    out.providerDelete = "skipped";
    out.providerVerified = true; // nothing exists at the provider for this record
  } else {
    try {
      const d = await deps.deleteVoice(t.providerVoiceId);
      out.providerDelete = d;
      if (d === "failed") {
        errors.push("provider_delete_failed");
      } else {
        const v = await deps.verifyGone(t.providerVoiceId);
        out.providerVerified = v === "gone";
        if (v !== "gone") errors.push(v === "still_exists" ? "provider_still_has_voice" : "provider_verify_unknown");
      }
    } catch (e) { out.providerDelete = "failed"; errors.push(`provider: ${msg(e)}`); }
  }

  out.status = out.providerVerified && !out.samplesFailed ? "purged" : "incomplete";
  out.error = errors.length ? errors.join("; ").slice(0, 500) : null;

  // 4. Record. A recording failure must not hide the real outcome from the caller.
  try { await deps.record(t, out); } catch (e) {
    out.error = [out.error, `record_failed: ${msg(e)}`].filter(Boolean).join("; ").slice(0, 500);
    out.status = "incomplete";
  }
  return out;
}

/** Whether a restore failure should postpone deletion to the next sweep (bounded, so deletion is never blocked forever). */
export function shouldDeferForRestore(restore: string, attempts: number, maxDeferrals: number): boolean {
  return restore === "failed" && attempts < maxDeferrals;
}
