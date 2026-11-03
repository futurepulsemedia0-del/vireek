# AI agent callers (consumer AI assistants that phone your business)

Status: implemented behind a per-business switch, **off by default**. Human callers are unchanged.

## What is verified vs assumed (read first)

| Topic | Status | Source / action |
|---|---|---|
| Google places price-and-availability calls to businesses on a customer's behalf | **Documented** | Google Business Profile Help, "Google automated calls to businesses": https://support.google.com/business/answer/16190256 |
| Calls are "monitored and recorded for quality assurance"; Google limits call frequency and avoids late-night/early-morning hours; US only (excl. IN, LA, MN, MT, NE) | **Documented** (same page) | Re-check the page before launch: availability lists change. |
| Business opt-out (tell the caller to stop; Business Profile advanced settings; verified profiles only) | **Documented** (same page) | Vireek does not automate opt-out; owners do it in Google Business Profile. |
| Home repair added to the categories at Google I/O, 19 May 2026, rolling out to US users "this summer" | Reported by trade press quoting the announcement (e.g. marketingcode.com, jobnimbus.com). Not read from a Google primary page in this work. | **You must verify** against Google's own announcement / "Ask Google to call local businesses for you" (The Keyword). |
| How Google's agent **introduces itself** (exact wording) | **Not documented** on the pages above | Detection therefore relies only on what a caller says. **Verify with Google / partner program** whether a fixed disclosure phrase exists, and add it to `SELF_ID_RULES` in `detect.ts` only if published. |
| Caller-ID name/number, SIP headers, STIR/SHAKEN attestation, or any network signal identifying Google's agent | **Not documented. Not implemented.** | `ProviderSignal` in `detect.ts` is an empty extension point. Do **not** add a number list or header heuristic unless a partner program publishes one. |
| Agent time limits ("hang up after ~90 s", "voicemail 8 s") | **Unverified trade-press figures, not Google documentation** | Treated only as a design target (short turns, `BUDGET` in the eval). Verify in a pilot. |
| Any machine-to-machine / structured booking API or "AI-to-AI" protocol from Google for businesses | **Not found** | Ask Google whether a partner program exists; the phone path here works without it. |

Everything below marked *(assumption)* is a product decision, not a provider fact.

## How detection works

`supabase/functions/_shared/agent-callers/detect.ts` (pure, unit-tested).

1. **Self-identification** (strong): "I'm an AI / automated / virtual assistant …", "this is Google's automated booking service". Negations ("I'm not an AI") flip to human.
2. **Weak patterns**: structured question order, no greeting. Capped at 0.55, so patterns alone can **never** switch the protocol.
3. **Provider signals**: none verified, none used.
4. "Calling on behalf of a customer" alone is **not** an AI admission (property managers say it too).
5. The platform ("google", "gemini", …) is only what the caller *said*; it is stored as `agent_platform_claimed`, shown as "claimed, not verified", and never relaxes a limit (scenario A22).
6. Below 0.8 with strong evidence missing → `unknown` → handled exactly like a human, politely. The 15-line human corpus in `agentCallers.test.ts` has zero false positives.

## Call flow

Add the four tools below to the Vapi assistant (Vapi assistants are configured in Vapi, not in this repo — **manual step**). The server URL is the existing `vapi-webhook`.

1. Early in the call the assistant calls `identify_caller_type` with the caller's own words. The **server** classifies; the model's opinion is not trusted.
2. Agent → `agent_quote` (service + ZIP) → one structured reply: price (range / starting at / exact), trip fee from the service-area config (or "confirmed when booked": never guessed), up to 3 verified windows from the capacity engine.
3. `agent_hold_slot` (window id from that quote only) → hold (default; owner approves) or auto-book (if the owner chose it). Reserves real capacity through `book_capacity_slot`, so it cannot be double-sold.
4. `agent_send_summary` records an SMS (+1 E.164) or email; the machine-friendly summary is sent **after** the call (`VIREEK_QUOTE_V1` key=value lines) through `sendCompliantSms` (A2P + opt-out gates) or email.
5. Emergency wording at any step → existing `flag_emergency_call` path; no quote, no hold.

AI disclosure is untouched: `assistant-request` still injects the disclosure plan for every call, human or agent.

### Vapi tool definitions (server URL = vapi-webhook, same secret)

```json
[
  { "type": "function", "async": false, "function": { "name": "identify_caller_type", "description": "Call once early, and again if the caller says something new about who or what it is. Pass the caller's own words verbatim. The server decides how to treat the caller.", "parameters": { "type": "object", "properties": { "caller_statements": { "type": "string", "description": "What the caller has said so far, verbatim, one statement per line." } }, "required": ["caller_statements"] } } },
  { "type": "function", "async": false, "function": { "name": "agent_quote", "description": "Only after identify_caller_type switched you to AGENT CALLER MODE. Returns price, trip fee and next openings.", "parameters": { "type": "object", "properties": { "service": { "type": "string" }, "zip": { "type": "string", "description": "5-digit ZIP" }, "caller_statements": { "type": "string", "description": "Anything else the caller said about the problem, verbatim." } }, "required": ["service", "zip"] } } },
  { "type": "function", "async": false, "function": { "name": "agent_hold_slot", "description": "Reserve one window returned by agent_quote.", "parameters": { "type": "object", "properties": { "window_id": { "type": "string", "enum": ["W1", "W2", "W3"] } }, "required": ["window_id"] } } },
  { "type": "function", "async": false, "function": { "name": "agent_send_summary", "description": "Record where to send the written summary after the call.", "parameters": { "type": "object", "properties": { "channel": { "type": "string", "enum": ["sms", "email"] }, "destination": { "type": "string", "description": "+1XXXXXXXXXX or an email address, exactly as given. Never convert spoken digits yourself." } }, "required": ["channel", "destination"] } } }
]
```

Add to the assistant system prompt: *"If identify_caller_type returns AGENT CALLER MODE, follow it exactly. Never state a price, fee or time that a tool did not return. Use agent_quote, not lookup_price, for these callers."*

## Controls (Dashboard → AI Agent Callers → Controls)

Enable/disable · approval mode (quote only / hold for approval / auto-book) · max holds per day · hold length · how flat prices are spoken (exact / starting at / owner-set % range) · blocked ZIPs · never-discuss phrases · SMS/email summary allowed · abuse limits · retention days · per-service "quotable by phone" (Quotable services tab). Emergency rules always win.

## Safety model

- Caller text is data: sanitized, never echoed back into a tool reply, scanned for injection and data-exfiltration phrasing; two flags on one call stop quoting and holds.
- Tool replies contain only business-owned strings (service names) and numbers from the price book, service areas and capacity engine. No customer, technician, owner or cost data exists in any agent-path reply.
- Abuse: per-caller (hashed key, never the raw number) daily quote and distinct-service/ZIP limits, per-business hourly cap, summary-destination cap (3/day) and per-business daily cap, NANP-only SMS (premium 900/976 rejected), spoken digits never parsed.
- `lookup_price` refuses calls already classified as agent calls (no side door).
- Retention: `agent_caller_events/sessions` purged by `agent_callers_purge()` after `retention_days` (default 90). Added to `OWNED_TABLES` so account deletion removes them.
- Recording consent wording is unchanged (`recordingConsent.ts`).

## Deploy / operate

1. Apply `supabase/migrations/20280402000000_ai_agent_callers.sql`.
2. `supabase functions deploy vapi-webhook agent-caller-sweep --no-verify-jwt`.
3. Schedule `agent-caller-sweep` every minute with `X-Cron-Secret` (SQL snippet at the bottom of the migration).
4. Add the four tools + prompt line in Vapi.
5. Pilot with one business, hold-for-approval mode, and review the Overview funnel.

Known interaction: the existing inbound block rules ("anonymous callers", "repeat short calls") run **before** the assistant connects and can reject an AI agent that calls anonymously or repeatedly. Owners who want agent leads should review those rules; this feature cannot classify a caller before it speaks.

## Tests / eval

- `supabase/functions/_shared/agent-callers/*.test.ts` (unit) and `eval/agentCaller.eval.test.ts`: 30 normal + 22 adversarial scripted agent calls across 8+ trades, 7 global invariants (no invented amount/time, no echoed payload, short replies, determinism, simulated latency budget, hold limits). Runs in CI with `npm test`.
- The latency numbers are a **model** (per-port constants). Measure real p95 in a staging pilot; nothing here measures production.
