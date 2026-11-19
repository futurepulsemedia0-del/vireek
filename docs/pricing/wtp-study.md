# Willingness-to-pay study kit (Van Westendorp price sensitivity meter)

Status: **method and tooling only; NO result exists.** Nothing in this document or in the repository
states what Vireek should charge, what customers will pay, or what any segment prefers. The only data in
the repo is a clearly labeled fake file used to test the script
([`van-westendorp.synthetic-fake.csv`](../../scripts/pricing/fixtures/van-westendorp.synthetic-fake.csv)).
Any number that appears later comes from a real survey run through the script, and must be read with the
limits in section 8.

Companion documents: [`wtp-study-plan.md`](wtp-study-plan.md) (proposed defaults for section 2, pending owner
approval) and [`wtp-survey-instrument.md`](wtp-survey-instrument.md) (tool-neutral questionnaire).

Nothing here changes billing, entitlements, plans or any customer-facing page. Public pricing claims stay
governed by `npm run pricing:check` and the claims registry
([`PUBLIC_CLAIMS_INVENTORY.md`](../compliance/PUBLIC_CLAIMS_INVENTORY.md)).

Items marked **[COUNSEL]** need legal review before use. Items marked **[VERIFY]** are conventions or
rules of thumb from general survey practice that were not checked against a source while writing this and
must be confirmed by whoever runs the study. Placeholders in `[SQUARE BRACKETS]` are decisions the study
owner has to make; they are deliberately left blank.

## 1. What this study can and cannot tell you

The Van Westendorp price sensitivity meter (PSM) asks each respondent four price questions about one
described offer. The answers give a **range of prices that respondents consider acceptable** and a few
reference points inside it.

It can inform: where the sample starts to see the offer as suspiciously cheap, where it starts to see it
as expensive, and how those thresholds differ between groups.

It does not give: a demand curve, expected conversion or revenue, an optimal price, price elasticity,
willingness to pay for individual features, or any comparison with competitors. It ignores cost and
margin. It measures stated, hypothetical opinions, which usually differ from real purchase behavior.
Treat the output as one input next to cost data, competitor prices and real conversion evidence (for
example, controlled price tests on live traffic, which are a separate project).

## 2. Decide before collecting data

Write these down and freeze them before the first response arrives. Changing them after seeing data turns
the study into confirmation of whatever you already believed.

| Decision | Owner fills in |
|---|---|
| The single decision this study informs (for example "choose the price range to test in an experiment") and what you would do differently for each plausible outcome | `[DECISION]` |
| Offer being priced, exactly as it will be described to respondents | `[OFFER DESCRIPTION]` |
| Billing unit and period shown to respondents (per month, per user, per location, annual) | `[BILLING UNIT]` |
| Currency, one per survey wave. Never pool currencies in one file | `[CURRENCY]` |
| Target population and screening rules (section 4) | `[POPULATION]` |
| Segments to analyse and the minimum valid responses per segment (section 5) | `[SEGMENTS, MIN N]` |
| Exclusion rules (section 4.4) and how excluded rows are reported | `[EXCLUSION RULES]` |
| Analysis settings: `--min-n`, `--bootstrap`, `--seed`, `--strict-order`, `--exclude-straight-lining` | `[ANALYSIS FLAGS]` |
| Who reviews the result and who may approve using it in a pricing decision | `[REVIEWERS]` |

## 3. Survey design

### 3.1 Stimulus

- Show one neutral description of the offer, identical for every respondent: what it does, what is
  included, what is not, the billing unit and period. No price, no discount, no "from", no competitor
  names, no marketing superlatives.
- Do not show the current price list, a competitor price or a number in an example. Any number shown acts
  as an anchor and shifts the answers.
- If you want to compare two offers (for example two packages), run separate samples or a separate wave
  per offer. Asking the same person about several offers with four questions each is tiring and the later
  answers are contaminated by the earlier ones.

### 3.2 The four questions

Standard wording, to be adapted to the billing unit and translated carefully **[VERIFY]**:

| CSV column | Question |
|---|---|
| `too_cheap` | At what price would you consider it so cheap that you would doubt its quality? |
| `cheap` | At what price would you consider it a bargain, a great buy for the money? |
| `expensive` | At what price would you start to think it is getting expensive, but still consider buying it? |
| `too_expensive` | At what price would you consider it too expensive to consider buying it? |

Rules:

- Use numeric entry (or a slider with a visible numeric value), not price brackets. Brackets change the
  analysis and hide the thresholds.
- Use the same question order for every respondent and keep the order in the study record. Whether to
  randomize or reverse the order is debated in the literature **[VERIFY]**; do not mix orders silently
  within one dataset. Pilot the chosen order first.
- State the billing unit and currency next to every input field.
- Locale: respondents may type a decimal comma. The script accepts only a dot as decimal separator and
  plain digits (no currency symbols, thousands separators or exponents) and excludes anything else, so
  normalize the export before analysis with `scripts/pricing/normalize-survey-export.mjs` (section 7.0) or
  restrict the input field to digits and one dot.
- Inline validation: a soft prompt when answers are out of logical order (`too_cheap <= cheap <=
  expensive <= too_expensive`) can reduce accidental errors, but it also nudges answers. Decide once,
  apply it to everyone and record that you did. Rows that still violate the order are excluded by the
  script and counted, never repaired.
- Do not add a fifth question about a "target" price in the same block.

### 3.3 Optional extras (not implemented by the script)

- Purchase-intent follow-up at a given price (the Newton-Miller-Smith extension of the PSM) **[VERIFY]**.
  Only add it if you will analyse it; it needs its own analysis code.
- Respondent traits needed to build segments (section 5) and a small number of screening questions.
  Ask about current spend on existing solutions only **after** the four price questions, because
  mentioning a number first anchors the answers.

### 3.4 Privacy, consent and incentives

- Collect the minimum personal data. The analysis needs only a respondent identifier, a segment value and
  four numbers. Keep contact details in a separate system, joined by an opaque identifier at most.
- Consent wording, the legal basis for contacting people, retention period, panel-provider contracts and
  incentive rules (taxes, gift and prize regulation, children excluded) **[COUNSEL]**.
- Inviting existing customers by email is marketing-adjacent in some jurisdictions **[COUNSEL]**.
- Results shared externally (investors, blog, sales material) are public claims and must not describe the
  study as proof of anything beyond what section 8 allows **[COUNSEL]**.

### 3.5 Pilot

Run 5 to 10 cognitive interviews (the respondent reads the survey aloud and explains each answer), then a
small soft launch. Check: do people understand the billing unit, do any use a different unit than you
intended, how long does it take (this sets the speeder threshold in section 4.4), how many orders are
violated, and whether any field is mis-parsed in the export. Fix the survey, then discard the pilot data
or label it clearly as pilot; do not pool it with the real sample.

## 4. Sampling

### 4.1 Define the population

Describe who you want to learn about in one sentence that a screener can test, for example "decision
makers or co-decision makers for buying software at `[TYPE OF BUSINESS]` with `[SIZE BAND]`". The study
answers for that population only. Vireek customers are a poor proxy for prospects, and prospects are a
poor proxy for people who will never evaluate you.

### 4.2 Recruitment sources and what each one biases

| Source | Typical bias | Use |
|---|---|---|
| Current customers | Already paid a price (anchoring), already self-selected as buyers, survivor bias | Separate segment, never pooled silently with prospects |
| Leads, waitlist, demo requests | Interested enough to engage, may expect a discount | Separate segment |
| Third-party panel | Professional respondents, weak screening, incentive-driven speed | Needs strong screening and quality checks |
| Communities, associations, social posts | Self-selection by enthusiasm; hard to reproduce | Exploratory only |
| Mixed sources | Composition drives the result | Record source per respondent and analyse by source |

Add a `segment` (or another column of your choice via `--segment-column`) that records source or
customer status whenever you mix sources, so differences are visible instead of averaged away.

### 4.3 Sample size

- The script refuses to compute a group with fewer than 10 valid respondents (`HARD_MIN_N`) because the
  curves are meaningless there, and warns below `--min-n` (default 100).
- The default of 100 per analysed group is a common practitioner rule of thumb, not a derived
  requirement **[VERIFY]**. Decide your own minimum from how precise the answer must be: run
  `--bootstrap 1000` on the pilot or on a prior wave and look at the width of the intervals. Wide
  intervals mean the sample cannot support the decision, whatever the point estimates look like.
- Every extra segment divides the sample. Fewer, pre-declared segments beat many exploratory ones.
- Plan for exclusions: recruit more than the target (the exclusion rate is known only after the pilot).

### 4.4 Data quality and exclusion rules

Declare these before fielding and apply them mechanically. The script applies the logical checks below
and reports every excluded row by reason; you apply the survey-process checks before export.

| Check | Applied by | Notes |
|---|---|---|
| Missing, non-numeric, negative or absurd price | Script (`missing_value`, `non_numeric`, `negative_value`, `out_of_range`) | Never imputed |
| Prices not in order `too_cheap <= cheap <= expensive <= too_expensive` | Script (`order_violation`) | `--strict-order` also rejects ties |
| Wrong number of columns | Script (`malformed_row`) | Usually an export bug; investigate before continuing |
| Repeated `respondent_id` | Script (`duplicate_respondent_id`) | First occurrence kept |
| Not in the target population | Survey screener | |
| Completion time far below the pilot median | Before export | Threshold from the pilot **[VERIFY]** |
| Identical price in all four fields | Script, only with `--exclude-straight-lining` (`straight_lining`) | Off by default so the choice is explicit; record whether you used it. Other straight-lining patterns (for example a fixed ratio between answers) are not detected and need a rule before export |
| Bots, repeat participants (device/email dedupe) | Before export | |

If more than 10% of rows are excluded the script prints a warning: find the cause (a confusing question,
a locale problem, a bad export) before trusting any number.

## 5. Segments

### 5.1 Choosing segments

Create a segment only if (a) you would act differently on a different answer (a different price or
package), (b) you can recognise the segment at the moment of sale, (c) you expect enough respondents in it
(section 4.3), and (d) you declared it before seeing results.

Candidate dimensions (adapt to Vireek's actual go-to-market; the list is a starting point, not a verified
description of the customer base **[VERIFY]**):

| Dimension | Example values | Caution |
|---|---|---|
| Trade or business type | `[TRADES]` | Keep the labels few and mutually exclusive |
| Business size | headcount or technician-count bands | Choose band edges before fielding |
| Inbound call or job volume | volume bands | Self-reported volume is noisy |
| Current solution | none, answering service, other software | Also relevant to anchoring |
| Respondent role | owner, office manager, other | Who actually decides |
| Customer status | current customer, lead, other | Section 4.2 |
| Region | `[REGIONS]` | A different currency means a different file, not a different segment |

### 5.2 Reading segment differences

- Compare segments through the bootstrap intervals (`--bootstrap`), not the point values alone.
  Overlapping intervals are not evidence of a difference; non-overlapping intervals are also not proof
  because many segment comparisons inflate false positives.
- A segment below the minimum prints a warning, and below 10 is not analysed at all. Do not merge it
  into another segment after seeing results to make a number appear.
- Segment values in the CSV are free text. Normalize spelling and case before analysis; `Plumbing` and
  `plumbing` are two segments to the script. Empty values become `(unspecified)`.

## 6. Data file format

One row per respondent, UTF-8, comma-separated, a header row, dot as decimal separator.

| Column | Required | Meaning |
|---|---|---|
| `too_cheap` | yes | Price answer, number in the survey currency |
| `cheap` | yes | Alias: `bargain` |
| `expensive` | yes | Alias: `getting_expensive` |
| `too_expensive` | yes | Price answer |
| `respondent_id` | no | Opaque id, used to detect duplicates (alias: `id`). No names or emails |
| `segment` | no | Segment label; another column can be chosen with `--segment-column` |

Header matching ignores case, spaces and hyphens. Lines beginning with `#` are comments. A comment that
contains the word SYNTHETIC or FAKE marks the file as test data: the script prints a banner, adds a
warning to the report and stamps every SVG chart.

Do not commit real survey exports to this repository. They contain personal data and belong in the
research system of record.

## 7. Running the analysis

Requires Node.js 18.3 or newer (`node:util` `parseArgs`); the repo's own checks need Node 22. No
dependencies and no network access.

```bash
# fake sample, text summary
node scripts/pricing/van-westendorp.mjs scripts/pricing/fixtures/van-westendorp.synthetic-fake.csv

# real file: intervals, reproducible seed, charts and tables in a folder, currency label
node scripts/pricing/van-westendorp.mjs survey.csv --bootstrap 1000 --seed 1 --currency EUR --out-dir out/wtp

# machine-readable report on stdout
node scripts/pricing/van-westendorp.mjs survey.csv --format json
```

Outputs with `--out-dir`: `van-westendorp.report.json` (everything, including the curves),
`van-westendorp.curves.csv` (one row per price point per group, for any spreadsheet or plotting tool) and
one SVG chart per group. The report records the SHA-256 of the input and the options used, so a result
can be traced to an exact file and settings. Writing happens only inside `--out-dir`. Progress messages go
to stderr so JSON on stdout stays clean.

### 7.0 Normalizing a survey-tool export

```bash
node scripts/pricing/normalize-survey-export.mjs export.csv \
  --map "Q1=too_cheap,Q2=cheap,Q3=expensive,Q4=too_expensive,ID=respondent_id,Group=segment" \
  --decimal comma --thousands dot --strip "EUR,€" --out clean.csv
```

The normalizer keeps only the mapped columns (everything else, which may hold personal data, is dropped),
renames them, and converts prices only when a cell matches the declared decimal and thousands marks
exactly. Anything else (for example `1.5` when the dot is declared a thousands mark) is left as it was
and the analysis excludes it as `non_numeric`; nothing is guessed. No row is dropped, short rows stay
visible as `malformed_row`, comment lines (including a SYNTHETIC marker) are kept, it refuses to write
over its input, and it refuses to replace an existing `--out` file without `--force`. A summary of
conversions goes to stderr.

### 7.1 Curves and points

All curves are shares of valid respondents on a grid made of every price that appears in the data.

| Curve | Share of respondents who ... |
|---|---|
| too cheap | gave a `too_cheap` price at or above the price on the axis (falls as price rises) |
| cheap | gave a `cheap` price at or above it (falls) |
| not cheap | 1 minus cheap (rises) |
| expensive | gave an `expensive` price at or below it (rises) |
| not expensive | 1 minus expensive (falls) |
| too expensive | gave a `too_expensive` price at or below it (rises) |

| Point | Intersection | Reads as |
|---|---|---|
| PMC, point of marginal cheapness | too cheap and not cheap | lower edge of the acceptable range |
| OPP, optimal price point | too cheap and too expensive | price with the least resistance in either direction |
| IPP, indifference price point | cheap and expensive | price where as many call it a bargain as call it expensive |
| PME, point of marginal expensiveness | not expensive and too expensive | upper edge of the acceptable range |

The labels "optimal" and "indifference" are historical names for these intersections. They are not
recommendations. Texts differ on which curves define PMC and PME; this script uses the pairs above
**[VERIFY]** against the reference your team follows. If the team prefers another pairing, change
`computePoints` and its hand-derived test together.

Crossings are found by linear interpolation between grid points. If two curves coincide over an interval
(common with small samples), the midpoint of that interval is reported. If curves do not cross inside the
observed price range the point is reported as `undefined`, never extrapolated. If PMC lands above PME the
range is withheld and a warning is printed.

### 7.2 Bootstrap intervals

With `--bootstrap N` the script resamples respondents with replacement N times, recomputes the four
points, and reports the 2.5th and 97.5th percentiles (percentile bootstrap) plus how many resamples
produced a defined point. The seed makes a run reproducible. The intervals show sampling noise only;
they say nothing about bias from who was recruited or from how the questions were understood.

## 8. Limits and how to report

Limitations to state with any result:

- Stated, hypothetical prices; people overstate and understate real behavior.
- The sample is not the market. Recruitment source, screening and incentives shape the answers.
- The answers depend on the stimulus text, the billing unit and the question order.
- Anchoring from anything shown before the price questions.
- No cost, margin, competitor, feature or elasticity information.
- Small groups give unstable points; wide bootstrap intervals are information, not a nuisance.

Minimum content of a report built from a real run (fill with real values only):

| Item | Value |
|---|---|
| Question the study informs and decision rule written beforehand | `[...]` |
| Field dates, recruitment sources, incentive | `[...]` |
| Offer text and billing unit shown | `[...]` |
| Rows received, valid, excluded by reason | from the script |
| Group sizes and warnings | from the script |
| PMC, OPP, IPP, PME with intervals per group | from the script |
| Deviations from the pre-declared plan | `[...]` |
| What was decided and by whom | `[...]` |

Never publish or quote the output of the synthetic fixture as an example result; it is random numbers.

## 9. Verification

| What | Command | Notes |
|---|---|---|
| Unit tests | `npx vitest run scripts/pricing` | Covers parsing, exclusions, hand-derived curves and points, plateau and undefined crossings, bootstrap determinism, rendering and the CLI. Also runs under plain `npm test` |
| Fake-data smoke run | `node scripts/pricing/van-westendorp.mjs scripts/pricing/fixtures/van-westendorp.synthetic-fake.csv --bootstrap 300 --min-n 20` | Prints the synthetic banner |
| Normalizer unit tests | `npx vitest run scripts/pricing` | Same command; covers mapping validation, every number format, refusal to guess, column dropping, comment preservation, file-safety rules and a round trip through the analysis |
| Doc links | `npm run docs:links` | |

The hand-derived test dataset in the test file is the specification for the crossing logic; the overall
points of the fake sample were also recomputed with a separate implementation while writing this kit.

## 10. Open items

- **[COUNSEL]** Consent text, legal basis and retention for the survey; panel and incentive terms;
  external use of any result.
- **[VERIFY]** PMC/PME curve pairing, question wording and order, the 100-respondent rule of thumb, the
  speeder threshold, and whether the Newton-Miller-Smith extension is wanted.
- Segment list, offer description, billing unit and sample targets are owner decisions (section 2).
- Not built: survey hosting, a respondent-quality scoring tool, the purchase-intent extension (its
  calibration conventions could not be verified while writing this kit), and any connection to billing or
  plan configuration.
