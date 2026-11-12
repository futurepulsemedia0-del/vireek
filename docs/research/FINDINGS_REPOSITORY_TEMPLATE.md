# Findings repository — technician field usability

**Status: empty template. No sessions have been run, so there are no findings.** Do not add a finding without session evidence. Copy this file per study round (for example `findings-2026-round-1.md`) and fill the copy.

## Rules

1. A **finding** is something observed or heard in a session. Each needs ≥ 1 session ID and, where possible, a verbatim quote.
2. A **hypothesis** comes from code reading, prior analytics or opinion. It is not a finding until observed. Hypotheses live in §4.
3. Automated proxy test results (`e2e/tech-field-conditions.spec.ts`) are **not** user evidence; they may be cited only as "regression check".
4. Participants are `Pnn`. No names, employers, customers, phone numbers or addresses.
5. Report sample honestly: "observed in 2 of 6 sessions", never a percentage presented as a population rate.
6. Every recommendation records a decision and an owner. "Won't do" needs a reason.

## 1. Severity rubric (internal scale, not an external standard)

| Level | Meaning |
|---|---|
| S0 Blocker | Task cannot be completed, data is lost silently, or the design creates a safety risk |
| S1 Major | Task completed only with help/workaround, repeated errors, or a glove removal that would be unsafe/impractical on a real job |
| S2 Minor | Noticeable hesitation or small error, recovers alone |
| S3 Cosmetic | Preference or polish, no task impact |

**Confidence:** High = seen in ≥ 3 sessions or on video with consistent cause; Medium = seen in 2 sessions or with a clear mechanism; Low = seen once or cause unclear.

## 2. Session log

| Session ID | Date | Participant | Segment (trade / experience band) | Phone | Conditions run | Recording consent | Notes file | Status |
|---|---|---|---|---|---|---|---|---|
| _none yet_ | | | | | | | | |

## 3. Findings index

| ID | Title | Flow / route | Condition | Severity | Confidence | Sessions | Status | Decision |
|---|---|---|---|---|---|---|---|---|
| _none yet_ | | | | | | | | |

Status values: `New`, `Triaged`, `Planned`, `In progress`, `Shipped`, `Verified in follow-up`, `Won't fix`.

## 4. Hypothesis register

Source of H1–H6: static reading of the code snapshot, listed in the protocol §11. **All are untested.**

| ID | Hypothesis | Related RQ | Status | Evidence (finding IDs / sessions) |
|---|---|---|---|---|
| H1 | Job-page back control is icon-only, unnamed and small, hard to hit with gloves | RQ1 | Untested | |
| H2 | Failed or stalled job-brief load stays on "Loading…" with no error/retry | RQ4 | Untested | |
| H3 | Failed note save or status change gives no visible failure, so users may think work is saved | RQ4 | Untested | |
| H4 | Fast double tap on "Mark as …" under slow signal can submit twice | RQ1, RQ4 | Untested (the proxy test carries an expected-fail marker; running it is a code check, not user evidence) | |
| H5 | Small, low-contrast secondary text on Today cards is hard to read in glare | RQ2 | Untested | |
| H6 | Swipe/long-press on Today cards triggers accidentally with gloves | RQ1 | Untested | |

Status values: `Untested`, `Confirmed`, `Refuted`, `Unclear`.

## 5. Finding template (copy one block per finding)

```markdown
### F-___ — <short, neutral title>

- **Severity / Confidence:** S_ / High|Medium|Low
- **Flow / route:** e.g. /tech/job/:jobId — add note
- **Condition(s):** C0|C1|C2|C3|C4 (+ glove type / lighting / signal detail)
- **Evidence type:** Observed | Self-reported | Video | Instrumented
- **Sessions:** S__, S__ (n of N sessions where the task was attempted in this condition)
- **What happened (facts only):**
- **Verbatim quote(s):** "…" — P__
- **Impact on the technician's work:**
- **Likely cause (clearly labelled interpretation):**
- **Linked hypothesis:** H_ (confirmed / refuted / new)
- **Recommendation:**
- **Decision:** Do | Defer | Won't do — reason — owner — date
- **Product reference:** PR / issue link when it exists
- **Follow-up verification plan:** how we will check the fix works in the same condition
```

## 6. Session record template (copy one block per session)

```markdown
### S__ — P__ — <date>

- **Segment:** trade, experience band
- **Setup:** phone, OS, gloves, location, qualitative lighting/noise/signal
- **Conditions run:** C_, C_
- **Task outcomes:** table of T1–T10 with outcome, time, SEQ
- **Safety events / stops:** none | describe
- **Workarounds observed:**
- **Notable quotes:**
- **Facilitator caveats (leading, interruptions, equipment problems):**
- **Findings raised:** F-___, F-___
```

## 7. Round summary template

```markdown
## Round <n> summary — <date range>

- **Sessions:** N (segments, conditions covered)
- **Not covered / limits:** e.g. no C3 sessions, one trade only, staged jobs
- **Top findings by severity:** F-… (with n sessions each)
- **Hypotheses:** confirmed / refuted / unclear counts, with IDs
- **Decisions and owners:**
- **Follow-up round plan:**
```

## 8. Retention

Keep this file free of personal data so it can live in the repository. Raw notes with any identifying detail, consent forms and recordings stay in the restricted store defined in the protocol §6, with retention set by `[COUNSEL]`.
