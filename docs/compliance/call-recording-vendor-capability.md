# Call-recording vendor-capability review (wiretap risk)

> **DRAFT for the founder and counsel. Not legal advice. No vendor term, certification or compliance status is asserted here.** Everything about vendor behaviour that was not read from this repository is marked **[VERIFY]**; every legal judgement is marked **[COUNSEL]**. "No assumptions about vendor terms" is a rule of this document: where a vendor term matters, it appears only as a question in section 4.
>
> Basis: static read of the `vireek-main` snapshot (files dated up to 2026-11-16). Nothing was run against a live Vapi, Twilio or database. Related: `docs/compliance/dpia-voice-ai.md`, `docs/compliance/voice-consent-and-ai-disclosure.md`, `docs/compliance/data-map.md`, `docs/compliance/transfers-and-contracts.md`, `docs/vendor-exit/`.

## 1. The risk in one paragraph

Some laws treat a call as unlawfully intercepted or recorded when a party records without the other party's consent, and some privacy claims argue that a **third-party service that can listen to or use call audio for its own purposes** is itself an unauthorised listener **[COUNSEL]**. For Vireek the exposure has two parts: (a) **what we do** - the assistant speaks, then audio is recorded and transcribed; (b) **what each vendor in the path can do** with the audio and transcript beyond serving us. Part (b) cannot be settled from code: it depends on contract and data-use terms, which are **not in the repository**. This document lists every vendor in the call path, what each receives, and the questions to close before anyone claims the call path is safe.

## 2. What the code did before this change (verified by reading)

| Finding | Evidence |
| --- | --- |
| The recording-consent question was **only a prompt instruction** to the LLM, built from the caller's US area code, with a second prompt for non-US business countries. It was not spoken deterministically. | `supabase/functions/_shared/compliance/recordingConsent.ts`, old block in `supabase/functions/vapi-webhook/index.ts` (assistant-request) |
| The spoken `firstMessage` override existed **only when a non-English language was known**. For English callers the greeting configured in the Vapi dashboard played; the AI disclosure reached the call only if that dashboard text contained it (the drift scan checks this). | `supabase/functions/_shared/i18n/customerLanguage.ts` (`buildVoiceFirstMessage` returns null for English), `supabase/functions/ai-disclosure-drift-scan/index.ts` |
| The recording notice was **never in the first message**, in any language. | same |
| Nothing in the inbound path told the provider whether to record: no `artifactPlan` override was sent. Recording followed the Vapi assistant's dashboard setting. | `rg artifactPlan supabase/functions` finds it only in `_shared/audit/script.ts` (test calls) |
| A caller who declined could not stop provider recording; the code stored the recording URL and transcript regardless. | old `Object.assign(patch, ...)` in the end-of-call handler |
| The Twilio voicemail fallback played "after the tone, say ..." and started `<Record transcribe="true">` with **no recording statement**; "Your message has been recorded" came afterwards. | `supabase/functions/_shared/voice-resilience/twimlFallback.ts` |
| Outbound paths use the legacy prompt-only notice (`speed-to-lead`) or a prompt rule "say calls are recorded" (`ovb`). | `supabase/functions/_shared/speed-to-lead/runtime.ts`, `supabase/functions/_shared/ovb/runtime.ts` |
| The DPIA's own open question - "verify the provider actually stops recording/transcription" - was open. | `docs/compliance/dpia-voice-ai.md` section 3 |

## 3. Vendors in the call path

"Receives" is what the code or docs show it handling. "Can record / keep" is **not known** unless a repo file says so.

| # | Role | Vendor | In the path because | Receives (from repo) | Recording / retention capability | Contract / data-use status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Telephony carrier, numbers | **Twilio** | Numbers point at Vapi via SIP/number import; degraded-mode front door; PBX; pay-by-phone | Live call media (carrier leg), caller ID, voicemail audio + Twilio transcription in fallback; PBX conference recording when enabled | Twilio call recording is used by `_shared/pci/twilio.ts` (pause/resume) and `<Record>` in fallback. Whether Twilio records the Vapi-bound leg: **[VERIFY]** | `docs/vendor-exit/twilio.md`: "not reviewed [COUNSEL]". Not on the public sub-processor list (`docs/compliance/data-map.md`) |
| 2 | Voice orchestration (hosts the call) | **Vapi** | Runs the AI phone agent for every call | Full live audio both directions, speech-to-text, LLM turns, caller number, tool-call arguments; hosts recordings and transcripts | Provider-hosted recording URL (`recordingUrl`, `artifact.recording`); recording default and start/stop control: **[VERIFY]** | `docs/vendor-exit/vapi.md`: contract/DPA "not reviewed [COUNSEL]". Listed on the public sub-processor list |
| 3 | Speech-to-text inside Vapi | **Not named in the repo** (configured on the assistant in the Vapi dashboard) | Transcribes the caller in real time | Caller audio | Unknown: **[VERIFY]** which vendor, and whether it is a Vapi sub-processor | Unknown **[VERIFY]** |
| 4 | Live conversation LLM inside Vapi | **Not named in the repo** (assistant model is dashboard config) | Generates replies during the call | Transcribed speech, injected context (name, address, history) | Unknown **[VERIFY]** | Unknown **[VERIFY]** |
| 5 | Text-to-speech | **Vapi-native voices** (`_shared/voice/voiceMap.ts`); **ElevenLabs** for cloned voices (`_shared/voice-studio/vapi.ts`, `clone-voice`) | Speaks to the caller | Assistant text (and, for cloning, owner voice samples) - not caller audio | Not caller audio, but ElevenLabs holds voice-clone samples (biometric-adjacent) | ElevenLabs "not reviewed"; absent from public sub-processor list |
| 6 | Optional alternative engine | OpenAI Realtime (stub) | `isReady() === false`; selected only with env flag + DB flag | Would receive full call audio | Parity gaps listed in `docs/voice-engines.md` section 6 (no recording/disclosure proof) | Not in the path today; **must not be enabled** before this review is repeated for it |
| 7 | Post-call analysis LLMs (transcript only) | Gemini, Groq, Cerebras, Cloudflare Workers AI, OpenRouter, Anthropic, Cohere via `ai-core` routing | Summaries, scoring, extraction after the call | Call **transcript** (plain text unless sealed) | Vendor retention / training use: **[VERIFY]** each (`docs/ai-governance/ai-policy.md` section 3 forbids training use unless contractually confirmed) | Anthropic, Cohere, ElevenLabs, Twilio called from code but missing from the public list (`docs/compliance/data-map.md` section 3) |
| 8 | Conversation Intelligence (in-person recordings) | Gemini | Separate feature with its own consent guard | Uploaded audio | Own consent trigger in `20271102000000_conversation_intelligence.sql` | Out of scope for the phone path |
| 9 | Storage | **Supabase** (US control plane; optional regional encrypted bucket) | Stores `calls.transcript`, `calls.recording_url`, ledgers | Transcript, recording URL | Region pinning not enforced (`docs/compliance/data-map.md` section 2) | Listed |
| 10 | Notification delivery | Resend (email), Twilio (SMS) | Low-score alert includes the **recording link** in email/SMS | Recording URL (link, not audio) | Link visibility/expiry: **[VERIFY]** | Resend listed; Twilio not |

Telnyx appears only as a secondary SMS adapter (`docs/vendor-exit/telnyx.md`); it is not in the voice path.

## 4. Contract and data-use checklist (all items **[VERIFY]**; nothing is assumed)

Ask each vendor in rows 1-5 and 7 (and re-ask for any new engine). Record the answer, the document and clause, the date and the person. Items that are legal readings are also **[COUNSEL]**.

**A. Use of data**
- [ ] [VERIFY] May the vendor use call audio, transcripts or metadata to train, evaluate or improve its own or third-party models? Default on or off? Is the opt-out contractual or only a dashboard toggle?
- [ ] [VERIFY] May the vendor use the data for any purpose other than providing the service to Vireek (analytics, product improvement, advertising, benchmarking)? **[COUNSEL]** whether "capability to use" without actual use matters for wiretap exposure.
- [ ] [VERIFY] Is the vendor acting only on documented instructions (processor terms) in the signed agreement, not only in marketing pages?
- [ ] [VERIFY] Which sub-processors sit behind the vendor (for Vapi: the STT, LLM and TTS vendors actually configured on our assistants)? Is there a change-notice process?

**B. Recording and retention**
- [ ] [VERIFY] Is audio recorded by default? Can it be turned off per call through the API, and does the vendor still produce a transcript or logs when recording is off?
- [ ] [VERIFY] Can recording start **after** a spoken consent (mid-call), or only be on/off for the whole call? (Decides whether `opt_in` profiles can ever record.)
- [ ] [VERIFY] Retention period for audio, transcripts, logs, call metadata; zero-retention or "no-log" options and what they cost/disable.
- [ ] [VERIFY] Deletion: is there an API to delete a call's recording and transcript, is deletion complete across backups, what is the SLA? (`_shared/compliance/providerErasure.ts` already calls Vapi's call-delete endpoint; confirm it covers audio, transcript and logs.)
- [ ] [VERIFY] Where is data stored and processed (region); can EU/UK/CA/AU tenants be pinned?
- [ ] [VERIFY] Who at the vendor can access recordings (support, engineers), and is access logged?

**C. Terms for the transfer and the law**
- [ ] [COUNSEL][VERIFY] DPA signed? SCC module / UK Addendum / DPF status per vendor; breach-notice time; audit rights; government-request policy.
- [ ] [COUNSEL][VERIFY] Does the vendor allocate to Vireek the duty to obtain recording consent? Any clause that conflicts with disclosing "AI + recorded" to callers?
- [ ] [COUNSEL][VERIFY] Biometric statements: does the vendor create voiceprints or speaker embeddings from caller audio? (Illinois-style biometric statutes.)

**D. Operational proof**
- [ ] [VERIFY] Test call per section 5 for each assumption the code makes.
- [ ] [VERIFY] Twilio: is the Vapi-bound leg recorded by Twilio or any Twilio add-on (voice insights, intelligence, transcription)?
- [ ] [VERIFY] Recording links in alerts (row 10): expiry and access control.

## 5. Provider behaviour the code now assumes (and how to prove each)

These are **NOT LIVE-VERIFIED**. Until each is proven on a real test call, keep `CALL_RECORDING_GATE_MODE` unset (= `shadow`).

| # | Assumption | Where used | Proof (test call; record result and date here) |
| --- | --- | --- | --- |
| 1 | `assistantOverrides.artifactPlan.recordingEnabled=false` in the `assistant-request` response disables audio recording for that call, and does not make the call fail | `planOverrides` in `callStartPlan.ts` | Place a call from a DE-configured test tenant with `enforce`; confirm the call connects and the end-of-call report has no recording URL / recording is not retrievable from Vapi |
| 2 | `assistantOverrides.firstMessage` replaces the assistant's configured first message and is spoken before the caller is asked anything | `planOverrides` | Listen to the call; compare the first assistant turn in the end-of-call messages with `call_recording_consents.notice_text` (`notice_in_first_turn` must be `true`) |
| 3 | Squad mode: `firstMessage` on the first member and `artifactPlan` on every member are honoured | `applyPlanToSquad` | Same test with `agentOrchestrationEnabled` on |
| 4 | In `shadow`/notice mode, recording **starts only after** the first message (or: the first message is covered by the recording and that is acceptable) | n/a - provider behaviour | Compare recording start offset with the first-message timestamp; **[COUNSEL]** whether recording the notice itself matters |
| 5 | When recording is disabled, the provider still returns `artifact.messages`/transcript (needed for the consent answer) | `finalizeCallRecording` | If messages are absent, outcome is `unclear` and enforce keeps nothing - safe but useless; then a tool-call based consent capture is needed |
| 6 | Provider-side copies for a refused call can be deleted | `provider_deletion_required` rows | Run the deletion path in `providerErasure.ts` on a test call |

## 6. What changed in the repository (this task)

| Piece | File |
| --- | --- |
| Pure call-start plan: AI disclosure -> recording notice or transcript-consent question -> greeting; fail-closed recording decision; consent-answer inference; storage decision | `supabase/functions/_shared/compliance/callStartPlan.ts` |
| DB glue (best-effort, never throws) | `supabase/functions/_shared/compliance/callRecordingLedger.ts` |
| Consent ledger per call with caller state, immutable once final, by-state view | `supabase/migrations/20290306000000_call_recording_consents.sql` |
| Webhook wiring (assistant-request single + squad, end-of-call storage) | `supabase/functions/vapi-webhook/index.ts` |
| Voicemail fallback states "recorded and transcribed" before `<Record>` | `supabase/functions/_shared/voice-resilience/twimlFallback.ts` |
| Tests | see section 8 |

**Modes.** `CALL_RECORDING_GATE_MODE`:
- unset or `shadow` (default): the first message now carries AI disclosure + a truthful recording notice; the ledger records what `enforce` *would* do (`would_block`); **nothing is changed at the provider** and nothing is suppressed, except that an explicit "no recording" from the caller is honoured (recording URL and transcript not stored; `provider_deletion_required = true` because the provider copy may still exist).
- `enforce`: where consent is required (business profile `opt_in`/`opt_in_strict`, or caller area code in a US all-party state - the stricter wins, unknown country fails closed), the provider is told not to record audio; the caller is asked only about keeping a **written transcript**; nothing is stored unless the caller says an explicit yes; audio is never stored for those calls. A language without a reviewed notice (not en/de/fr/es) cannot be recorded.

**Known limits.**
- The caller's answer is **inferred from the transcript** with a conservative yes/no matcher; anything not clearly "yes" is `unclear` (= not granted in enforce). A tool-call based capture would be firmer but needs a Vapi assistant change **[VERIFY]**.
- A phone number is not a location: area-code state is a heuristic and is stored as `caller_state_source = 'area_code_heuristic'`.
- The business's own state is not available (`profiles.business_country` only), so a US business in an all-party state is not detected from the business side.
- `summary` and structured booking data are still stored after a refusal (needed to serve the request). Whether that is acceptable is **[COUNSEL]**.
- **Outbound calls are not covered**: `speed-to-lead` and `ovb` still use the legacy prompt-only notice; `first-call-start`, `followup-agent-dispatcher`, `workflow-engine-executor` and `_shared/voice-engine/vapiEngine.ts` were not changed. Open item.
- The consent ledger table is not registered in the DSAR/erasure coverage files (the disclosure ledger tables are not either) **[VERIFY]**.
- The English persona greeting configured in Vapi is replaced, for English callers, by `Thanks for calling <company>, this is <assistant>.` when a notice must be spoken. If the owner wants the old greeting, it must be copied into the profile.

## 7. Proposed wording **[COUNSEL]** (draft, native-speaker review needed)

Spoken order is fixed: AI disclosure (account script, e.g. "This call is answered by an AI voice assistant, not a live person.") -> one of the two sentences below -> greeting.

| Language | Notice (recording happens; shadow mode and notice jurisdictions) | Transcript-consent question (enforce, consent required; audio not recorded) |
| --- | --- | --- |
| en | "This call is recorded and transcribed for [Purpose]. Say "no recording" if you'd rather we didn't, or ask for a person at any time." | "We do not keep an audio recording of this call. May we keep a written transcript of it for [Purpose]? Please say yes or no. You can ask for a person at any time." |
| de | "Dieses Gespräch wird zu [Purpose] aufgezeichnet und transkribiert. Sagen Sie "keine Aufzeichnung", wenn Sie das nicht möchten, oder bitten Sie jederzeit um eine Person." | "Wir speichern keine Tonaufnahme dieses Gesprächs. Dürfen wir ein schriftliches Protokoll zu [Purpose] aufbewahren? Bitte antworten Sie mit Ja oder Nein. Sie können jederzeit darum bitten, mit einer Person zu sprechen." |
| fr | "Cet appel est enregistré et transcrit pour [Purpose]. Dites "pas d'enregistrement" si vous préférez, ou demandez une personne à tout moment." | "Nous ne conservons pas d'enregistrement audio de cet appel. Pouvons-nous conserver une transcription écrite pour [Purpose] ? Répondez par oui ou par non. Vous pouvez demander à parler à une personne à tout moment." |
| es | "Esta llamada se graba y se transcribe para [Purpose]. Diga "no grabar" si prefiere que no, o pida hablar con una persona en cualquier momento." | "No conservamos una grabación de audio de esta llamada. ¿Nos permite conservar una transcripción escrita para [Purpose]? Responda sí o no. Puede pedir hablar con una persona en cualquier momento." |
| Voicemail fallback (en) | "This message will be recorded and transcribed." (spoken before the tone) | n/a |

Counsel questions: is a notice plus continued participation enough in each target jurisdiction, or is an explicit yes required (the draft `voice-consent-and-ai-disclosure.md` assumes explicit opt-in for DE and most of the EU); is the AI disclosure and notice in one breath acceptable; is "transcribe" the right word for speech-to-text that happens live in every case; wording for languages beyond en/de/fr/es.

## 8. Consent ledger by caller state

`public.call_recording_consents` (one row per call; no phone number, 120-character answer excerpt) and view `public.call_recording_consents_by_state` (`security_invoker`, so RLS applies). Owner-level read uses the same permission as the AI Disclosure Ledger.

```sql
-- Which caller states are producing refusals or unclear answers, and where would enforce have blocked?
select caller_state, effective_mode, gate_mode, calls, granted, declined, unclear, would_block,
       recordings_stored, notice_not_in_first_turn, provider_deletions_open
from public.call_recording_consents_by_state
order by calls desc;
```

`notice_not_in_first_turn > 0` means the provider did not speak our first message: treat as an incident-class finding (`docs/compliance/policies/ai-incident-response.md`). `provider_deletions_open > 0` is a work queue of provider copies a caller refused.

## 9. Acceptance criteria and verification

| Criterion | Test / method | Result (sandbox, 2026-11-18) |
| --- | --- | --- |
| Call-start text states AI first, then recording notice or consent question, then greeting, in every profile | `callStartPlan.test.ts` ("first message order") | 8 profile cases PASSED (local shim) |
| AI disclosure can never be missing | same ("can never be missing") | PASSED (local shim) |
| Consent required -> provider told not to record (enforce); shadow changes nothing at provider | `callStartPlan.test.ts` (recording decision, provider payload) | PASSED (local shim) |
| Assistant-request builds the plan before responding, uses it for single and squad responses; end-of-call stores nothing refused | `vapi-webhook/callStartWiring.test.ts` | 8 PASSED on the edited file; **8 FAILED on the original file** (proves the guard is not vacuous) |
| Voicemail notice precedes `<Record>` | `_shared/voice-resilience/voicemailNotice.test.ts` | 6 PASSED (local shim); existing `ladder.test.ts` 37 PASSED |
| Ledger rows: idempotent, no phone number, finalize once, refusal suppresses storage | `callRecordingLedger.test.ts` | 7 PASSED (local shim) |
| RLS, grants, immutability, constraints, by-state view | `supabase/tests/database/call_recording_consents.test.sql` (17 assertions) | **NOT RUN** (no Postgres in the sandbox) |
| Real provider honours the overrides; disclosure audibly precedes recording | section 5 test calls | **NOT RUN** (needs a live Vapi/Twilio test number) |
| `npm run typecheck`, real `vitest`, `supabase test db` | - | **NOT RUN / BLOCKED** (no `node_modules`, no network); the new pure modules passed a strict `tsc` check on their own; `vapi-webhook/index.ts` now parses without syntax errors but was not type-checked |

"Local shim" = the test files were executed by a minimal stand-in for vitest's `describe/it/expect` after bundling with esbuild, because the real vitest is not installed here. Re-run with `npx vitest run` before merging.

## 10. Open items (owner / counsel)

1. Close section 4 for Vapi, Twilio and the STT/LLM vendors behind Vapi **[VERIFY]**; name them in the sub-processor list.
2. Run section 5 test calls; only then set `CALL_RECORDING_GATE_MODE=enforce` **[VERIFY]**.
3. Counsel review of section 7 wording and of the jurisdiction map in `recordingProfiles.ts` **[COUNSEL]**; set `legal_review` to `approved` per profile only after that.
4. Extend the plan to outbound paths and to the Vapi `first-call-start` / follow-up / workflow dialers.
5. Decide whether transcripts/summaries should also be suppressed after a refusal **[COUNSEL]**; add a business-state field so business-side all-party states are detected.
6. Register `call_recording_consents` in DSAR/erasure coverage; define its retention (`docs/compliance/transfers-and-contracts.md` D11 proposes 3-6 years for consent proof **[COUNSEL]**).
7. Run `providerErasure.ts` for rows with `provider_deletion_required`.
