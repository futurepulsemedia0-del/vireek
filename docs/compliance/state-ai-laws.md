# State AI / bot-disclosure laws and the voice flows

Status: **DRAFT fill-in template. Not legal advice.** Every row is a starting reference for counsel. Researched 2026-11-25
from secondary sources; read the statutes before relying on anything here. `TODO(counsel)` = a legal conclusion we have not made.

## 1. References (verify each; applicability to PHONE calls is the open question)

| Ref | What it says (summary, verify) | Applies to Vireek voice? | Status |
| --- | --- | --- | --- |
| California SB 1001, Bus. & Prof. Code 17940 et seq. (operative 2019-07-01) | Unlawful to use a bot to communicate or interact with a person **in California online** with intent to mislead about its artificial identity to incentivise a sale/purchase or influence a vote. No liability if the bot is disclosed; the disclosure must be clear, conspicuous and reasonably designed to inform. | The statute says "online". TODO(counsel): do phone calls placed or answered by an AI voice agent fall inside it? Until answered we disclose on every call anyway. | VERIFY |
| California AB 410 (2025-26 session), proposed amendments to 17940-17943 | Bill to amend the bot chapter. Not confirmed enacted. | TODO(counsel): check current status. | VERIFY |
| California SB 243 (companion chatbots) | Disclosure of non-human status for companion chatbots. | Probably not (receptionist, not companion). TODO(counsel). | VERIFY |
| Utah AI Policy Act (2024) and amendments | Disclosure duties when a consumer asks or in regulated occupations. | TODO(counsel) | VERIFY |
| Maine, New Jersey chatbot disclosure laws (per a Bloomberg Law tracker summary, 2026) | Operators disclose AI interaction. | TODO(counsel): scope and effective dates. | VERIFY |
| Washington, Oregon, Nebraska, Idaho 2026 chatbot acts | Mostly companion-chatbot and minor-safety focused. | Probably not. TODO(counsel). | VERIFY |
| Colorado AI Act (SB 24-205) | Consumer-facing AI interaction notice inside a high-risk-system regime. | TODO(counsel): is the receptionist a "high-risk" system? | VERIFY |
| EU AI Act Art. 50(1) | Tell people they interact with AI unless obvious. | See `voice-consent-and-ai-disclosure.md` section 4. | VERIFY |
| FCC AI-voice ruling under the TCPA (2024) | AI-generated voices treated as "artificial voice" for TCPA consent. | Consent, not disclosure; relevant to outbound AI calls. TODO(counsel). | VERIFY |

Fill in (owner/counsel): jurisdictions Vireek customers actually call into: `TODO(owner)`. Required wording per jurisdiction: `TODO(counsel)`.

## 2. What the code does today (verified by reading source on 2026-11-25)

Single product rule: **every AI-spoken call starts with a disclosure; the account may set the wording** (`business_profile.ai_disclosure_script`,
default `DEFAULT_DISCLOSURE_SCRIPT` in `_shared/ai-disclosure/select.ts`).

| Flow | Timing / wording mechanism | Proof |
| --- | --- | --- |
| Inbound AI answer (`vapi-webhook`, assistant-request) | First message = AI disclosure, then recording notice, then greeting (`callStartPlan.ts`); empty wording falls back to the default | Ledger row `planDisclosure`, outcome `recordDisclosureOutcome` at end-of-call |
| Outbound via saved assistant (`outbound-dialer`, `followup-agent-dispatcher`, `workflow-engine-executor`, `first-call-start`) | **Changed in this work:** the `ai_disclosure` variable is now sent on every outbound call (`_shared/ai-disclosure/outbound.ts`). Before, nothing filled it, so an assistant whose first message starts with `{{ai_disclosure}}` (judged "in sync" by the drift scan) had no value on outbound calls. | Ledger row created after the provider returns a call id (`registerOutboundDisclosure`) |
| Speed-to-lead | Explicit first message "this is Sarah, an AI assistant calling on behalf of ..." (`buildFirstMessage`) | Source evidence only |
| Voice Studio test call, missed-call audit | Fixed scripts that say AI | Source evidence only |

Residual limits: (a) an outbound assistant whose saved first message neither uses `{{ai_disclosure}}` nor contains the wording will still not speak it; the drift scan (`ai-disclosure-drift-scan`) is the control; (b) wording for **outbound** ("answered by" in the default sentence reads oddly when we place the call): `TODO(counsel)` + `TODO(owner)`; (c) the guard proves wiring, not what a live call said (use the ledger and a staging test call).

## 3. The test that fails when a flow lacks disclosure

`npm run test:scripts:voice-disclosure` (checker: `npm run compliance:voice-disclosure`).
Registry: `scripts/compliance/voice-disclosure-registry.json`. Baseline of legacy gaps: `scripts/compliance/voice-disclosure-baseline.json`.

* R1 a file that places/answers a call (Vapi `POST /call`, Twilio `Calls.json`, TwiML `<Say>`, `startCall(`, `handleAssistantRequest`) must be in the registry.
* R3 an AI flow must name a disclosure mechanism and its evidence patterns must be found in the source.
* R5 an AI flow without disclosure fails unless it is in the baseline; baseline entries may only be removed.
* A new flow, or deleting the evidence from an existing one, turns CI red.

To add a flow: add a registry entry (`aiSpeaksToThirdParty` true/false, with `reason` when false). Never add to the baseline without an owner decision.

## 4. Open gaps (baseline) - decisions needed

| Flow | Problem | Decision |
| --- | --- | --- |
| `_shared/ovb/runtime.ts` (benchmark caller) | AI plays a human caller and never says it is a test | TODO(owner): confirm all targets are Vireek-controlled or consenting lines; else add disclosure. TODO(counsel) |
| `interpreter-bridge-twiml` | AI interpreter speaks; `interpreter/languages.ts` has an `aiDisclosure` string per language but no code in this repo plays it | TODO(owner): confirm the bridge worker plays it first, then add evidence or wire it |
| IVR menus / voicemail prompts (`pbx-voice`, `voice-front-door`) | Treated as not AI | TODO(counsel) |
| Notification calls (`_shared/notify/deliver.ts`) | One-way TTS to owner/staff | TODO(counsel) |

## 5. Manual verification (before calling this done)

1. Staging: place one outbound AI call per flow in section 2 and read the transcript's first sentence.
2. `/dashboard/ai-disclosure-ledger`: outbound calls now appear with a proof status.
3. Run the drift scan; every assistant must be `in_sync`.
