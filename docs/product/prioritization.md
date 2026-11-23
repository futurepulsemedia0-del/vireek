# Prioritization framework

How Vireek decides what to build next, who decides, and how ties are broken. The model is deliberately small: four numbers per item, one formula, one ordering rule. A ranked list is an input to a decision, not the decision.

- Scoring template: [`prioritization-template.csv`](prioritization-template.csv)
- Ranker: [`scripts/product/prioritize.mjs`](../../scripts/product/prioritize.mjs) (tests: `scripts/product/prioritize.test.mjs`)
- Related: [`lifecycle-policy.md`](lifecycle-policy.md) (removing things), [`../OWNERS.md`](../OWNERS.md) (area owners)

## 1. Scope

Applies to any candidate piece of product or platform work that needs more than about one person-week: features, integrations, reliability and tooling work, deprecations. Bugs that are plainly broken behaviour go to the normal bug flow; tiny fixes (under half a person-week) are not scored.

## 2. The model

```
score = reach x impact x (confidence / 100) / effort
```

Higher is better. The score answers "how much value per unit of effort, discounted by how sure we are". It does not answer "is this strategically right", which is why items that must happen regardless go through gates (section 4) and why a human decides (section 6).

### 2.1 Reach: accounts affected in the next 90 days

A whole number, 0 to 999,999,999. Count **accounts** (tenants), not users or calls, so that a feature used by one large account all day does not outrank one used by fifty small accounts once. Use measured counts where they exist (usage events, ticket tags, the account list); otherwise state the source in `evidence`. For a feature nobody has yet, count the accounts that meet the stated eligibility today, not hoped-for sign-ups.

### 2.2 Impact: how much it moves each affected account

One of a fixed scale. The scale is discrete on purpose: finer values only add false precision.

| Value | Label | Meaning for an affected account |
|---:|---|---|
| 3 | Massive | Changes whether they keep or buy Vireek (retention, revenue or a core job they cannot do today) |
| 2 | High | Clearly improves a core workflow they use weekly |
| 1 | Medium | Noticeable improvement to something they use regularly |
| 0.5 | Low | Small improvement or convenience |
| 0.25 | Minimal | Barely noticeable; polish |

Impact is about the customer outcome, not about how hard the work is or how exciting it is to build.

### 2.3 Confidence: how sure we are about reach and impact

Exactly one of three tiers. Anything below 50 is not a low score, it is a signal to do discovery first and score afterwards.

| Tier | Meaning | `evidence` column |
|---:|---|---|
| 100% | Reach and impact come from measured data or a shipped comparable | required |
| 80% | Strong qualitative evidence: repeated customer requests, interviews, a working prototype | required |
| 50% | A reasoned estimate with little direct evidence | optional |

The ranker rejects 80 and 100 without evidence. A link or one line naming the source is enough; the point is that someone can check it.

### 2.4 Effort: person-weeks, all-in

Total person-weeks across engineering, design, QA, documentation, migration and rollout, in steps of 0.5 (the ranker rejects other values). One person-week is one person working full time for a week. Include the work that follows the launch decision: monitoring, support enablement, and, for removals, the communication and data-export steps in the lifecycle policy. The engineering lead owns the number (section 6); it is an estimate with a stated confidence, not a promise.

### 2.5 Worked example (illustrative figures)

`reach 300, impact 1, confidence 80, effort 3` gives `300 x 1 x 0.8 / 3 = 80`. The ranker uses exact integer arithmetic, so two items that are mathematically equal are always recognised as a tie and never separated by rounding noise.

## 3. Using the ranker

```bash
cp docs/product/prioritization-template.csv backlog.csv   # fill it in, delete the EXAMPLE rows
node scripts/product/prioritize.mjs backlog.csv            # ranked table
node scripts/product/prioritize.mjs backlog.csv --format md --top 10
node scripts/product/prioritize.mjs backlog.csv --strict   # warnings fail too (use before a planning meeting)
```

Columns: `id, title, owner, reach, impact, confidence, effort` are required; `gate, evidence, scored_on, notes` are optional (order is free, header case is ignored). `--format` is `table` (default), `md`, `csv` or `json`. Exit code 0 means ranked, 1 means the data is invalid (every problem is listed with its line number, nothing is ranked), 2 means a usage error.

Warnings (not errors, unless `--strict`): a missing `scored_on`, a score older than 90 days (`--stale-days` to change), a leftover `EXAMPLE-` row, reach 0, an unknown column. Do not commit a backlog CSV that contains customer names or personal data; keep identifiers and titles generic.

## 4. Gated items

Some work is not a trade-off. If the `gate` column is anything other than empty or `none`, the item is placed in a **gated block** that is listed before every scored item. Gated items are still scored, but only to order them against each other and to show their opportunity cost.

| Gate | Use only when |
|---|---|
| `security` | The security owner confirms the work addresses a vulnerability, exposure or required control |
| `legal` | Counsel confirms a legal or regulatory obligation. Vireek staff do not classify items as legal on their own: [COUNSEL] |
| `data_loss` | Customer data is being lost, corrupted or exposed, or is at material risk of it |
| `commitment` | A written commitment to a customer or partner, or a published date, requires it |

A gate needs a named approver (section 6) and a one-line justification in `notes`. Abusing a gate to skip scoring is a process failure: the monthly review (section 7) lists every gated item and who approved it.

## 5. Tie-break rules

Applied in this order, within the gated block and within the scored block. The first rule that separates two items decides; the ranker prints which one (`tie` column).

1. Higher **score**.
2. Higher **confidence** (a sure 20 beats a hopeful 20).
3. Lower **effort** (the smaller item ships sooner and frees capacity).
4. Higher **reach**.
5. **id**, in natural order (`item-2` before `item-10`, case-insensitive). This only makes the output reproducible; if two items reach this rule, the product owner may reorder them and must record why.

Identical inputs always produce identical output, whatever order the rows are in.

## 6. Decision rights

Roles, not people. Map each role to a named person in [`../OWNERS.md`](../OWNERS.md); until an area owner is assigned there, the founders hold that role. [VERIFY: this fallback is an assumption, confirm it.]

D = decides, V = may veto (stops the item; must give a written reason), C = must be consulted before the decision, I = informed after.

| Decision | Product owner | Engineering lead | Design lead | Security owner | Support lead | Billing / finance | Founders / exec |
|---|---|---|---|---|---|---|---|
| Reach and impact values for an item | D | C | C | | C | | |
| Confidence tier (and judging the evidence) | D | C | | | | | |
| Effort estimate | C | D | C | | | | |
| Approve a gate: `security` | | C | | D | | | I |
| Approve a gate: `legal` ([COUNSEL]) | C | C | | C | | | D, after counsel |
| Approve a gate: `data_loss` | C | D | | C | I | | I |
| Approve a gate: `commitment` | C | C | | | C | C | D |
| Ranked order for the next period | D | C | C | C | C | C | V |
| Deviate from the ranked order (exception) | D | C | | | | | D (second approver) |
| Change the model, scales or this document | D | C | C | | | | D |
| Start a deprecation (see lifecycle policy) | D | C | | C | C | C | I |

Rules that go with the table:

- **Exceptions.** Moving an item above its rank needs the product owner and one founder to sign off, with a one-sentence reason in `notes`. Exceptions are reviewed monthly; if more than one in four of the period's items were exceptions, the inputs or the model are wrong and get fixed instead.
- **No self-scoring in isolation.** The person proposing an item may draft reach and impact, but the product owner sets them and the engineering lead sets effort.
- **Disagreement.** If the roles that must be consulted disagree on an input, the role marked D decides and the disagreement is recorded in `notes`. If the D role is the proposer, a founder decides.
- **Conflicts of interest.** A person who benefits directly from an item (for example a bonus tied to it) does not decide its inputs.

## 7. Cadence and hygiene

- **Re-score** an item when its evidence changes materially, and in any case every 90 days. `scored_on` makes stale scores visible.
- **Monthly review (30 minutes):** the ranked list, every gated item with its approver, every exception, and items that have been in the list for two periods without being started.
- **Retrospective check, quarterly:** for items shipped that quarter, compare actual reach, impact and effort with what was scored. If estimates are consistently off in one direction, adjust the guidance in this document, not the individual numbers.
- **Capacity** is outside the model. Decide the period's capacity first, then take items down the ranking until it is used.

## 8. Known limits

- The score compares items on one axis. Strategic bets, dependencies between items and portfolio balance (growth versus reliability versus debt) are judged by the humans in section 6.
- Accounts are the unit of reach. Work that matters to few accounts but decides the largest deals is where `commitment` gates and exceptions exist, and where judgment overrides the arithmetic.
- Impact values are judgments. The discrete scale and the evidence requirement constrain them; they do not make them objective.
- Effort estimates are usually optimistic. The quarterly check in section 7 is how that is corrected.

## 9. Scoring template (one item)

Copy into the item's ticket or write it as a CSV row. Fields map one to one to the CSV columns.

```
id:           short stable id, e.g. dash-142
title:        one line, what changes for the customer
owner:        who proposes and follows the item
reach:        accounts affected in the next 90 days:            ____   source: ____
impact:       3 / 2 / 1 / 0.5 / 0.25:                           ____   why: ____
confidence:   100 / 80 / 50:                                    ____
evidence:     link or one line (required at 80 and 100):        ____
effort:       person-weeks, steps of 0.5, all-in:               ____   by: engineering lead
gate:         none / security / legal / data_loss / commitment: ____   approver + reason: ____
scored_on:    YYYY-MM-DD
notes:        exceptions, disagreements, assumptions
```

Before submitting: Is reach a count of accounts rather than a hope? Could someone else check the evidence? Does effort include rollout, monitoring and, for removals, communication and export?
