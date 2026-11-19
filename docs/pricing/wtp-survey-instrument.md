# WTP survey instrument (Van Westendorp), tool-neutral

Status: **template, not fielded, no responses.** Paste into any survey tool. Text in `[SQUARE BRACKETS]`
is filled by the study owner; nothing in brackets is a Vireek fact. Design rules and reasons:
[`wtp-study.md`](wtp-study.md); proposed settings: [`wtp-study-plan.md`](wtp-study-plan.md).

## Page 1: introduction and consent

`[CONSENT AND PRIVACY TEXT]` **[COUNSEL]**. Not drafted here. It must cover who runs the study, what is
collected, why, retention, who can see it, how to withdraw, and any incentive.

## Page 2: screener

End the survey politely, without revealing the target, when a respondent fails any screener item.

| # | Question | Purpose |
|---|---|---|
| S1 | Which best describes your role in choosing software or services for your business? `[OPTIONS]` | Keep decision makers and co-decision makers |
| S2 | Which best describes your business? `[TRADE OPTIONS]` | Quota and description |
| S3 | How many people use or would use this kind of tool in your business? `[SEAT BANDS]` | Segment: size |
| S4 | About how many customer calls does your business receive per month? `[CALL VOLUME BANDS]` | Segment: call volume |
| S5 | Do you currently use `[PRODUCT NAME]`? Yes / No / Not sure | Segment: customer status (anchoring). Ask here, before any price |

Do not ask what the respondent currently pays for anything on this page or before the price questions.

## Page 3: offer description (stimulus)

`[OFFER DESCRIPTION]`: one neutral paragraph, identical for everyone. State what it does, what is
included (minutes, seats, locations), what is not, and the billing unit and period. Allowed: facts.
Not allowed: any price, discount, "from", competitor, comparison, example number or superlative.

## Page 4: price questions

Show the offer description again at the top of this page. Four numeric fields on one page, in this fixed
order, each labelled with the currency and billing unit (`[CURRENCY]` per `[BILLING UNIT]`). Digits and one
decimal mark only; show the expected format under the field.

| Order | Export column | Question |
|---|---|---|
| 1 | `too_cheap` | At what price would you consider it so cheap that you would doubt its quality? |
| 2 | `cheap` | At what price would you consider it a bargain, a great buy for the money? |
| 3 | `expensive` | At what price would you start to think it is getting expensive, but still consider buying it? |
| 4 | `too_expensive` | At what price would you consider it too expensive to consider buying it? |

Required fields; no default value and no placeholder digits in the fields. Wording and translation to be
checked in the pilot **[VERIFY]**. Decide once whether an out-of-order answer triggers a soft prompt, and
record the decision.

## Page 5: optional background

Ask only what the analysis uses. Anything about current spending goes here, after the price questions.
Collect no names or contact details in this survey; if a follow-up is wanted, use a separate form.

## Export checklist

- One row per respondent; opaque `respondent_id`; one `segment` value per analysis dimension, or one
  column per dimension (run the analysis once per column with `--segment-column`).
- Price columns as numbers in one currency. Note the tool's decimal and thousands marks for `--decimal`
  and `--thousands`, and any currency symbols for `--strip`.
- Exclude disqualified and incomplete respondents, and apply the declared speeder rule, before export.
- Keep personal data out of the exported file; the normalizer drops every unmapped column as a second
  safeguard.
