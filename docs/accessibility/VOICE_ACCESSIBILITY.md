# Voice accessibility (hearing / speech difficulty)

Code: `supabase/functions/_shared/voice-accessibility/accessibility.ts` (pure, tested). Prompt block is injected through `voice-brand/persona.ts`. Text fallback tool: `request_text_followup`. Red-team fixtures: `eval/voice-redteam/accessibility-scenarios.ts` (ids `acc-*`).

## Principle
Accessibility changes **how Sarah talks**, never **what she is allowed to do**. Authorization stays in `voice-security/gate.ts`. A caller who mentions deafness, a stutter, an accent or a relay service gets the same verification, confirmation, rate limits and lockdown rules as anyone else, and is never scored as more suspicious.

## Behaviours
| Need | Behaviour |
|---|---|
| "Please repeat" | repeat, then simpler words, then offer a text, then text or a person (`repeatStrategy`) |
| "Slow down" | patient mode: max 25 words / 2 sentences, numbers in small groups (`speakDigits`) |
| Long pauses | check-in 15 s (patient) / 25 s (relay) instead of 5 s; a text/callback is always offered before ending; never hang up on silence in a flagged emergency |
| Relay / TTY / VRS | detected from the announcement (relay operator, "GA", TTY...); sticky for the call; longest silence allowance; caller ID is the relay provider's, so it is never texted |
| SMS fallback | `request_text_followup`: one fixed template (`sms_accessibility_followup`) to the caller's own caller-ID number only; on relay or blocked ID the agent asks for the caller's own mobile and books with it |
| Accent / recognition trouble | ladder: ask again, spell/read back, offer text, offer person/callback (`recognitionLadder`); never a risk signal |

## Required manual configuration (not in the repo)
1. **Vapi tool**: add `request_text_followup` to the assistant tools (tool schemas live in Vapi, not in this repo). Parameters: `reason` (enum: caller_requested_text, hearing_or_speech_difficulty, recognition_trouble, silence), `relay_call` (boolean). Server URL = the existing vapi-webhook.
2. **Silence timeouts**: `SILENCE_POLICY` is the intended policy; Vapi's own silence/idle settings must be raised to match [VERIFY the exact assistant field names in the Vapi dashboard; we did not touch them].
3. SMS needs an approved A2P campaign; otherwise the tool tells the agent to offer a callback.

## Known limits / open items
- Verification: OTP lives 5 min, 3 attempts, 3 known-detail failures. A slow or relay caller can run out of time, and a misheard last name counts as a failure. Not loosened (security owner decision); spelling and street number / ZIP are the accent-safe details.
- The injection scanner misses two disclosure phrasings dressed as accessibility requests (`acc-atk-disclosure-1`, `-2`); the gate still refuses everything, detection is informational.
- Spanish/English only for intent detection. Other languages are not covered.
- [COUNSEL] ADA/FCC relay obligations, SMS consent wording, accessibility-statement claims. [VERIFY] silence values with real relay / speech-to-speech users.
