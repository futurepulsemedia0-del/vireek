# Survey method — sampling, bias and question wording

Owner: Product / Design research. Status: **method only — no survey has been run yet, so this file contains no findings and no Vireek data.** Every number below is statistical arithmetic, not a measurement of our customers.

Use this method when a decision needs a *count* ("how many of our owners do X?"). For *why* and *how* questions, or anything involving a technician's hands, gloves or truck, use the interview and field-session method in [RESEARCH_PROTOCOL.md](RESEARCH_PROTOCOL.md) instead. Consent wording lives in [CONSENT_FORM_TEMPLATE.md](CONSENT_FORM_TEMPLATE.md) and needs legal review **[COUNSEL]** before first use. Results are recorded as in [FINDINGS_REPOSITORY_TEMPLATE.md](FINDINGS_REPOSITORY_TEMPLATE.md) and cited from a decision record under [`../adr/`](../adr/README.md) as `research:` evidence.

## 1. Start from the decision, not the questionnaire

Before writing a single question, write down (in the survey record, §9):

1. **The decision** this survey feeds, and the ADR it will be cited from (or "none yet").
2. **The smallest result that would change the decision.** Example: "If fewer than a third of owners do X, we do not build Y." If no result could change the decision, do not run the survey.
3. **The population** the answer is about (§2) and the **estimate** you need (a share, a median, a ranking).
4. **What we will do with each outcome**, written before fieldwork. This is the survey's pre-registration; changing it after seeing results is allowed only with a dated note.

Questions that do not feed that decision are cut. A short survey beats a thorough one: every extra question lowers completion and the quality of the answers to the questions after it.

## 2. Population and sampling frame

**Name the unit.** "Customers" is not a population. Pick one and write it down:

| Unit | Who | Typical frame |
|---|---|---|
| Account owner | The person who pays and configures | Accounts table (owner contact), billing records |
| Dispatcher / office user | Runs the day | Team members of selected accounts, **only** via the owner's agreement |
| Technician | Works in the field | Never recruited through the employer's list without the technician's separate, uncoerced agreement (see RESEARCH_PROTOCOL §4.2) |
| End customer (homeowner) | Booked a job | Only with the tenant's written agreement and the customer's own consent **[COUNSEL]** |
| Prospect / churned account | Never bought, or left | Trial signups, cancellations; reachability is lower and the data-protection basis differs **[COUNSEL]** |

**Write down the frame and its holes.** The frame is the list you can actually draw from. Whoever is not on it cannot be sampled, and that gap is *coverage error*. For each survey record the frame source, the date it was pulled, how many units it holds, and who is missing (accounts without a verified email, accounts that opted out of research contact, accounts in markets we cannot contact lawfully **[COUNSEL]**).

**One respondent per account** unless the unit is the individual. Two answers from one company are not independent.

**Exclude, and say so:** Vireek staff, test and demo accounts, accounts under an active support escalation or billing dispute (a research email there reads as a tone-deaf interruption), and anyone who opted out.

## 3. Sampling

### 3.1 Choose a design deliberately

| Design | Use when | Consequence |
|---|---|---|
| **Census** (invite everyone on the frame) | Population below roughly 200 units, or every voice matters (churned accounts) | No sampling error, but non-response still biases the result |
| **Simple random sample** | Population is large and fairly uniform | Unbiased by design; easy to explain |
| **Stratified random sample** | Groups differ and you must report on them (trade, size, region, plan, tenure) | Guarantees enough respondents per group; needs weights to describe the whole |
| **Purposive / convenience** (power users, volunteers, an in-app prompt) | Early exploration, generating hypotheses | **Cannot estimate a share.** Report counts of people, never "X% of customers" |

Default for a decision that needs a share: **stratified random**, strata chosen *before* looking at results.

### 3.2 Draw the sample reproducibly

Select with a seeded shuffle (record the seed in the survey record), not by hand. Never "pick accounts that seem representative". Keep the invited list outside the repository. Record how many were invited per stratum.

### 3.3 How many responses

For a share with 95% confidence, the worst-case (p = 0.5) number of responses is

    n0 = z² · p · (1 − p) / e²          with z = 1.96
    n  = n0 / (1 + (n0 − 1) / N)        finite-population correction, N = frame size

Arithmetic (not our data):

| Margin of error ±e | Frame size N | Responses needed |
|---|---|---|
| 5 points | very large | 385 |
| 5 points | 500 | 218 |
| 10 points | 500 | 81 |
| 10 points | 200 | 66 |
| 10 points | 80 | 44 |

Margin of error by responses at p = 0.5 (large population): n = 20 → ±22 points, n = 40 → ±15.5, n = 100 → ±9.8, n = 200 → ±6.9.

These figures assume a probability sample and **no non-response bias**. Neither is guaranteed (§4), so treat them as a floor on honesty, not a certificate. Plan invitations as `needed responses ÷ expected response rate`. We have no measured response rate yet; do not assume one. Pilot (§6.4) and record the real rate.

**Small groups.** Do not report a percentage for any group with fewer than 30 responses; report counts ("6 of 20"). When a share must be shown for a small n, show the interval: 6 of 20 has a 95% Wilson interval of about 15%–52%; 30 of 100 about 22%–40%. A reader who sees "30%" without the range is being misled.

### 3.4 Response rate and follow-up

Define it once and keep the definition: **completed responses ÷ eligible units invited**. State the eligibility rule. Send at most one initial invitation and two reminders, spaced days apart, and never to anyone who has replied or opted out. More than that is pressure, and pressured answers are lower quality.

## 4. Bias — what to expect and what to do

Assume every one of these is present until shown otherwise. The survey record (§9) has a table where each is marked *not applicable / mitigated / present and reported*.

| Bias | How it shows up for a field-service SaaS | Mitigation | How to detect |
|---|---|---|---|
| **Coverage** | Frame is "accounts with a working email"; the owner who lives in the truck and never reads email is missing | Add a second mode (SMS link) **[COUNSEL]** for messaging consent; name the gap | Compare frame to the full accounts table |
| **Non-response** | Busy owners and unhappy owners answer less; enthusiasts answer more | Short instrument, mobile-first, one reminder each; compare responders to the full frame on known fields (plan, size, tenure) | Responder vs. frame table in the record |
| **Self-selection** | An in-app prompt reaches only people who open the app | Prefer a randomly drawn invitation to an open prompt; if a prompt is used, label the result *engaged-user sample* | Note the channel for every response |
| **Survivorship** | Surveying only current customers says nothing about why people left or never bought | Include a churned/lost stratum when the decision concerns retention or acquisition | Frame definition |
| **Power asymmetry / courtesy** | Customers tell the vendor what the vendor wants to hear; technicians tell the boss's vendor what is safe | Anonymous or pseudonymous collection; the employer never sees individual answers; independent wording of "what went wrong" | Compare to behaviour data where it exists |
| **Social desirability** | Over-reporting "best practice" (always documenting, always following up) | Ask about the *last time* something happened, not "usually"; allow "sometimes/rarely" without judgment | Contrast with system logs |
| **Acquiescence** | Agree/disagree items drift to "agree" | Use item-specific response options instead of agree/disagree; mix directions only if needed | Straight-lining check |
| **Order and anchoring** | Earlier questions colour later ones; the first option listed is picked more | Randomise option order for unordered lists; put general before specific; put sensitive and demographic items last | Randomisation flag stored with each response |
| **Recall** | "How many calls did you miss last year?" is a guess | Short windows ("last 7 days", "your last job"), or look it up in the product | Prefer system data when it exists |
| **Hypothetical** | "Would you use feature X?" overstates real use | Ask what they did last time; show a real artefact; treat stated intent as weak evidence and say so | Later usage data |
| **Translation / format** | A Persian or Arabic string that reads as a calque; RTL options that reverse a scale | Back-translation by a second bilingual reader; render check in RTL on mobile; scales read in reading direction | Pretest (§6.3) |
| **Low-quality responses** | Bots, duplicate submissions, speeders, straight-liners | One link per invitee; time-to-complete floor; attention-free design (do not insult respondents with trap questions) — drop only on pre-stated rules | Completion time and duplicate-token checks only; do not fingerprint respondents' devices |
| **Incentive** | A reward changes who answers and what they say | If used, small, equal for everyone, paid regardless of answers, never a discount that ties to buying **[COUNSEL]** | Record whether an incentive was offered |
| **Interviewer / AI-moderator** | A human or AI reading questions aloud changes the wording | Fixed script; log deviations; an AI moderator is declared to the respondent | Session notes |

**Weights.** If responders differ from the frame on a known variable, you may weight to the frame, but only using a rule written in the record *before* analysis. Weighting repairs *known* imbalances; it cannot repair people who differ in ways we cannot see. If you do not weight, say "these results describe respondents, not all customers".

## 5. Question wording

### 5.1 Rules

1. **One idea per question.** "How satisfied are you with the speed and accuracy of dispatch?" is two questions.
2. **Neutral stem.** No adjectives that signal the right answer. Not "How much do you love the new schedule?" but "How did the new schedule change your day, if at all?"
3. **Offer the opposite and the exit.** Balanced options ("easier / no different / harder") plus *Not applicable* and *I don't know / prefer not to say* where honest.
4. **Behaviour before opinion.** "The last time a customer called outside hours, what happened?" beats "How important is after-hours answering?" Importance scales say "everything" for everything.
5. **Anchored time.** "In the last 7 days" or "On your last job". Never "regularly", "often" or "usually" without defining it.
6. **Their words.** Use the vocabulary customers use ("callback", "truck stock", "no-show"), not ours ("agent run", "governance"). Never use a product feature name as if everyone knows it.
7. **No hidden assumptions.** "What stops you using the dispatch board?" assumes they could use it. Ask first whether they have seen it.
8. **Exact numbers over adjectives.** "How many technicians do you have?" with ranges that do not overlap (1, 2–5, 6–15, 16–50, 51+), not "small/medium/large".
9. **Open text for discovery, closed for counting.** Ask one open question at the end ("What is the one thing we should fix first?") and code it with two coders who agree on the codebook before comparing.
10. **Never ask what you will not use.** No "name", "phone" or "company" unless the survey needs a follow-up and the respondent agrees to be contacted *separately*.

### 5.2 Examples (illustrative, not tested)

| Avoid | Why | Prefer |
|---|---|---|
| "Don't you agree that missed calls cost you money?" | Leading, agree-biased | "On your last missed call, what happened to that customer? (They called back later / booked elsewhere / I don't know)" |
| "How satisfied are you with Vireek?" | Vague, no behaviour, courtesy bias | "In the last 7 days, did Vireek save you a task you would otherwise have done by hand? (Yes, which one / No / Not sure)" |
| "Would you pay $49 a month for a better scheduler?" | Hypothetical, anchors the price | Do not ask. Use observed behaviour (plan upgrades) or a separate, labelled pricing study; say stated willingness to pay is weak evidence |
| "Do you use mobile and desktop?" | Double-barrelled | One question per device, with last-used time |
| "How often do you review quotes? (Never / Sometimes / Often / Always)" | Undefined frequencies | "How many quotes did you review before sending in the last 7 days? (0 / 1–5 / 6–20 / 21+)" |

### 5.3 Scales

Use at most five labelled points; label every point in words, not only the ends. Keep the direction the same across the survey. Include a neutral midpoint only if "neither" is a real answer. Do not average ordinal scales into a decimal and quote it as a precise score; report the share in each option.

### 5.4 Length and layout

Aim for under five minutes on a phone; the target is our own rule, not an external standard, and the pilot (§6.4) should check it. One question per screen on mobile. Test the layout in RTL (`ar`, `fa`) as well as LTR. Show progress honestly. Allow resume.

## 6. Build and test the instrument

1. **Draft** from the decision (§1); cut anything that will not change what we do.
2. **Expert read** by someone who did not write it, looking for leading wording, double-barrelled items and jargon.
3. **Cognitive pretest:** ask at least five people from the target population to think aloud while answering, and stop only when sessions stop turning up new problems. Record changes.
4. **Pilot** with a small random slice (outside the final sample). Check: completion rate, time to complete, items with high "don't know", drop-off by question, how options were used. Fix, then freeze the instrument. The pilot also gives a first real response rate.
5. **Freeze and version** the instrument (verbatim text, options, order, logic) in the survey record. Never edit wording mid-field. If you must, start a new version and report the two separately.

## 7. Privacy and ethics

- **Collect the minimum.** Pseudonymous response IDs; no names, phone numbers or addresses in the repository, in a decision record or in a spreadsheet shared by chat. Link to an account only when the analysis needs it and the respondent agreed.
- **Consent first,** using wording cleared by counsel **[COUNSEL]**: who we are, why, how long, that taking part is voluntary and has no effect on service or price, who sees answers, how long they are kept, how to withdraw.
- **Lawful contact** for email/SMS invitations, marketing-versus-research classification, and per-country rules is a legal question **[COUNSEL]**; this file does not decide it.
- **No sales through a survey.** A "survey" that ends in a pitch is a sales call and erodes trust in every later survey.
- **Technicians and employees** answer voluntarily and independently of the employer, who receives only aggregates with enough respondents to prevent identifying anyone (do not publish a cell below 5 respondents).
- **Raw data** lives in the access-controlled store named in the research protocol, not in the repository. Retention and location are confirmed by counsel **[COUNSEL]**.
- **AI use.** If a language model summarises open-text answers, say so in the record, keep the original text as the source of truth, and have a person check a sample of the coded output. Do not send identifiable responses to an unapproved processor; check the sub-processor register first **[VERIFY]**.

## 8. Analysis and reporting

- **Report the denominator every time:** invited, eligible, completed, response rate, field dates, channel, language, and the exact question text.
- **Show intervals** (§3.3), not just percentages. Say "about a third (6 of 20)", not "33%".
- **Subgroups:** only those named in advance; none below n = 30 as a percentage; say how many comparisons were made, since the more you slice, the more false patterns appear.
- **No causal language** ("because", "drives", "leads to") from a cross-sectional survey.
- **Disconfirming evidence stays in.** If a result contradicts the hypothesis, it goes in the record with the same prominence.
- **Cite behaviour data next to stated answers** where it exists. If they disagree, report both and prefer behaviour.

### How a result maps to a decision's confidence (internal rubric, not an external standard)

| What the survey is | Reasonable `confidence:` in the ADR |
|---|---|
| Probability sample, response rate known and responders compared with the frame, interval does not straddle the decision threshold | `medium` to `high` |
| Probability sample, but low or unknown response rate, or the interval straddles the threshold | `low` to `medium` |
| Purposive, volunteer or in-app sample | `low`; the evidence supports a hypothesis, not a share |
| Fewer than 30 responses in the group that matters | `low`; cite counts, not percentages |

## 9. Survey record (copy one per survey into `docs/research/surveys/YYYY-MM-short-name.md`)

```markdown
# SV-<YYYY>-<nn> — <short, neutral title>

- **Status:** designed | piloted | in field | closed | analysed
- **Decision it feeds:** <ADR id or "none yet">
- **Result that would change the decision:** <written before fieldwork>
- **Instrument version:** v1 (verbatim text attached below)

## Population and frame
- Unit: <account owner | dispatcher | ...>
- Frame source and date: <...>   Frame size N: <...>
- Known gaps in the frame: <...>
- Exclusions: <...>

## Sampling
- Design: <census | simple random | stratified random | purposive>
- Strata and allocation: <...>
- Seed: <...>   Invited (per stratum): <...>
- Responses needed and why: <formula inputs>

## Fieldwork
- Dates: <...>   Channels: <...>   Languages: <...>   Incentive: <none | ...>
- Invitation + reminders: <how many, when>
- Consent text version: <...> [COUNSEL]

## Bias register
| Bias | Not applicable / mitigated / present and reported | Note |
|---|---|---|
| Coverage | | |
| Non-response | | |
| Self-selection | | |
| Survivorship | | |
| Power asymmetry / courtesy | | |
| Social desirability | | |
| Acquiescence | | |
| Order and anchoring | | |
| Recall | | |
| Hypothetical | | |
| Translation / format | | |
| Low-quality responses | | |
| Incentive | | |

## Results
- Completed / eligible invited / response rate: <...>
- Responders vs. frame: <table>
- Key results with 95% intervals: <...>
- Subgroups pre-declared: <...>

## Limits and what this does not show
<plain statement>

## Instrument (verbatim)
<question text, options, order, logic, language versions>
```

## 10. Checklist before fielding

- [ ] The decision, the threshold and the planned action for each outcome are written down
- [ ] Unit, frame, frame gaps and exclusions are written down
- [ ] Sample drawn with a recorded seed; invited list stored outside the repository
- [ ] Sample size calculated and invitations planned from an expected response rate (or a pilot rate)
- [ ] Every question passes the wording rules in §5.1; no hypothetical price or intent questions used as proof
- [ ] Expert read, cognitive pretest and pilot done; instrument frozen and versioned
- [ ] Persian/Arabic versions back-translated and checked in RTL on a phone
- [ ] Consent wording cleared **[COUNSEL]**; lawful-contact basis cleared **[COUNSEL]**
- [ ] No personal data in the repository; data store and retention confirmed
- [ ] Analysis plan (denominators, intervals, subgroups, weights) written before results are seen

## 11. Change log

| Date | Change |
|---|---|
| 2026-11-20 | First version: method only, no survey run. |
