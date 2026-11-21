# Telecom status and emergency-call guardrail

Owner: designated legal contact and head of telephony (to be named) **[COUNSEL]**.
Status: **DRAFT engineering audit. This is not legal advice and makes no statement about what any telecom law requires.**
Snapshot: repository ZIP of 2026-11-17. Code was read and unit-tested with a local test shim; nothing was run against Twilio, Vapi or a database.

Markers: **[COUNSEL]** = a legal conclusion that counsel must make. **[VERIFY]** = a fact not confirmed against a primary source.

## 1. What the platform does today

| Capability | Where | What it does |
|---|---|---|
| Business phone numbers | `phone_numbers`, `pbx_lines` | Numbers bought through Twilio are attached to a customer account and routed (open/closed destinations, IVR, queues, voicemail). |
| Inbound call routing | `pbx-voice` (`inbound`) | Rings extensions, ring groups, queues, external numbers, AI. |
| Softphone placing calls to the public phone network | `pbx-voice` (`app`), `pbx_extensions` | A browser or mobile client dials a number. A Twilio conference leg is created to that number with a business caller ID. |
| Warm transfer / 3-way to an external number | `pbx-actions` (`add_participant`) | Adds a leg to a validated E.164 number. |
| Click-to-call callback bridge | `browser-extension`, `call-bridge-voice`, `proxy-call-bridge` | Rings the agent, then the customer, showing the business number. |
| Automated outbound calls | `outbound-dialer`, `dialer-call`, `first-call-start`, `voice-studio-test-call` | An AI voice agent calls customers from the account's number. |
| Caller ID assignment | `pbx_lines`, `phone_numbers` | The account chooses which owned number is shown. |

## 2. Features that could make Vireek a voice or VoIP provider **[COUNSEL]**

Engineering lists the features that look like a communications service. Counsel decides whether any of them makes Vireek a
provider of a regulated service in any country, and which one.

| Feature | Why it may matter | Question for counsel |
|---|---|---|
| Softphone that dials the public phone network and receives calls on assigned numbers | Resembles a service that lets users place and receive calls to and from the public network. | In each market, is this an interconnected or number-based voice service provided by Vireek, or software used on top of a carrier's service (Twilio)? |
| Assigning numbers to customers and presenting them as caller ID | Number holding, number portability and caller-ID rules may attach. | Who is the number holder of record, and what do Twilio's terms say about resale? **[VERIFY contract]** |
| Hosting voicemail, recording, transcription | Recording-consent and retention rules. Already covered by `docs/compliance/voice-consent-and-ai-disclosure.md` and `dpia-voice-ai.md`. | Out of scope here except where it overlaps with provider status. |
| Bridges that connect two third parties (agent and customer) | Call-completion service. | Same question as the softphone. |
| Customers in several countries (`pbx_settings.outbound_country_codes`) | Each country may have its own rules. | Which countries are actually served today? **[VERIFY from billing data]** |
| Emergency calling | A service that lets users place calls to the public network may be expected to support emergency calls, or to tell users clearly that it does not. | See section 4. |

## 3. Audit of the three named functions

| Function | How the destination is decided | Emergency handling before | Emergency handling now |
|---|---|---|---|
| `pbx-voice` (`app` softphone path) | Typed by the user on the client. `parseDialString` returned an internal extension for any 2 to 6 digit string, otherwise PSTN. This path did not call the fraud guard directly. | "911" was treated as an extension (no PSTN call, but the user was told only that the extension did not exist). Other forms: "not valid". | `parseDialString` returns `emergency` for 911/112/999 in common forms. The function answers with a spoken notice and hangs up. No call row, no leg, no provider request. |
| `pbx-voice` (legs via `createLeg`) | `_shared/pbx/runtime.ts` sends every external leg through `gateCustomerOutbound` or `gateDestinationOnly`. | Policy allowed 911/112/999 as "always allowed". | Refused by the guard (see below). |
| `pbx-voice` (`directTwiml`, forwarding to an external number) | Stored configuration, validated as E.164 (at least 8 digits). Not routed through the fraud guard. | Not reachable with a short code because of the E.164 check. | Unchanged. Recommended follow-up: route through the guard too. |
| `pbx-actions` (`add_participant`, external target) | Client sends a number. Must be valid E.164 and match the account's country prefixes. | "911" returned `Invalid target`. | Returns HTTP 403 with `error: "emergency_number_blocked"` and the notice. |
| `outbound-dialer` | `outbound_calls.customer_phone`, which comes from customer records and CSV-like imports. | The central policy treated the exact string "911" as allowed, so a queue row with "911" could have been dialled by the AI agent. | Early refusal: the row is set to `failed` with the notice in `outcome_notes`. The central guard would refuse it as well. |

Central change: `evaluateDestination` (`_shared/fraud/destinationPolicy.ts`) no longer allows emergency numbers and returns the new
reason `EMERGENCY_NUMBER_BLOCKED`. `guardOutbound` and `guardDestination` (`_shared/fraud/guard.ts`) refuse emergency numbers **before**
any other logic. This refusal ignores shadow or rollout mode (a "shadow" would place the call), does not depend on the fraud store
being reachable, touches no usage ledger, and never writes the dialled number to `fraud_events`. Every caller of
`gateCustomerOutbound` and `gateDestinationOnly` inherits it.

The meaning of `purpose: "emergency"` is unchanged: it is a hand-off to the business owner's own number, not a call to an emergency
service, and it keeps its own lane.

### Other dial-capable functions (surveyed, not modified)

| Function | Central guard | Short code reachable? |
|---|---|---|
| `dialer-call`, `first-call-start`, `voice-studio-test-call`, `call-bridge-voice`, `browser-extension` | Yes (or equivalent) | No (guard refuses it) |
| `csr-call-transfer`, `live-call-control`, `proxy-call-bridge`, `vapi-webhook` (transfer destination), `interpreter-bridge-twiml` | No | No: each requires E.164 of at least 8 digits, so "911", "112" and "999" cannot pass. Verified by reading the validators, not by test. |
| `voice-call` | No dial signal found | Not applicable **[VERIFY]** |

Recommended follow-up: route those five through `gateDestinationOnly` as well, so the rule does not depend on each validator staying strict.

## 4. Emergency-call position

- **Vireek does not provide emergency calling.** The switch is `EMERGENCY_CALLING_SUPPORTED` in
  `supabase/functions/_shared/telecom/emergencyNumbers.ts` and is `false`. A test asserts that it is `false`; whoever flips it must replace that test (section 4, condition 7) and record the evidence here.
- Recognised: 911, 112 and 999, with `+`, `1`, `00`, and (for 911 only) `9` prefixes; spaces, dots, dashes, slashes, parentheses; `tel:` and
  `sip:` URIs; full-width, Arabic-Indic and Persian digits; a leading `*` or `#`; trailing pause or DTMF characters. Four-digit internal extensions
  such as 9112 and 1112 are deliberately **not** treated as emergency numbers.
- Not recognised as emergency (they are refused anyway as `INVALID_NUMBER` by the destination policy, with a generic message): other
  countries' codes (for example 000, 110, 119, 15, 17, 18), the 933 test number, 988, and values with other vertical-service-code prefixes.
- User notice: "Vireek cannot place emergency calls. If this is an emergency, hang up and dial your local emergency number (for example 911,
  112 or 999) directly from a phone." Spoken version in the same file.
- **Users must be told in product and terms**, not only at the moment of a blocked dial: that the service cannot place emergency calls, and what to do
  instead. Text for the terms and the sign-up flow is a **[COUNSEL]** item. No public claim about emergency capability should be made.

### Conditions before `EMERGENCY_CALLING_SUPPORTED` may become `true` **[COUNSEL] [VERIFY]**

All of these must be true and documented, in each country where calls can be placed:

1. The carrier (Twilio or another) confirms in writing which emergency calling features are available for the number types in use, and the account is enabled for them.
2. Every outbound-capable number or extension has a registered, validated location, with a process for users who move or work remotely.
3. Calls to the emergency service deliver the callback number and location, and a call-back path to the user exists.
4. Notification to on-site contacts or a central point is designed where required for multi-line systems.
5. The product tells users how it behaves when the network, power or an app is down.
6. Counsel signs off, a test call plan was run with the relevant authority or carrier, and this file records the date and evidence.
7. A test replaces the "must stay false" assertion with tests of the real routing.

Flipping the constant alone does not create support. It would only stop the platform from refusing.

## 5. Registration and compliance checklist **[COUNSEL]**

This is a list of questions to answer, not a list of duties. Nothing here is a conclusion about what applies to Vireek.

| # | Item | Status |
|---|---|---|
| 1 | Decide, per country served, whether Vireek is a provider of a regulated voice or messaging service, an agent or reseller, or a software vendor to the carrier's customer | open |
| 2 | **United States:** federal registration or filing obligations for voice providers (for example telecommunications provider registration, universal-service contribution reporting, robocall-mitigation database registration, customer-data protection, law-enforcement assistance duties) and state-level registrations | open **[VERIFY each against the agency's current rules]** |
| 3 | **United States:** emergency-calling duties for voice services and for multi-line systems, and location-related requirements | open |
| 4 | **Canada:** provider registration or reporting with the regulator and emergency-calling duties | open **[VERIFY]** |
| 5 | **EU / EEA and UK:** whether a notification to a national regulator is needed for a number-based interpersonal communications service, and emergency-access duties | open **[VERIFY per member state]** |
| 6 | **Other countries in `outbound_country_codes`:** list, and check local rules, including number-holder requirements | open |
| 7 | Caller-ID rules and call-authentication requirements (numbers must belong to the account, authentication attestation) | open |
| 8 | Carrier contract: resale rights, acceptable use, emergency-calling disclaimers, who is the regulated party | open **[VERIFY contract]** |
| 9 | Call recording and AI disclosure: see `docs/compliance/voice-consent-and-ai-disclosure.md` | exists, needs counsel review |
| 10 | Lawful-intercept and legal-request handling: see `docs/compliance/legal-request-process.md` | exists, needs counsel review |
| 11 | Terms and in-product notice that emergency calls are not supported | open, drafting needed |
| 12 | Data retention for call records under telecom rules | open |
| 13 | Complaint handling and outage reporting duties | open |

## 6. Verification and limits

| Check | Result |
|---|---|
| Emergency detection across 38 written forms, 21 non-emergency values | PASSED with a local test shim (`_shared/telecom/emergencyNumbers.test.ts`) |
| Guard refuses in enforce, shadow, `enforce=false` and fraud-store-down modes | PASSED (same suite) |
| `outbound-dialer` source check ("a blocked send is never retried in a loop") | PASSED (`blockedHandling.test.ts`) |
| Strict `tsc` on the changed shared modules | PASSED |
| Edge function entry files (`pbx-voice`, `pbx-actions`, `outbound-dialer`) | Syntax parsed only. Deno and npm imports could not be type-checked here |
| Real Vitest run, Twilio and Vapi behaviour, softphone UI | NOT RUN |
| `planLimits.test.ts` "recomputed maximum possible loss" (4 tests) | FAILED before and after this change: the expected numbers in the test differ from `planLimits.ts`, which was not touched |

Known limits: there is no softphone UI in this snapshot, so the notice shown to a person dialling from a client is the TwiML speech or the API message
only. Locale strings for the in-app notice must be added where the softphone UI lives. Four files had broken merge fragments and were repaired while
making this change (`outbound-dialer/index.ts`, `pbx-actions/index.ts` import line, and two misplaced lines in `_shared/fraud/guard.ts`).
