# Talent Network — ratings: reports, moderation and removal

Status: **draft for legal review.** Every item tagged **[COUNSEL]** needs a lawyer's decision before launch. Nothing here is a legal opinion, and no compliance claim is made. Items tagged **[VERIFY]** are facts about vendors or law that were not checked.

Implementation: `supabase/migrations/20290307000000_talent_ratings_moderation.sql` · staff page `/staff/rating-disputes` · tests `src/lib/talentRatingModeration*.test.ts`, `supabase/tests/database/talent_ratings_moderation.test.sql`.

## 1. What the system does

1. After an engagement ends, each side may rate the other once. Ratings stay double-blind: a side sees the other's rating when it has submitted its own, or 14 days after completion. This is unchanged.
2. The party a rating is **about** (the *ratee*) can report it once it is visible to them. The system refuses reports on hidden ratings and uses the same message as "no such rating", so a report can never confirm that a hidden rating exists.
3. A Vireek staff member claims the report and records one decision with a reason code and a written note:
   - **keep** — nothing changes;
   - **redact comment** — the comment is cleared, stars and tags still count;
   - **remove** — the rating stops counting and stops being shown.
4. Every step is written to an append-only log. The reporter is told the outcome; the rater is told only when a rating was removed or its comment cleared. Neither is shown the other's explanation or the moderator's note.
5. A staff member who is the reporter, the rater, the worker, or a member of the business account cannot claim or decide the case.

## 2. Removal rules (what the code enforces)

A rating, or its comment, can be removed only for one of these reasons:

| Code | Meaning |
|---|---|
| `harassment_or_hate` | threats, harassment or hateful content |
| `discriminatory` | discriminatory content |
| `personal_information` | personal information, for example a phone number |
| `not_about_engagement` | the content is not about this engagement |
| `fake_or_retaliatory` | fake rating, or retaliation for a dispute or an adverse action |
| `legal_obligation` | removal required by law or a valid legal request |

Not grounds for removal: a low score, disagreeing with the score, or a rating that is unflattering but about the engagement. A report reason of `false_statement_of_fact` or `other` can be filed, but ends in "keep" unless the moderator finds one of the grounds above.

Consequences, as built:

- A removed rating is excluded from reputation averages and counts.
- It still counts as *submitted* for the reveal rule, so removal never re-hides or newly reveals the other side's rating.
- The rater cannot submit a replacement (one rating per engagement and direction). This prevents a remove-and-retaliate loop.
- A rating under review keeps counting until decided.
- A reporter may withdraw an open or in-review report; the rating returns to normal.
- Limits: 5 reports open at once and 10 per 30 days per person.

## 3. Open policy questions

1. **[COUNSEL]** Is "factual falsity" a removal ground? Today it is not. Platform liability, defamation exposure and the position that a rating is opinion vary by jurisdiction.
2. **[COUNSEL]** Should ratings under review stay visible and counted, or be hidden while pending? Today: visible and counted.
3. **[COUNSEL]** Effect of ratings on gig access, and whether any automatic consequence of a low rating needs notice or an appeal. Today ratings are shown to counterparties and have no automatic consequence.
4. **[COUNSEL]** Is a moderator decision itself an automated decision or a "decision with legal or similarly significant effect" under privacy law (for example GDPR art. 22)? A human decides every case today. **[VERIFY]** applicability by region.
5. **[COUNSEL]** Statement of reasons and appeal: should the reporter or rater get a written reason, or a second-level review? Today: outcome only, no appeal.
6. **[COUNSEL]** Retention of the moderation log and the reporter's explanation, and how they are handled when a worker deletes their profile. Today the log survives profile deletion with identifiers only.
7. **[COUNSEL]** Handling of valid legal requests (court order, regulator, defamation notice) and who may record a `legal_obligation` removal.
8. **[COUNSEL]** Whether platform terms must disclose this process to both sides before they rate; wording of the user-facing explanations in `ratingModeration` locale files.
9. **[COUNSEL]** Review-time target (SLA). None is enforced today; the queue is ordered oldest first.
10. **[COUNSEL]** Consumer-review rules for reviews of businesses (for example fake-review and review-suppression rules). **[VERIFY]** which apply to worker-to-business ratings.

## 4. Operations

- Grant access by setting `profiles.is_staff`. There is no separate moderator role yet.
- Review the queue at `/staff/rating-disputes`. Do not copy personal information into decision notes.
- The log has no client access. Read it only through the staff page or with service-role access.
- Rolling back the migration destroys the moderation history. See the header of the migration.
