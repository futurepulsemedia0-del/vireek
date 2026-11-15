# Win/loss interview guide

Owner: sales lead. Audience: whoever runs buyer interviews and records deals.
Status: DRAFT process. Nothing here is legal advice; items marked **[COUNSEL]** need review by qualified counsel
before use, and **[VERIFY]** items are assumptions to confirm.

Where the data goes: `/staff/win-loss` (Vireek staff only). Schema: `supabase/migrations/20290305000000_win_loss_records.sql`.

## 1. Purpose

Learn, from the buyer's own words, why a deal was won, lost or left undecided, so product, pricing and
positioning decisions rest on counted evidence. Interviews are research, not a second sales attempt.

## 2. What to record, and when

Record **every** closed deal within 5 business days of the decision, including wins and "no decision". Recording only
losses makes the data biased. Fields:

| Field | Rule |
|---|---|
| Deal | Company/opportunity name. No individuals' names, emails or phone numbers. |
| Outcome | `won`, `lost`, or `no_decision` (the buyer chose to do nothing / delayed past the review window). |
| Competitor | Who or what won it. Use `status quo` when no vendor was chosen. **Required for lost deals.** |
| Reasons | 1-5 from the fixed list below for won/lost. Use the buyer's stated reasons, not our assumptions. |
| Notes | Facts and short buyer quotes. No personal data, no secrets, no speculation about individuals. |
| Closed on | The date the decision was communicated. |
| Deal value | Optional, USD. |
| Interview | `not_requested`, `requested`, `completed`, `declined`. |

Reasons vocabulary (kept in sync with the database constraint): price; features / product fit; voice and call quality;
integrations; trust and compliance; onboarding effort; support; brand awareness; timing or budget; internal champion
left; status quo / do nothing; other. If "other" appears in many records, propose a new reason (it needs a migration and a
change to `src/lib/winLoss.ts`) rather than describing it in notes.

## 3. Who to interview

- Prefer the economic decision-maker, then the day-to-day evaluator. Avoid interviewing only your own champion.
- Aim for the sales rep **not** to be the interviewer (buyers are more candid with someone who is not selling).
- Do not interview people who asked not to be contacted, who are on a do-not-contact list, or who are in an
  active dispute with us.
- Target: ask everyone once; do not chase. One reminder at most. Record `declined` and move on.

## 4. Consent, recording and privacy  **[COUNSEL]**

- **[COUNSEL]** Decide whether interviews may be audio-recorded. Recording-consent rules differ by jurisdiction and the
  buyer's location may differ from ours. Until counsel decides, take handwritten/typed notes only and do not record.
- Tell the buyer at the start: why you are asking, that participation is voluntary, how their answers will be used
  (internal product and sales decisions), and that you will not quote them externally by name or company without
  written permission.
- **[COUNSEL]** Confirm the retention period for interview notes and what happens on a deletion request. The
  `win_loss_records` table is internal sales data and is not part of tenant data-subject tooling, so keep personal data out of it.
- Never offer an incentive that could be read as payment for a favourable answer. **[COUNSEL]** for any gift card or discount.
- Competitor information: record what the buyer volunteers. Do not ask buyers to share confidential competitor
  documents or pricing under NDA. **[COUNSEL]** if a buyer offers one.

## 5. Interview script (20-30 minutes)

Open: thank them; state the purpose and the consent points in section 4; confirm they are happy to continue.

1. **Context.** "What was happening in the business that made you look at a solution like this?"
2. **Alternatives.** "Which options did you look at, including doing nothing or a spreadsheet?"
3. **Criteria.** "What did you need most? How would you rank those needs?" (Let them rank; do not read our list.)
4. **Decision.** "Walk me through how the decision was made and who was involved."
5. **The deciding moment.** "What was the single thing that tipped it?"
6. **Our product.** "Where did we do well? Where did we fall short? Was there anything you expected to see and did not?"
7. **The voice agent specifically.** "How did the call quality and the AI receptionist compare to what you expected?
   Was there any concern about customers talking to an AI?"
8. **Price and terms.** "How did our pricing compare to the value you saw? Did any terms or contract length matter?"
9. **Trust.** "What would you have needed to see to feel fully confident?"
10. **Close.** "If you could change one thing about how we handled the process, what would it be?" Then thank them.

Technique: ask open questions; follow "why" with "tell me more"; stay silent after answers; never defend, correct or re-pitch.
If the buyer asks to be sold to, say you will pass it to the team and end the interview.

## 6. After the interview

1. Within 24 hours, record the deal at `/staff/win-loss`. Choose reasons the buyer stated. If the buyer gave more
   than five, choose the five that mattered most to them.
2. Put short, factual notes and at most one or two brief quotes. No names of individuals.
3. Set the interview status. Use `declined` only if they said no.
4. A single deal never changes strategy. Look at patterns only when a group has enough deals (see 7).

## 7. Reading the summary

- Win rate = won ÷ (won + lost). "No decision" is reported separately and excluded.
- The page flags any group with fewer than 5 decided deals as low-sample. Treat those as leads for questions, not conclusions.
- A deal counts once under **each** of its reasons, so reason rows do not sum to the total.
- Competitor names are grouped case-insensitively after trimming. Spelling variants ("Service Titan" vs "ServiceTitan")
  are **not** merged: agree one spelling.
- The numbers describe the deals recorded. They are not a market-wide win rate. Selection bias remains because
  reasons are self-reported by buyers who agreed to talk **[VERIFY: review quarterly]**.

## 8. Cadence

- Weekly: sales lead checks that all closed deals in the last 7 days are recorded.
- Quarterly: review the quarter view and the top reasons with product and marketing; note any decision taken and why.
- Review this guide yearly, or when the reason list changes.
