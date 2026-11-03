# Live interpreter (BETA — not production-ready)

## Modes
| Mode | How | Runs where |
|---|---|---|
| `assistant` | Sarah speaks the caller's language for the whole call; English transcript + original saved | Vapi + `vapi-webhook` prompt variable `interpreter_context` |
| `bridge_consecutive` / `bridge_simultaneous` | Sarah leaves; caller and staff are joined through a media-stream worker that interprets both ways | `services/interpreter-bridge` (Node 22) + Twilio |
| `captions` | Text-only live translated captions; also the automatic fallback when added latency exceeds budget | worker / dashboard |

## Pieces
- Pure core `supabase/functions/_shared/interpreter/*` (language ID, critical-field read-back, safety text, glossary, governor, pipeline, scoring, readiness).
- DB: `supabase/migrations/20280403000000_live_interpreter.sql` (rollback notes in its header).
- Functions: `interpreter` (translate / start_bridge / set_session / ingest), `interpreter-bridge-twiml`.
- UI: `/dashboard/interpreter` settings, language badge, bilingual transcript, `/dev/interpreter` playground.
- Eval: `scripts/interpreter-eval.mjs`, golden sets in `_shared/interpreter/golden/`.

## Secrets / env
Functions: `GEMINI_API_KEY`, `INTERPRETER_BRIDGE_SECRET` (≥32 chars), `VAPI_PRIVATE_KEY`, `TWILIO_AUTH_TOKEN`, `INTERPRETER_TWIML_BASE`, `INTERPRETER_WORKER_WSS_URL`.
Worker: see header of `services/interpreter-bridge/server.mjs` (Deepgram, ElevenLabs, Gemini, Twilio keys, `INTERPRETER_CALLER_ID`, same bridge secret).

## Deploy order
1. Apply migration. 2. Set secrets, deploy both functions. 3. Deploy worker (Dockerfile) behind WSS. 4. Point the Twilio bridge number's voice webhook at `interpreter-bridge-twiml`. 5. Apply edits in `INTERPRETER_EDITS.md`, add `{{interpreter_context}}` to the Vapi prompt. 6. Enable per business in Settings → Live interpreter.

## Safety design
Emergency terms in 11 languages bypass all confidence rules and go to a human. Gas/fire/CO instructions are fixed pre-written text, never model-generated; other hazards escalate to a person. Addresses, phones, times, days, prices, codes are re-extracted from the translation and compared to the source; mismatches are re-translated once, then re-asked, then handed off. AI-interpreter disclosure is spoken in both languages. Low-confidence turns are never relayed silently.

## Readiness (honest)
All languages are **BETA**. GA needs measured chrF/WER on real or recorded audio per language and native-reviewer sign-off (`PHRASE_REVIEW` is empty). Offline gate passes (see below), but that only proves the deterministic layers.

## Compliance (not legal advice)
Disclosure plays on every interpreted call. Recording-consent state list in `compliance.ts` is a starting point — confirm with counsel. Retention default 90 days (7–730), purged by `interpreter_purge_expired`. No training use unless business opt-in AND per-call consent.

## Verification status
See the final report. Not done: live audio, real Vapi/Twilio/Deepgram/ElevenLabs calls, WER/chrF on real audio, React typecheck/tests, `extension` transfer field on Vapi.
