// supabase/functions/voice-clone-retention-sweep/index.ts
//
// Cron (daily, see public.voice_clone_retention_tick). Enforces the retention period of cloned voices:
//   1. warns owners at 30 / 7 / 1 days before expiry (in-app notification, once per stage),
//   2. claims due work (approved + expired, and revoked/expired rows whose provider copy or sample is still present),
//   3. for an expired voice: marks the consent 'expired' (blocks any new use), switches the live Vapi assistant back to the
//      owner's preset voice if it still uses the clone, then deletes the voice at ElevenLabs and VERIFIES it is gone,
//      removes the sample audio, records the result in voice_clone_consents and voice_clone_purge_log.
// A row is only called purged after the provider confirms deletion. Anything unconfirmed is retried on the next run
// (up to 30 attempts, then it needs a person: see docs/compliance/voice-clone-data.md).
// Auth: x-push-dispatch-secret or service-role bearer. Deploy: --no-verify-jwt. Secret needed: ELEVENLABS_API_KEY.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { isAuthorizedCaller, json } from "../_shared/synthetic/auth.ts";
import { sanitizeTuning } from "../_shared/voice-studio/logic.ts";
import { buildVapiPatch } from "../_shared/voice-studio/vapi.ts";
import { purgeClonedVoice, shouldDeferForRestore, type PurgeReason } from "../_shared/voice-clone/purge.ts";
import { makePurgeDeps } from "../_shared/voice-clone/purgeDeps.ts";
import { restoreAssistantVoice, type RestoreResult } from "../_shared/voice-clone/assistantRestore.ts";
import { MAX_RESTORE_DEFERRALS, NOTICE_THRESHOLDS_DAYS, daysRemaining, noticeStageFor } from "../_shared/voice-clone/retention.ts";

type Admin = ReturnType<typeof createClient>;
interface Claimed {
  consent_id: string; owner_id: string; consent_status: string; voice_id: string | null;
  sample: string | null; reason: string; attempts: number;
}

async function notify(admin: Admin, userId: string, title: string, message: string): Promise<void> {
  try {
    await admin.from("notifications").insert({ user_id: userId, type: "voice_clone_retention", title, message, action_url: "/dashboard/settings/voice-studio" });
  } catch { /* best effort */ }
}

async function sendExpiryWarnings(admin: Admin, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + NOTICE_THRESHOLDS_DAYS[0] * 86_400_000).toISOString();
  const { data } = await admin.from("voice_clone_consents")
    .select("id,user_id,expires_at,expiry_notice_stage")
    .eq("status", "approved").not("expires_at", "is", null).gt("expires_at", now.toISOString()).lte("expires_at", horizon).limit(500);
  let sent = 0;
  for (const r of (data ?? []) as Array<{ id: string; user_id: string; expires_at: string; expiry_notice_stage: number }>) {
    const left = daysRemaining(r.expires_at, now);
    const stage = noticeStageFor(left);
    if (stage <= r.expiry_notice_stage) continue;
    // Claim the stage first (only if nobody else did), then notify: at most one warning per stage.
    const { data: upd } = await admin.from("voice_clone_consents").update({ expiry_notice_stage: stage })
      .eq("id", r.id).eq("expiry_notice_stage", r.expiry_notice_stage).select("id");
    if (!upd || upd.length === 0) continue;
    await notify(admin, r.user_id, "Your cloned voice will be deleted soon",
      `Your cloned voice and its sample are deleted automatically in ${left} day${left === 1 ? "" : "s"}. To keep using a cloned voice, record a new one with fresh consent after it is deleted, or switch to a preset voice in Voice Studio.`);
    sent++;
  }
  return sent;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!isAuthorizedCaller(req)) return json({ error: "Unauthorized." }, 401);

  const elevenKey = Deno.env.get("ELEVENLABS_API_KEY") ?? "";
  if (!elevenKey) {
    console.error("voice-clone-retention-sweep: ELEVENLABS_API_KEY is not set; retention cannot be enforced");
    return json({ error: "elevenlabs_unconfigured" }, 503);
  }
  const vapiKey = Deno.env.get("VAPI_PRIVATE_KEY") ?? "";
  let voiceMap: Record<string, string> = {};
  try { voiceMap = JSON.parse(Deno.env.get("VOICE_STUDIO_VOICE_MAP") ?? "{}"); } catch { /* unconfigured */ }

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const now = new Date();
    const warned = await sendExpiryWarnings(admin, now);

    const { data: claimed, error: claimErr } = await admin.rpc("voice_clone_claim_due", { p_limit: 25, p_lease_seconds: 600 });
    if (claimErr) throw claimErr;

    const summary = { warned, claimed: 0, purged: 0, incomplete: 0, deferred: 0 };
    for (const row of (claimed ?? []) as Claimed[]) {
      summary.claimed++;
      const reason = (row.reason === "retention_expired" ? "retention_expired" : "provider_cleanup") as PurgeReason;

      // Block any new use immediately (voice-studio-sync only accepts 'approved'). Conditional: never overrides a concurrent revoke.
      if (row.consent_status === "approved") {
        await admin.from("voice_clone_consents").update({ status: "expired" }).eq("id", row.consent_id).eq("status", "approved");
      }

      // Never delete a voice the live assistant still points at: switch it back to the preset first.
      let restore: RestoreResult = "not_needed";
      if (row.voice_id) {
        const { data: bp } = await admin.from("business_profile").select("vapi_assistant_id").eq("user_id", row.owner_id).maybeSingle();
        restore = await restoreAssistantVoice({
          vapiKey, assistantId: (bp?.vapi_assistant_id as string | null) ?? null, cloneVoiceId: row.voice_id,
          buildPatch: async () => {
            const { data: prof } = await admin.from("voice_studio_profiles").select("voice_key,tuning")
              .eq("user_id", row.owner_id).is("location_id", null).eq("scenario", "default").maybeSingle();
            const providerVoice = prof ? voiceMap[prof.voice_key as string] : undefined;
            return providerVoice ? buildVapiPatch(providerVoice, sanitizeTuning(prof?.tuning)) : null;
          },
        });
        if (shouldDeferForRestore(restore, row.attempts, MAX_RESTORE_DEFERRALS)) {
          await admin.from("voice_clone_consents").update({ purge_claimed_at: null, purge_last_error: "assistant_restore_failed" }).eq("id", row.consent_id);
          summary.deferred++;
          continue;
        }
      }

      const outcome = await purgeClonedVoice(
        { consentId: row.consent_id, userId: row.owner_id, providerVoiceId: row.voice_id, samplePaths: row.sample ? [row.sample] : [], reason, assistantRestore: restore },
        makePurgeDeps(admin, elevenKey),
      );
      if (outcome.status === "purged") {
        summary.purged++;
        if (reason === "retention_expired") {
          await notify(admin, row.owner_id, "Your cloned voice was deleted",
            restore === "restored" ? "The retention period ended, so your cloned voice and its sample were deleted. Calls now use your preset voice."
              : restore === "failed" || restore === "no_preset"
                ? "The retention period ended, so your cloned voice and its sample were deleted. Open Voice Studio and choose a voice for live calls."
                : "The retention period ended, so your cloned voice and its sample were deleted.");
        }
      } else summary.incomplete++;
    }
    return json({ ok: true, ...summary });
  } catch (e) {
    console.error("voice-clone-retention-sweep error", e);
    return json({ error: "Unexpected error." }, 500);
  }
});
