# Vireek channel and partner program

Tiers, requirements, certification, commissions, support service levels and the access scope partner users get in the portal.

Status labels used below:
- **Built**: exists in this repository (migration, code or constant) and is cited.
- **PROPOSED**: a starting point written for this document, not validated, not yet enforced by code.
- **[COUNSEL]**: needs a lawyer before it appears in a partner agreement or on a public page.
- **[VERIFY]**: a fact to check in the live system before it is promised.

Owners are **TBD**: the repository names none. Nothing here is a contract.

---

## 1. Tracks and tiers

The public `/partners` page offers three tracks: affiliate, reseller/white-label and customer referral. The portal database models two partner tiers (`partners.tier`: `affiliate`, `agency`). Reseller/white-label is handled by agreement, not by the portal. [VERIFY with the owner of the partner pages]

| | **Affiliate** | **Agency** | **Reseller / white-label** |
|---|---|---|---|
| Who | Individuals and publishers with an audience of home-service businesses | Marketing agencies, consultants and field-service software resellers who offer Vireek under their own relationship | Partners who rebrand or bundle Vireek |
| Portal tier | `affiliate` (Built) | `agency` (Built) | None. Contract only |
| Application | Portal, staff approval (Built) | Portal, staff approval (Built) | Direct conversation [COUNSEL] |
| Tracked link and click log | Built | Built | n/a |
| Commission | Up to **20%** of collected subscription revenue, for up to **12 months** per referral (Built, guardrails migration; limits are labelled proposed/unvalidated in the code) | Same ceiling. Legacy agency rows at 25% are grandfathered but flagged and clamped, never silently changed (Built) | By contract [COUNSEL] |
| Certification required | Not required to earn | **PROPOSED:** required before an agency can list itself as a Vireek Certified Partner | **PROPOSED:** required for every customer-facing person |
| Portal team access | Owner only | Owner plus up to 10 members (Built, see section 6) | Same as Agency |

Why only these tiers: the portal has no volume-based tiers and no tier above `agency`. Adding Silver/Gold levels now would be a promise the product cannot keep. Revisit after the first partners have real, converted referrals to measure.

## 2. Commission rules (Built)

Source: `20290303000000_affiliate_commission_guardrails.sql` and `20290303000100_affiliate_commission_ledger.sql`. Numbers there are marked *proposed defaults, unvalidated*.

- **Base:** each paid subscription invoice, amount paid minus tax, USD only. Other currencies are skipped, never converted.
- **Rate and term** are frozen at the first earning entry for each referral. Later changes never rewrite a running referral.
- **Ceiling:** 20% and 12 months. Anything above requires a staff override with a written reason of at least 10 characters, recorded in an append-only audit.
- **Hold:** entries become payable 30 days after earning.
- **Clawback:** refunds are clawed back pro rata, disputes in full, and reinstated if the dispute is won. After payout, a clawback becomes a negative entry netted against the next payout.
- **Minimum payout:** 5,000 cents (USD 50) net balance.
- **Self-dealing:** an owner or member who signs up through their own partner code is not credited (Built, scope migration).
- **Not covered by code:** payout execution (money movement), tax forms, non-USD invoices. [COUNSEL] for payout terms, tax handling and clawback wording in the agreement.

## 3. Requirements

**To join (all tiers)** (PROPOSED unless marked)

1. Accepted application: company name, contact, channel, tier (Built).
2. Agreement signed. [COUNSEL]
3. Payout details on file (Built: `payout_method`, `payout_details`).
4. Complies with the conduct rules in section 4.

**To stay active** (PROPOSED)

| Requirement | Affiliate | Agency |
|---|---|---|
| Complete the partner academy (5 lessons) | Recommended | Required within 30 days of approval |
| Pass the certification exam (section 5) | Optional | Required within 60 days of approval; recertify every 12 months |
| Named primary contact responding to Vireek within 2 business days | Yes | Yes |
| At least one referral signed up in a rolling 12 months | No | Reviewed yearly; inactivity is a reason to review, not an automatic removal |

Staff can suspend a partner at any time; suspension revokes portal access to referred accounts immediately (Built, tested).

## 4. Conduct rules (PROPOSED, [COUNSEL] before publishing)

- Quote prices only from the live pricing page. Never promise results, revenue lift or savings. The academy already teaches this (lesson "Plans, pricing and what to promise").
- No paid ads on Vireek brand terms, no impersonation of Vireek, no fake reviews.
- Disclose the affiliate relationship wherever required by advertising rules. [COUNSEL]
- No self-referral, no referral of accounts you control, no splitting of one customer across codes.
- Handle referred customers' information only as the agreement allows (section 6). [COUNSEL]

## 5. Certification

**Built:** 5 academy lessons (who Vireek is for, the 30-second pitch, plans and what to promise, how the referral link works, what makes a referral stick), a 6-question multiple-choice quiz, pass mark **80%** enforced on the server (`record_partner_certification`), one certificate per partner user.

**Gap:** at 6 questions, one wrong answer (83%) passes and two (67%) fail, and the same bank is used every attempt. That is a knowledge check, not a certification exam. The outline below is the PROPOSED exam for the Agency tier; it is not implemented.

| Part | Content | Format | Weight |
|---|---|---|---|
| 1. Positioning | Ideal customer, qualification questions, when Vireek is not a fit | 10 multiple choice | 20% |
| 2. Product and plans | What each plan includes, what the voice agent can and cannot do, setup time, integrations that exist vs. in progress [VERIFY the list at exam time] | 15 multiple choice | 30% |
| 3. Claims and compliance | Allowed and forbidden statements, call-recording and consent basics, advertising disclosure [COUNSEL] | 10 scenario questions ("is this statement allowed?") | 20% |
| 4. Referral mechanics and commission | Attribution, conversion trigger, hold, clawback, self-dealing rule | 10 multiple choice | 15% |
| 5. Practical | Walk a mock prospect through the first-week plan; written, scored against a rubric by Vireek staff | 1 written task | 15% |

Rules (PROPOSED): 45 questions plus 1 task, 90 minutes, pass mark 80% overall with at least 60% in every part, questions drawn from a larger bank, retake after 7 days, maximum 3 attempts per quarter, certificate valid 12 months, revoked on a conduct breach. Part 5 requires staff time, so it applies to the Agency tier only.

## 6. Portal access scope (Built)

Migration `20290307000100_partner_portal_scope.sql`. A partner user is limited to the accounts their partner referred, and sees a fixed minimal set of fields.

| | Owner | Member | Member with commission flag |
|---|---|---|---|
| Referred accounts: business name, plan, account status, referral status, dates | Yes | Yes | Yes |
| MRR, commission amount and status | Yes | No (returned as null) | Yes |
| Add/remove members, change the flag, read the access log | Yes | No | No |
| Any job, call, customer, invoice, note, email, phone or person's name in a referred account | **No** | **No** | **No** |
| Accounts referred by other partners, rejected referrals, erased accounts | **No** | **No** | **No** |

How it is enforced (all covered by `scripts/db-tests/partner-scope.pglite.mjs`, 107 checks, and `supabase/tests/database/partner_scope.test.sql`):

- Partner users are never members of a customer account, so every existing tenant policy (`user_id = get_account_owner_id()`) returns nothing for them. No new policy was added to any tenant table.
- Access to a referred account is only through `partner_list_referred_accounts`, `partner_get_referred_account` and `partner_scope_context`. They return a fixed column set. RLS cannot hide columns, so functions do it.
- A non-existent account and another partner's account give the same error, so account ids cannot be probed.
- Every single-account view is written to an append-only access log, readable by the partner owner and by Vireek staff.
- Only an approved partner has scope. Suspending or removing a user takes effect on the next call.
- Members: owner-only management, maximum 10 per partner (PROPOSED default), one partner per user, never a staff account, never a referred account of the same partner. One generic error for every refused addition, so the owner cannot learn whether an email has a Vireek account.

**Not done:** there is no portal UI for referred accounts or member management yet (the typed helper `src/lib/partnerScope.ts` is ready for it), and the existing direct-read policies on `partners`, `partner_referrals` and `partner_link_clicks` are unchanged (owner or staff only).

**[COUNSEL] before the UI ships:** showing a referred customer's business name and plan to the partner that referred them is a disclosure to a third party. Confirm the legal basis, what referred customers are told at signup, whether they can opt out, and how long access-log rows are kept.

**[VERIFY]:** `attribute_partner_referral(p_code, p_user_id, p_email)` is executable by `anon` and trusts the caller-supplied `p_user_id`. A caller who knows a partner code and another user's id could attribute that user to the partner. Practical risk is low because ids are unguessable, but attribution should be derived from the authenticated session. This was left unchanged on purpose and is reported rather than fixed here.

## 7. Support service levels (PROPOSED)

The repository defines no support SLA (`RUNBOOK.md` lists this as an open gap), so none of these is a commitment until the owner, staffing and tooling exist. [COUNSEL] before any of it goes into an agreement.

**Partner-facing support (about the program, links, commissions, certification)**

| Severity | Example | First response | Target resolution |
|---|---|---|---|
| P1 | Referral links broken, commissions miscalculated at scale, partner cannot sign in | 4 business hours | 1 business day |
| P2 | One referral not attributed, certificate not issued, payout question | 1 business day | 3 business days |
| P3 | How-to, feedback, content requests | 2 business days | Best effort |

**Customer escalations from a partner's customers (Agency tier)**

| Severity | Definition | Partner escalation path | First response |
|---|---|---|---|
| Critical | Customer's calls are not being answered or the product is down | Partner priority contact, then the incident process in `docs/runbooks/incident-response.md` | 1 hour during business hours |
| Standard | Feature question, configuration help | Partner support queue | 1 business day |

"Business hours" and the time zone are not defined in the repository: set them with the owner. Targets are measured per ticket, reported monthly to Agency partners, and are first-response targets, not uptime guarantees (uptime objectives live in `docs/SLO.md`).

## 8. Operating the program

| Task | How |
|---|---|
| Approve or reject an application | Staff partner applications page (Built) |
| Adjust commission terms | Staff partner commissions page, reason required (Built) |
| Pay approved commissions | `pay_partner_approved_commissions` (Built; money movement itself is not) |
| Review who looked at which referred account | `partner_access_log` (staff and partner owner) |
| Suspend a partner | Set status `suspended`; access to referred accounts ends immediately |
| Add or remove partner team members | `partner_add_member`, `partner_remove_member` (owner); no UI yet |

## 9. Open decisions

| # | Decision | Needed from |
|---|---|---|
| 1 | Approve or change the PROPOSED requirements, exam and service levels | Program owner (TBD) |
| 2 | Legal basis and customer notice for showing referred accounts to partners | Counsel |
| 3 | Partner agreement, payout, tax and clawback terms | Counsel |
| 4 | Reseller/white-label commercial model | Founder |
| 5 | Business hours, support tooling and who staffs partner support | Operations |
| 6 | Fix attribution identity (section 6, [VERIFY]) | Engineering |
