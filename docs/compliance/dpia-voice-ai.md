# DPIA draft - AI voice assistant + call recording

> DRAFT for the controller (customer) and Vireek as processor to complete with counsel / a DPO. Not legal advice. Structure follows GDPR Art. 35(7). Inputs: `data-map.md`, `transfers-and-contracts.md`.

## 1. Why a DPIA
Systematic processing of voice (and possibly biometric-adjacent) data of members of the public, new technology (generative AI), large-scale recording, third-country transfers. Treat as **required**; confirm against the DPA's published high-risk lists (DE: DSK Muss-Liste).

## 2. Description of processing
* Nature: caller dials the business number -> telephony/voice provider -> LLM chain -> booking/dispatch actions; optional recording, transcription, sentiment/score, coaching.
* Scope: caller name, phone number, address, voice, spoken content (may include special-category data volunteered, e.g. health of an occupant), payment card digits via pay-by-phone (PCI path separate).
* Context: callers are consumers who did not choose Vireek; they must be told they are speaking to AI and whether they are recorded.
* Purposes: answering, scheduling, dispatch, QA, dispute evidence. **Not** purposes: model training on customer data by Vireek or providers (verify vendor terms), emotion profiling.
* Recipients/sub-processors and transfers: see data-map section 3 and TIA per vendor.
* Retention: see schedule.

## 3. Necessity and proportionality
| Question | Current evidence | Gap |
| --- | --- | --- |
| Is AI disclosure given before substantive processing? | `ai-disclosure` ledger + first-message injection in `vapi-webhook` | Languages: en es zh hi fr de ar fa ja exist; region defaults + legal review missing |
| Is recording consent obtained where required? | `recordingConsent.ts` - US all-party states by caller area code only | Nothing for DE/EU/UK/CA/AU; keyed to caller number not business location |
| Can the caller refuse recording and still be served? | Prompt says stop recording + human transfer | **Verify** the provider actually stops recording/transcription |
| Data minimisation | Sealing option; retention policies | Defaults per region not set |
| Data subject rights | `/data-request` (access/delete/correct), delete-account | See gap list E1-E5: erasure incomplete; export not automated |
| Processor control | DPA exists | Executed SCC annexes absent; subprocessor list incomplete |

## 4. Risks to individuals (likelihood x severity - to be scored by the assessor)
1. Callers recorded without valid consent (criminal exposure in DE, civil elsewhere).
2. Callers misled into thinking they speak to a human (AI Act Art. 50(1) since 2 Aug 2026).
3. Voice/transcript data exposed via provider breach or US authority access.
4. Over-retention of recordings; failed erasure at providers.
5. Special-category data captured incidentally and sent to multiple LLM providers.
6. Voice cloning misuse / impersonation.
7. Employee monitoring (technicians/CSRs) via coaching analytics.

## 5. Measures (existing / planned)
Existing: TLS, envelope encryption + regional ciphertext (Trust Pack), RLS tenant isolation (verify), PII stripping before Sentry, consent engine with GPC, DSAR flow with hashed codes and rate limits, legal-hold checks, retention sweep.
Planned: per-region consent/disclosure defaults, fix erasure gaps, provider-side deletion, redact-before-LLM for card digits and special-category cues, zero-retention vendor terms, EU data plane, TIAs, annual review.

## 6. Consultation / sign-off
Customer DPO view: [ ]. Data subjects' views (where appropriate): [ ]. Vireek privacy lead: [ ]. Prior consultation with authority needed if high residual risk: [ ]. Review date: [ ].
