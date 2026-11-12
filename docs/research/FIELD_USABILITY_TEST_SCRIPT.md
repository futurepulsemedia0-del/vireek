# Field usability test script — technician mobile flows

For facilitators. Read [RESEARCH_PROTOCOL.md](RESEARCH_PROTOCOL.md) first. Consent must be complete ([CONSENT_FORM_TEMPLATE.md](CONSENT_FORM_TEMPLATE.md)). Say the quoted text aloud; do everything else silently. **Never lead**: do not name a button, say where to tap, or say "it's easy".

## 1. Before the day

- [ ] Staging build installed; test technician account with **fictitious** jobs (at least 3 today, one with a safety flag, one with a parts shortage). No real customers.
- [ ] Phone charged, screen auto-lock extended, notifications off except what the test needs, battery saver off (note if the participant's own phone has it on).
- [ ] Observation sheets printed (§7); timer ready; recording only if consented.
- [ ] Gloves available in common sizes: thin (nitrile-type) and thick/insulated.
- [ ] Location for C2 (sun, safe, no traffic) and a parked vehicle for C3. A low-signal spot for C4 if one exists; otherwise airplane-mode toggling plan (§5).
- [ ] Safety rules from the protocol §5 reviewed with the second team member.

## 2. Opening (5 min)

"Thanks for doing this. We're testing the app, not you; nothing you do is wrong. Please think aloud. If you'd rather use your own words for anything, do. You can stop any time. I can't help with the tasks while you do them, but I'm taking notes on where the app could be better. Do you have questions before we begin?"

Confirm: consent signed, recording choices, "Is it safe and comfortable here?"

Warm-up questions (write short answers, no names): trade; years in the field; phone model; how they use a phone on a job today; what they do when signal is bad; what they do when gloves get in the way.

## 3. Condition order (counterbalance)

Rotate the order of C1–C4 blocks across participants (P01: C1 C2 C3 C4, P02: C2 C3 C4 C1, P03: C3 C4 C1 C2, …). Do C0 (bare hands, indoors) for Tasks 1–2 first as a reference. Overlap conditions when natural (for example gloves outdoors), and record the overlap.

## 4. Tasks

Use the same wording for everyone. Success criteria are written so two observers agree. Allow a task to be abandoned by the participant at any time; record it, do not push.

| # | Scenario read aloud | Starting point | Success criterion | Related hypotheses |
|---|---|---|---|---|
| T1 | "You're starting your day. Find out what jobs you have and which one is first." | Phone unlocked, app at Today | Names the first job's customer and time correctly | H5 |
| T2 | "Open the job for `[fictitious customer A]` and tell me the address." | Today | Job opens; address read out correctly | H5, H6 |
| T3 | "You're heading there. Let the office know you're on your way." | Open job | Status becomes **En Route** exactly once | H4 |
| T4 | "Get directions to the address." | Open job | Maps/navigation opens with the right address | — |
| T5 | "You've found the problem. Leave a note: *Replaced capacitor, unit running.*" | Open job | Note saved with correct text; participant can say it was saved | H3 |
| T6 | "Something unsafe at the site. Record that." | Open job | Safety flag set, and participant knows it worked | H3 |
| T7 | "Message the office that you need a part." | Open job or Today | Message sent to the correct job thread | — |
| T8 | "Check whether you have `[fictitious part]` in your truck." | Today | Quantity read out correctly | — |
| T9 | "Complete your vehicle inspection for today." | Today | Inspection submitted, or the participant correctly says why not | — |
| T10 | "Say the note out loud instead of typing." (voice note, only if the feature is enabled for the account) | Open job | Voice note captured and the participant can confirm what was saved | RQ3 |

Run T3–T6 at least once in C1 (gloves) and once in C4 (weak signal). Run T1, T2, T5 in C2 (glare) and T10 in C3 (noisy truck). Add others as time allows. Do not ask the participant to complete a task they find unsafe.

### Prompts allowed during a task

Only neutral prompts: "What are you thinking?", "What did you expect to happen?", "Take your time." After 2 minutes of no progress, ask "What would you do next if I weren't here?" and, if still stuck, record "Failed" and move on.

## 5. Condition procedures

**C1 Gloves.** Ask the participant to wear what they actually wear. Record glove type and whether it is touchscreen-compatible. Note taps that miss, wrong control hit, accidental swipes or long-presses, and each time the glove comes off. Ask afterwards: "What would you have done on a real job?"

**C2 Glare.** Move to direct sun in a safe place. Record time of day and qualitative conditions. Ask them to tilt or shade the phone as they normally would. Note squinting, shading, moving, brightness changes, and anything misread (status, time, address, warning). Run once at their usual brightness and once at maximum.

**C3 Noisy truck.** Parked, engine/HVAC/radio at their normal working level. Note anything that depends on hearing (voice recording quality, ringtones, prompts) and anything misheard. Record noise only with a calibrated meter, otherwise write "uncalibrated" `[VERIFY]`. **Do not do this while driving.**

**C4 Weak signal.** Prefer a real low-signal location; record bars and a speed/latency reading beforehand if possible. If unavailable, use airplane mode: turn it on just after the participant starts T5 (note), let them try to save, narrate nothing, then turn it off after they react, and note what they do and whether typed text survives. Ask: "What do you think happened to your note?" Record whether they trust the app's state.

## 6. After each task (30 seconds)

Ask: "Overall, how easy or difficult was that task? 1 is very difficult, 7 is very easy." Record the number and one sentence why.

## 7. Observation sheet (one per participant; copy rows as needed)

```text
Session ID: S___   Participant: P__   Date: ____   Facilitator: ____   Note-taker: ____
Phone: ____  OS: ____  Gloves: ____ (touch-compatible Y/N)  Weather/lighting (qualitative): ____
Signal bars / speed (if known): ____   Noise (uncalibrated / meter model): ____   Recording consent: notes / audio / video

Task | Condition(s) | Outcome (S / S+help / Partial / Fail / Abandon) | Time (s) | Missed taps | Wrong control | Glove off? | Errors / confusion (what happened) | Verbatim quote | SEQ 1–7
T1   |              |                                                  |          |             |               |            |                                                                |                |
...
Unprompted workarounds (paper, texting office, memory):
Safety interventions / stops:
```

Record **what you saw and heard**, not what you think it means. Interpretation happens in the analysis step.

## 8. Debrief (5–10 min)

1. "What was the hardest moment today?"
2. "What did you do differently from what you'd do at work, and why?"
3. "When signal dropped, what did you expect the app to do?"
4. "Is there anything on these screens you couldn't read or hit when you're actually working?"
5. "What do you do today when the app doesn't work for you?"
6. "Is there anything we should have asked but didn't?"

Thank the participant, confirm compensation, repeat how to withdraw their data, and remind them their employer will not be told what they did or said.

## 9. After the session (within 24 hours)

1. Reconcile notes with the note-taker; fix unclear entries while memory is fresh.
2. Create a **Session** record in [FINDINGS_REPOSITORY_TEMPLATE.md](FINDINGS_REPOSITORY_TEMPLATE.md) (copy it into the working repository file).
3. Store consent forms and recordings in the location named in the protocol, not in this repository.
4. Remove any names, numbers or addresses that slipped into notes.

## 10. Stop rules (any one ends the session)

- Participant asks to stop or appears uncomfortable or unsafe.
- A real hazard appears (traffic, weather, equipment, ladder, height).
- A real customer call or job needs the participant. Reschedule; never compete with live work.
