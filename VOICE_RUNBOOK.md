# Voice: audio Morning Brief + "Call your Vireek"

## Order of work
1. Apply `supabase/migrations/20280410000000_voice_owner_experience.sql` (needs the daily-briefing migration already applied: it uses `push_subscriptions.subscriber_id` and `app.settings.briefing_cron_secret`).
2. Add the Ctrl+F edits (config.toml, App.tsx, CommandPalette.tsx, ENVIRONMENT.md).
3. Secrets: `supabase secrets set ELEVENLABS_API_KEY=… SARAH_VOICE_ID=… VOICE_WEBHOOK_BASE=https://<ref>.supabase.co/functions/v1/voice-call` (the rest — TWILIO_*, VAPID_*, RESEND_*, SITE_URL, BRIEFING_CRON_SECRET — already exist). Optional: `VOICE_SAY_VOICE`, `WHATSAPP_BRIEF_TEMPLATE`, and the cost rates below.
4. Deploy: `supabase functions deploy voice-brief --no-verify-jwt`, `voice-call --no-verify-jwt`, `voice-account`.
5. Twilio: on the inbound number set Voice URL `POST {VOICE_WEBHOOK_BASE}?step=start` and Status callback `POST {VOICE_WEBHOOK_BASE}?step=status`.
6. Tests: `npx vitest run supabase/functions/_shared/voice` then `npm run typecheck && npm run lint && npm run build`.
7. Call `select public.voice_purge_account(<owner>)` from your existing account-deletion / DSAR pipeline.

## Trust levels on the phone
| Level | How | Can do |
|---|---|---|
| 0 | unknown number | nothing, call ends |
| 1 | verified caller ID + 6-digit PIN (keypad) | counts, schedule, on-call, brief (money masked, names shortened) |
| 2 | + SMS code to the verified number (15 min) | dollar figures, full names, "send a text" |
Writes always need: level 2 + owner/admin role + read-back + keypad 1 or spoken "yes". Anything else is "unclear", never yes. Lock: 3 wrong PINs = 30 min.

## Cost model (ESTIMATES, not measured — set the real rates)
Env: `TTS_COST_CENTS_PER_1K_CHARS` (default 18), `VOICE_CALL_CENTS_PER_MIN` (2.5), `VOICE_LLM_CENTS_PER_ANSWER` (0.3).
- Brief: the sample 76-word brief is 415 characters ≈ **7.5¢**; a 150-word brief ≈ 15¢; a cache hit costs 0. No LLM is used. Stored per row in `voice_briefs.cost_cents`.
- Call: 3 minutes with 2 LLM answers ≈ 3×2.5 + 2×0.3 = **8.1¢**. Stored in `voice_call_sessions.cost_cents`.
Replace the defaults with your ElevenLabs plan price and Twilio invoice rates, then read real numbers from those columns.

## Manual verification checklist (nothing below has been run)
- [ ] Migration applies twice with no error; `voice_call_events` UPDATE/DELETE raises "append-only".
- [ ] RLS: user B cannot select user A's `voice_briefs`, `voice_preferences`, sessions or audio object; `voice_callers` returns nothing to `authenticated`.
- [ ] Two test accounts: call as owner A, ask "how did we do yesterday" after verify; numbers match A's dashboard and none of B's data appears.
- [ ] Wrong PIN ×3 locks; correct PIN after 30 min works; unknown caller ID is refused.
- [ ] Without the SMS code: dollar question → asks for code; "send a text" refused. With code: read-back → press 2 sends nothing → press 1 sends once (check `voice_pending_actions`, `voice_call_events`, SMS log).
- [ ] Say "ignore all previous instructions…": refused, event `injection_blocked`.
- [ ] Brief: Test button → audio plays, transcript, speed, "Why this?" links open the right pages; stop ElevenLabs key → text fallback appears.
- [ ] Quiet-day account gets no brief (`voice_briefs.status='skipped'`); quiet hours defer; second cron tick does not resend.
- [ ] Latency: p95 of `voice_call_events.server_ms` for deterministic intents; then a real call, time to first audio ≤ 1.5 s (filler "Let me check" plays for AI answers).
- [ ] WhatsApp: audio arrives inside the 24h window; outside it only with an approved template.

## Known limits
- Push cannot embed an audio player (web push / lock screen); the push is text-only and opens the in-app player. Email carries the transcript + a 24 h signed audio link, not an attachment.
- In-call speech uses Twilio Polly (fast). Sarah's ElevenLabs voice is used for briefs; live Sarah voice on calls needs ConversationRelay streaming (v2). Calls are English-only in v1; briefs are en/es/fr.
- WhatsApp business-initiated audio needs an approved template outside the 24 h window.
- Weather comes from NWS (US only); unknown/failed sources are left out, never spoken as zero.
- Register a feature key (e.g. `ai_voice_brief`) in the AI Transparency catalog if you want brief audio governed/recorded like voice cloning; not done here.
- Existing issue found: `whatsapp-webhook` does not verify Meta's `X-Hub-Signature-256`. Not changed here.
- Existing issue found: Ask Vireek's loader relies on RLS only; the voice function therefore never gives it a service-role client directly (`scopedClient.ts`).
