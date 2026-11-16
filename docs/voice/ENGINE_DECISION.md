# Voice engine decision: stay on Vapi, add a second engine only behind the interface

**Status:** decision record. **No second engine has been built, run, or measured.** Anything not verifiable from this repository is marked **unknown**; none of the unknowns were filled from memory.

## Options
| | Vapi (current) | LiveKit Agents (stub in `_shared/voice/livekitProvider.ts`) | Pipecat |
|---|---|---|---|
| Hosting model | Vendor-hosted voice pipeline; we receive webhooks | We host an agent worker (long-lived process) + LiveKit Cloud or self-hosted server | We host the Python pipeline process + a transport |
| Runs in Supabase Edge Functions? | Yes (webhook handler only) | **No**: agent workers are long-lived; needs container/VM hosting (verified constraint from the architecture, also stated in `docs/voice-engines.md` for realtime engines) | **No**, same reason |
| Telephony | Twilio number → Vapi (existing) | Needs a SIP trunk/dispatch rule into rooms | Needs a telephony transport |
| Per-minute cost | **unknown** (Vapi invoice/pricing page not in repo) | **unknown** | **unknown** |
| End-to-end latency | **unknown** from repo; alert rules assume turn p95 < 2.5 s warn / 4 s critical (`alertRules.ts`), which are targets, not measurements | **unknown** | **unknown** |
| Control (prompt, VAD, barge-in, tools) | Limited to Vapi's schema | Full code-level control | Full code-level control |
| Ops burden | Low: vendor runs it | High: deploys, scaling, on-call for the worker fleet | High: same |
| Lock-in today | High (177 code files mention Vapi; webhook holds ~25 tool handlers) | n/a | n/a |

## Decision
1. Keep Vapi as the only production engine.
2. Land the provider interface (done) and migrate low-risk call sites to it over time (see `PROVIDER_COUPLING.md` §C).
3. Do **not** commit to LiveKit or Pipecat until the measurements below exist. If forced to pick for a spike: LiveKit Agents (TypeScript/Node agent available, fits this TypeScript codebase) — this is a preference, not evidence.

## Measurements needed before any switch (owner: human, on staging)
1. Vapi: last 3 months of invoices → effective $/min including STT/LLM/TTS pass-through.
2. Vapi: p50/p95 turn latency and time-to-first-word from the existing observability (`voice-observability.dashboard.json`).
3. Spike: one LiveKit agent answering a staging number; record the same two latency metrics and the monthly host cost of the worker.
4. Port 3 representative tools (`check_availability`, `book_appointment`, `lookup_customer`) and compare booking success rate on 50 scripted calls.
5. Compliance: confirm recording-pause/PCI flow (`_shared/pci/ports.ts`) is reproducible on the new engine. **Blocker for payments by voice.**
