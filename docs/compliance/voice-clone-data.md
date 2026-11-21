# Cloned-voice data: consent, retention and deletion

> **Status: engineering description, not a legal opinion.** Items marked **[COUNSEL]** need a lawyer's decision.
> Items marked **[VERIFY]** could not be confirmed from the repository (mostly provider behaviour).
> Nothing here claims that Vireek or its customers comply with any biometric, privacy, publicity or AI law.

## 1. What data exists

| Data | Where | Created by | Removed by |
|---|---|---|---|
| Raw voice sample (audio of a real person) | Storage bucket `voice-samples`, path `<owner id>/sample-….` | Upload in the consent card | Revoke, owner delete, retention sweep |
| Transcript of the sample (liveness check) | Sent to ElevenLabs speech-to-text by `clone-voice`; not stored by Vireek | `clone-voice` | **[VERIFY]** provider retention of STT inputs/outputs; **[COUNSEL]** |
| Cloned voice | ElevenLabs, id in `voice_clone_consents.provider_voice_id` and `business_profile.custom_voice_id` | `clone-voice` | Revoke, owner delete, retention sweep |
| Consent record (name of voice owner, relationship, accepted text version + hash, liveness phrase, retention choice, timestamps) | `voice_clone_consents` | `voice-consent` | Kept as evidence **[COUNSEL]** (see 6) |
| Live assistant pointing at the voice | Vapi assistant `voice.voiceId` | `voice-studio-sync` | Sweep switches it back to the preset first |
| Deletion evidence | `voice_clone_purge_log` | Every purge | Cascades with the account |

The person whose voice is cloned may not be the account owner (`relationship = employee_written_consent`). Voice can be a
biometric identifier in some jurisdictions. **[COUNSEL]**

## 2. Versioned consent text
- Texts live in `supabase/functions/_shared/voice-studio/consent.ts` (`CONSENT_TEXTS`, `CURRENT_CONSENT_VERSION`) and, immutably,
  in `public.voice_clone_consent_texts` (a trigger forbids edits and deletes; only `retired_at` can be set once).
- `v1` (legacy, never offered again) says nothing about retention. `v2` (current) states that the sample and the cloned voice
  are kept only for the period the owner chooses and then deleted automatically.
- A consent row stores the **version**, the **SHA-256 of the exact text**, and the **retention the owner chose**.
  `voice-consent` rejects a start request whose `consentVersion` is not the current one (`409 consent_version_stale`), so
  nobody can accept a text they were not shown.
- Never edit a published text. Add `v3` in code and in a new migration, make it current, keep the old ones.
- A test (`consentVersions.test.ts`) fails if the TypeScript texts and the migration seed differ.
- Wording of `v2` is a draft. **[COUNSEL]**

## 3. Retention
- The owner picks 30 / 90 / 180 / 365 / 730 days when consenting (server accepts any whole number from 7 to 730; default 365).
  These numbers are product defaults, not legal advice. **[COUNSEL]** for the right default, minimum and maximum.
- On approval a database trigger stamps `approved_at` and `expires_at = approved_at + retention_days` (exact 24-hour days).
  Doing this in the database means no edge-function bug can skip it.
- Retention can be **shortened** at any time (`voice-consent` action `set_retention`) but never lengthened; a longer period
  needs a new consent. The trigger enforces this too, and `expires_at` can never move later.
- **Legacy voices** (approved before this change, under `v1`): `expires_at = migration time + 365 days`. They are not deleted
  the moment the migration runs. Whether those owners must re-consent is **[COUNSEL]**.

## 4. Automatic deletion
`voice-clone-retention-sweep` runs daily (pg_cron job `vireek-voice-clone-retention` -> `voice_clone_retention_tick()`; if
pg_cron is absent, call that function from your external cron).

1. **Warnings:** in-app notification at 30, 7 and 1 days before expiry, once per stage.
2. **Claim:** `voice_clone_claim_due()` takes due rows with a lease and `SKIP LOCKED`, so overlapping runs never double-process.
   Due = approved and past `expires_at`, **or** revoked/expired/rejected rows that still hold a provider voice id or sample path
   (this also retries earlier failed deletions without waiting for the owner to click again).
3. **Block:** the consent becomes `expired` immediately (`voice-studio-sync` only accepts `approved`).
4. **Live assistant:** if the Vapi assistant still uses the clone it is switched back to the owner's preset voice and re-read to
   confirm. If that fails, deletion is postponed (up to 3 runs); after that it proceeds anyway because the owner's retention
   period has ended, the owner is told to pick a voice, and the result is logged. If the owner has no preset voice the clone is
   deleted anyway and the owner is told. **[COUNSEL]** whether deletion may ever be postponed.
5. **Purge:** sample audio removed; voice deleted at ElevenLabs; deletion **verified** (section 5); result written to the
   consent row and to `voice_clone_purge_log`.
6. **Retry:** anything unconfirmed stays selectable and is retried each day, up to 30 attempts. After that it is left for a person.
   Find them with: `select id, user_id, purge_last_error from voice_clone_consents where purge_attempts >= 30 and (provider_voice_id is not null or sample_path is not null);`

The sweep returns 503 and deletes nothing if `ELEVENLABS_API_KEY` is missing. **Alert on non-200 responses of this function:
a silent failure means retention is not being enforced.**

## 5. Verifying provider-side deletion
- After `DELETE /v1/voices/{id}` the sweep, revoke and owner-delete all call `GET /v1/voices/{id}` and accept **only a 404** as proof
  (re-checked up to 3 times, 600 ms apart). A 200 means "still there"; any other answer is "unknown". Neither counts as deleted:
  the provider voice id and sample path stay on the row and the action is retried.
- `provider_delete_verified_at` is set only after a confirmed 404. Owners and staff can read the evidence in `voice_clone_purge_log`.
- **[VERIFY]** with a throwaway voice that ElevenLabs answers 404 for a deleted voice, and how quickly. If it answers differently
  the code never reports a false "deleted" (it stays "unknown" and retries), but it would never finish, so check this first.
- **[VERIFY] [COUNSEL]** What ElevenLabs retains after deleting a voice (backups, logs, model training, STT inputs). This
  verification proves the voice is no longer retrievable through the API; it does **not** prove erasure of every copy at the provider.
  Confirm in the provider's data-processing terms.

## 6. What is kept after deletion (decision needed)
`voice_clone_consents` rows (name of the voice owner, accepted text version/hash, timestamps) and `voice_clone_purge_log`
rows are kept as evidence that consent was given and deletion happened. The log stores no audio and no provider voice id.
How long to keep them is **[COUNSEL]**; they are removed when the account is deleted (`voice_clone_purge_log` cascades;
`voice_clone_consents` has no account FK, which is a pre-existing gap listed in `docs/compliance/erasure-coverage-baseline.json`).

## 7. Known gaps and findings in the snapshot reviewed
1. `supabase/functions/clone-voice/index.ts` in the uploaded zip is out of order and cannot run as written: `elevenData` is used
   before it is defined, `previousVoiceId` before it is declared, `getKillSwitchGuard` is not imported, and an interface is
   duplicated. The snapshot also has 62 syntax errors elsewhere (`pre-existing-syntax-errors.txt`). Compare with the local file
   before deploying; the retention logic here does not depend on editing `clone-voice` (the trigger stamps expiry).
2. `delete-cloned-voice` used to leave the consent row `approved`, which blocked recording a new voice until the owner also
   revoked. It now closes the consent.
3. Account deletion (`providerErasure.ts`) finds the voice through `business_profile.custom_voice_id` only. A voice whose profile
   pointer was already cleared but whose provider deletion was still pending would not be erased at account deletion.
   Not changed here; recommended follow-up.
4. `VoiceCloningCard.tsx` (legacy card) passes a boolean where `triggerVoiceCloning` expects a consent id and does not use
   the consent flow. `CloneConsentCard.tsx` is the real flow.
5. Plan gating disagrees between `planLimits`, `voice-consent` and pricing (GAP-V1 in the plan-enforcement registry). Unrelated, noted only.

## 8. Operations
- Secrets: `ELEVENLABS_API_KEY` (required), `VAPI_PRIVATE_KEY` and `VOICE_STUDIO_VOICE_MAP` (needed to switch the assistant back), `PUSH_DISPATCH_SECRET` (cron auth).
- Deploy order: migration -> `voice-consent`, `delete-cloned-voice`, `voice-clone-retention-sweep` -> UI. An old UI is refused with `consent_version_stale`.
- Manual run: `curl -X POST "$BASE/voice-clone-retention-sweep" -H "x-push-dispatch-secret: $PUSH_DISPATCH_SECRET"`.

## 9. Questions for counsel
1. Is a voice clone, or the sample, biometric data where our customers operate? Is separate written consent from the speaker needed
   (not only from the account owner)? **[COUNSEL]**
2. Retention default, minimum and maximum; whether an owner-chosen period is acceptable or a fixed one is required. **[COUNSEL]**
3. Re-consent for legacy `v1` voices. **[COUNSEL]**
4. Retention of consent and purge evidence; wording of `v2`. **[COUNSEL]**
5. Provider terms: ElevenLabs (cloning, STT, backups, training) and Vapi. **[COUNSEL] [VERIFY]**
6. May deletion be postponed to protect live calls? **[COUNSEL]**
