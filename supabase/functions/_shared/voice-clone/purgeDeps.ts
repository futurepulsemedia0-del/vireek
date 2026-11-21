// Supabase + ElevenLabs implementation of PurgeDeps. Shared by voice-consent (revoke), delete-cloned-voice and the
// retention sweep, so all three delete the same way and leave the same evidence.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { deleteAndVerifyElevenLabsVoice } from "../voice/elevenLabs.ts";
import type { PurgeDeps, PurgeOutcome, PurgeTarget } from "./purge.ts";

export function makePurgeDeps(admin: SupabaseClient, elevenLabsKey: string, fetchImpl: typeof fetch = fetch): PurgeDeps {
  // Remember the last delete result so verifyGone() does not delete twice.
  const verified = new Map<string, "gone" | "still_exists" | "unknown">();
  return {
    async blockUse(t: PurgeTarget) {
      if (!t.providerVoiceId) return;
      // Only touch the profile if it still points at THIS voice (a newer clone must never be switched off by an old purge).
      const { error } = await admin.from("business_profile").update({
        use_custom_voice: false, custom_voice_id: null, custom_voice_status: "none", custom_voice_error: null,
        custom_voice_consent_at: null, custom_voice_consent_by: null,
      }).eq("user_id", t.userId).eq("custom_voice_id", t.providerVoiceId);
      if (error) throw new Error(error.message);
    },

    async deleteVoice(voiceId: string) {
      const r = await deleteAndVerifyElevenLabsVoice(elevenLabsKey, voiceId, fetchImpl);
      verified.set(voiceId, r.verified);
      return r.delete;
    },

    async verifyGone(voiceId: string) {
      return verified.get(voiceId) ?? "unknown";
    },

    async removeSamples(_userId: string, paths: string[]) {
      if (paths.length === 0) return { removed: 0, failed: false };
      const { data, error } = await admin.storage.from("voice-samples").remove(paths);
      if (error) return { removed: 0, failed: true };
      return { removed: Array.isArray(data) ? data.length : paths.length, failed: false };
    },

    async record(t: PurgeTarget, o: PurgeOutcome) {
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { purge_claimed_at: null, purge_last_error: o.error };
      if (o.providerVerified) {
        patch.provider_voice_id = null;
        patch.provider_deleted_at = now;
        patch.provider_delete_verified_at = t.providerVoiceId ? now : null;
        patch.failure_reason = null;
      } else {
        patch.failure_reason = "provider_delete_failed";
      }
      if (!o.samplesFailed) patch.sample_path = null;
      const upd = await admin.from("voice_clone_consents").update(patch).eq("id", t.consentId);
      if (upd.error) throw new Error(upd.error.message);

      const log = await admin.from("voice_clone_purge_log").insert({
        consent_id: t.consentId, user_id: t.userId, reason: t.reason,
        outcome: o.status === "purged" ? "purged" : "incomplete",
        provider_delete: o.providerDelete, provider_verified: o.providerVerified,
        samples_removed: o.samplesRemoved, assistant_restore: t.assistantRestore ?? null, error: o.error,
      });
      if (log.error) throw new Error(log.error.message);
    },
  };
}
