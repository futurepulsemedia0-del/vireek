# Research protocol — technician mobile flows in field conditions

Version: 0.1 (draft, not yet reviewed) · Owner: `[assign]` · Last updated: `[date on first edit]`

## 1. Purpose

Learn whether field technicians can complete the core `/tech/*` tasks quickly, correctly and safely **in the conditions where they really work**: with gloves, in glare, in a noisy truck and with weak or no signal. Output is a ranked list of evidenced usability problems and decisions, not a score.

## 2. Research questions

| ID | Question |
|---|---|
| RQ1 | Can technicians complete each core task wearing the gloves they normally work in? Where do taps miss, trigger the wrong control, or require removing a glove? |
| RQ2 | Can they read job status, address, time and warnings on a phone in direct sunlight and inside a dark van? |
| RQ3 | In a running, noisy vehicle, which parts of the flow depend on audio (voice notes, call prompts, sounds) and do they still work? |
| RQ4 | When signal is weak or drops, do technicians know what the app is doing, what was saved, and what to do next? Is any typed work lost? |
| RQ5 | Where do wording, ordering or icon-only controls cause hesitation or wrong turns? |
| RQ6 | What do technicians do instead (paper, texting the office, memory) when the app is hard to use, and what does that cost? |

## 3. Scope

**In scope** (routes from `docs/ROUTES.md`): `/tech/today`, `/tech/job/:jobId` (status advance, add note, flag unsafe, voice log, navigate, call), `/tech/messages` and `/tech/messages/:jobId`, `/tech/truck-stock`, `/tech/dvir`, `/tech/timesheet`.

**Out of scope:** office/dashboard screens, pricing, payments settlement, anything needing real customer data, statistical claims about the whole market.

## 4. Method

Moderated, in-context usability sessions (one facilitator, one note-taker, one participant), 30–45 minutes plus a short interview, on the participant's own phone where possible, using a **staging/test tenant with fictitious jobs**. Tasks are in [FIELD_USABILITY_TEST_SCRIPT.md](FIELD_USABILITY_TEST_SCRIPT.md). Qualitative; we do not report percentages as if they generalise.

### 4.1 Conditions

| Code | Condition | How it is created | Notes |
|---|---|---|---|
| C0 | Baseline | Bare hands, indoors, good signal | Reference only |
| C1 | Gloves | Participant's own work gloves, plus one thin (e.g. nitrile) and one thick pair if available | Record glove type; touchscreen-compatible or not |
| C2 | Glare | Outdoors in direct sun, screen brightness at the participant's usual setting, then at maximum | Record time of day and weather qualitatively; do not claim lux values without a meter `[VERIFY]` |
| C3 | Noisy truck | Parked vehicle with engine/HVAC/radio running at the participant's normal working level | **Never while driving.** Record approximate noise only with a calibrated meter or label it "uncalibrated" `[VERIFY]` |
| C4 | Weak signal | A real low-signal location if one is available; otherwise airplane mode on/off toggled by the facilitator at scripted moments | Record visible bars and, if possible, a speed/latency reading before the task |

Conditions can overlap (for example C1+C2). Counterbalance order across participants (see script §3) to limit learning effects.

### 4.2 Participants

- Active field service technicians in the trades Vireek serves, using or willing to use a smartphone for work.
- Planning assumption: 5–8 participants per distinct segment (trade, company size, new vs. experienced app user), then stop when new sessions stop revealing new problems. This is a qualitative planning heuristic, not a guarantee `[VERIFY with research lead]`.
- Include at least some participants who are **not** enthusiastic about technology, and some with older or smaller phones.
- Screener: age 18+, works in the field at least weekly, consents. Exclude Vireek employees and anyone in the direct reporting line of the facilitator.
- Recruit through customers' owners/dispatchers **only** with the participant's separate, uncoerced agreement; the employer must not learn what an individual said or did (see §6).
- Compensation: `[decide amount; COUNSEL to check tax/gift rules]`. Compensation is not conditional on completing tasks.

### 4.3 Roles

Facilitator (talks, never leads), note-taker (records on the observation sheet), safety lead (can be the facilitator; owns stop rules), research lead (owns analysis and the findings repository).

### 4.4 Equipment checklist

Test phone with staging build and test account, participant's own phone if agreed, spare charger/battery, printed consent and observation sheets, pen, timer, optional video/audio recorder with a separate consent opt-in, optional noise meter, a pair of thin and thick gloves in common sizes.

## 5. Safety rules (override everything else)

1. Sessions use **staged, fictitious jobs**. Participants are never asked to operate the app while working on a live job, driving, climbing, or near energised, pressurised or hot equipment.
2. The vehicle must be parked, in a safe location, for C3.
3. Stop immediately if the participant appears distracted from a real hazard, is uncomfortable, or asks to stop. No justification is needed.
4. Weather: stop outdoor sessions for lightning, extreme heat/cold, or surfaces that are unsafe.

## 6. Ethics and data protection

Detailed consent wording is in [CONSENT_FORM_TEMPLATE.md](CONSENT_FORM_TEMPLATE.md). Principles:

- Participation is voluntary and can be withdrawn at any time, including after the session, with the data removed.
- Technicians may be employees of our customers. Individual observations are **never** shared with their employer; only de-identified, aggregated insights are.
- Collect the minimum: pseudonym `Pnn`, trade, years of experience band, phone model, glove type. No names in notes. Recording is a separate opt-in.
- The key linking `Pnn` to a real person, signed consents and raw recordings are stored **outside this repository** in `[access-controlled location — decide]`, limited to the research team.
- Retention period, lawful basis, recording legality by jurisdiction, cross-border transfer and compensation tax treatment: `[COUNSEL]`. Do not start sessions until counsel has approved the consent form for the jurisdiction in which sessions take place.
- Do not use real customer data. Test tenant only.

## 7. Measures

Per task per condition: outcome (Success / Success with help / Partial / Failed / Abandoned), time on task, error count and type, glove removals, number of taps that missed, assistance given, verbatim quotes, post-task Single Ease Question (1–7). End of session: open debrief. A whole-product questionnaire (e.g. SUS) is optional and only meaningful with enough participants; do not publish it as a headline number from a handful of sessions.

Instrumented data (optional, only if already collected by the product and covered by consent): none is assumed. Do not add analytics solely for this study without a separate privacy review `[COUNSEL]`.

## 8. Analysis

1. Within 24 hours, the note-taker and facilitator reconcile the observation sheet and enter a **Session** record in the findings repository.
2. Convert each distinct observed problem into a **Finding** with condition, task, evidence (session IDs, verbatim quote), severity and confidence using the rubric in [FINDINGS_REPOSITORY_TEMPLATE.md](FINDINGS_REPOSITORY_TEMPLATE.md).
3. A finding needs at least one observed instance. A problem seen once is recorded with **low confidence**; do not drop it, do not inflate it.
4. Cluster findings by flow and by condition; look for problems that appear only in one condition (for example glare-only).
5. Update the hypothesis register: Confirmed / Refuted / Unclear / Untested, with the evidence.

## 9. Reporting and decisions

Report within one week of the last session: what was tested, who (de-identified segments), what was observed, ranked findings, hypotheses status, recommended changes, and **what was not learned**. Each recommended change gets an owner and a decision (Do / Defer / Won't do, with reason) recorded in the repository. Product changes go through the normal PR process, with the finding ID in the PR description.

## 10. Automated proxy test

`e2e/tech-field-conditions.spec.ts` approximates the *technical* side of weak signal and low-end devices (CPU throttle, slow/failing API, dropped connection). Its throttle values are our own choices, not field measurements `[VERIFY against real field logs]`. It supports RQ4 only partly and says nothing about RQ1–RQ3, RQ5 or RQ6. Treat a pass as "no regression of these specific behaviours", never as "usable in the field".

## 11. Pre-registered hypotheses (from reading the code, not from users)

These come from static reading of `src/pages/Technician*.tsx` on the uploaded snapshot. They are **unverified** and are listed so sessions can test them deliberately. Their status lives in the findings repository.

| ID | Hypothesis | Source of suspicion |
|---|---|---|
| H1 | On `/tech/job/:jobId` the back control is a bare icon button with no accessible name and a small hit area, which is hard to hit with gloves | `TechnicianJobBriefPage.tsx` header button |
| H2 | If the job brief request fails or stalls, the page stays on "Loading…" with no error or retry | `fetchJobBrief(jobId).then(setBrief)` has no failure branch |
| H3 | A failed "Save note" or "Mark as …" gives no visible failure message, so a technician may believe work was saved | no `catch` around `addJobNote` / `advanceJobStatus` call sites |
| H4 | A fast double tap on "Mark as …" under slow signal can submit twice because busy state is set only after the compliance check | `handleAdvance` order of operations |
| H5 | Secondary text on Today cards is small (`text-xs`) and low-contrast-prone, hurting legibility in glare | `TechnicianTodayPage.tsx` job row |
| H6 | Swipe and long-press shortcuts on Today cards trigger accidentally with gloves | `SwipeActionRow` / `useLongPress` usage |

## 12. Change log

| Version | Date | Change |
|---|---|---|
| 0.1 | `[date]` | Initial draft |
