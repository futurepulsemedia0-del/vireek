# Proof-of-concept (POC) playbook

How Vireek runs a time-boxed trial with a prospect: who qualifies, how the demo tenant is created, what "success" means before we start, the timeline, and how the exit review ends the trial.
Tooling: [`scripts/provision-demo-tenant.mjs`](../../scripts/provision-demo-tenant.mjs) · registry: `supabase/migrations/20290307000000_demo_tenants.sql`.
Loss follow-up: [win-loss-interview-guide.md](win-loss-interview-guide.md).

Conventions: **[COUNSEL]** = needs a lawyer's decision before it is used with a customer. **[VERIFY]** = a fact about the product or environment that must be checked before it is promised. Numbers marked *proposed* are starting points, not validated benchmarks.

---

## 1. Ground rules

1. **A POC has an end date, a written success definition and an exit review, or it does not start.** An open-ended trial is a free account.
2. **Demo tenants are never production tenants.** They hold synthetic data only, use a random password, and expire automatically (default 14 days, hard maximum 30 at creation, two extensions of up to 14 days, 60 days absolute).
3. **No fixed or shared credentials, ever.** Each POC gets its own login. The password is shown once by the script and stored nowhere.
4. **We do not promise outcomes.** We agree what will be measured and how. We never quote ROI, revenue lift or savings figures that the product has not produced for that prospect. [COUNSEL] for any written statement of results.
5. **Real customer data of the prospect is out of scope** unless the exit conditions in section 8 are met first. [COUNSEL]

## 2. Qualification gate (before provisioning)

All of the following, recorded in the CRM or the deal note:

| # | Gate | Evidence |
|---|---|---|
| 1 | A named **champion** who will use the product daily during the POC | Name + role |
| 2 | A named **decision maker** who attends the exit review | Name + role, accepted invite |
| 3 | The prospect's **problem and baseline** in one sentence each (e.g. "~20 missed calls a week", "invoices paid after 41 days") | Prospect's own numbers, labelled as *stated by prospect* |
| 4 | **Success criteria** agreed (section 5) | Signed off by email |
| 5 | **Exit review date** booked on both calendars | Invite |
| 6 | **Budget and buying process** known: who signs, what procurement or security review is needed | Deal note |

If gates 1, 2 or 4 are missing, do a normal demo, not a POC.

## 3. Create the demo tenant

Prerequisites: the migration is applied, you have the service-role key in your shell environment (never on the command line, never committed), and `--confirm-project` matches the target project ref.

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service key>

# 1) Check the dataset first (no network, creates nothing)
npm run demo:provision -- create --label "Acme HVAC" --prospect "Acme Heating" --ttl-days 14 --dry-run

# 2) Create it
npm run demo:provision -- create --label "Acme HVAC" --prospect "Acme Heating" --ttl-days 14 --scenario hvac --confirm-project <ref>
```

What you get: one owner login `demo-<label>-<random>@demo.vireek.invalid` with a random 24-character password, an expiry timestamp, a business profile, 4 technicians, 60 customers, about 136 calls, 102 leads and 96 jobs spread over roughly 3 months, all synthetic. The business name always ends in "(Demo)".

**Credential handoff.** Send the password through a password manager share or a one-time link, never by plain email or chat. Send the login URL in a separate message. If the password is lost, create a new tenant; there is no recovery for a demo login.

**What a demo tenant does not have.** No provisioned voice number, no payment processor, no accounting or field-service connection, no real messaging. Anything that needs those is shown in a screen-share from a Vireek-controlled environment instead, and the success criteria must not depend on it. [VERIFY] each integration you intend to show works in the environment you will demo from.

**Operations**

| Need | Command |
|---|---|
| See all demo tenants and days left | `npm run demo:provision -- list` |
| Extend (1-14 days, max 2 times) | `npm run demo:provision -- extend --id <uuid> --days 7 --confirm-project <ref>` |
| Expire everything past its date now | `npm run demo:provision -- expire --confirm-project <ref>` (also runs hourly through pg_cron when that extension exists) |
| Delete the tenant and all its data | `npm run demo:provision -- purge --id <uuid> --yes --confirm-project <ref>` |
| Delete all tenants expired for 7+ days | `npm run demo:provision -- purge --expired-older-than-days 7 --yes --confirm-project <ref>` |

Expiry bans the login and removes its sessions. A browser that already holds a valid access token can keep working until that token expires (Supabase default: 1 hour). [VERIFY] the token lifetime in the project settings.

Extensions need a written reason in the deal note ("blocked on prospect's IT approval for X"), never "they want more time".

## 4. Timeline (14-day default)

| When | Milestone | Owner | Output |
|---|---|---|---|
| **T-5 to T-1** | Qualification gate, success criteria signed, tenant created with `--dry-run` check, exit review booked | Account executive (AE) | Gate checklist complete |
| **Day 0** | Kickoff (45 min): walk the success criteria, hand over credentials, show the 3 screens that matter for the criteria | AE + solutions engineer (SE) | Kickoff notes, prospect logged in |
| **Day 1-3** | First-value window: champion completes the tasks tied to criterion 1 | Champion; SE on call | At least one criterion has real usage |
| **Day 5** | 15-minute check-in: usage vs. plan, blockers | SE | Blocker list with owners |
| **Day 7** | Midpoint review: score each criterion *on track / at risk / blocked* | AE + SE + champion | Scorecard v1. Any "blocked" item either fixed or removed by agreement |
| **Day 10-11** | Pre-read sent: scorecard, open items, proposed next step | AE | Sent 2 business days before the review |
| **Day 12-14** | **Exit review** (section 6) | AE, SE, decision maker, champion | Decision recorded |
| **Day 14** | Tenant expires automatically unless a documented extension exists | SE | Expiry confirmed in `list` |
| **Day 14 + 7** | Purge of the expired tenant; deletion confirmation sent if the prospect asked for it | SE | Purge confirmed |

If the champion has not logged in by Day 3, call them that day. If there is no meaningful usage by Day 7, hold a decision call: fix the blocker, re-scope, or end the POC early. Do not let it drift to Day 14 unused.

## 5. Success criteria

Rules for writing them:

- **At most five**, at least three. Each has one measure, one source, one threshold and one owner.
- Each must be **observable in the demo tenant or in a Vireek-run walkthrough**. If it depends on a connection the tenant does not have, say so and score it as a *walkthrough criterion*.
- Separate **must-have** (decision depends on it) from **nice-to-have**. The POC passes when every must-have passes.
- Thresholds are agreed **with the prospect, before Day 0**. Changing a threshold after Day 0 requires both sides in writing.
- Prefer behaviour the prospect performs ("the dispatcher books 10 jobs in the schedule without help") over claims about outcomes ("revenue grows").

Template (copy into the deal note):

| # | Criterion | Type | Measure and source | Threshold (*proposed*) | Owner |
|---|---|---|---|---|---|
| 1 | Dispatcher can create and assign a job end to end | Must-have | Jobs created by the champion in the tenant, counted from the Jobs list | 10 jobs in 5 working days, no SE help after Day 3 | Champion |
| 2 | Missed-call and lead handling matches how the prospect works | Must-have | Walkthrough of call, lead and customer records against the prospect's own call flow [VERIFY voice setup shown] | Prospect confirms the flow in writing, or lists gaps | SE |
| 3 | Invoicing and payment status are visible without spreadsheets | Nice-to-have | Jobs with invoice status in the tenant | Prospect reviews 5 jobs and confirms the statuses read correctly | Champion |
| 4 | Imports from the prospect's current system are feasible | Must-have | Sample export (their file, anonymised by them) run through the import wizard in a dry run | Dry run completes; row errors reviewed with the prospect [VERIFY importer supports their source] | SE |
| 5 | Security and procurement questions answered | Must-have | Questionnaire answered from the security pack | All questions answered within 5 working days of receipt [COUNSEL] for any contractual language | AE |

Do not add criteria about uptime, response times or accuracy unless the measure exists in the product for that tenant and someone has verified it. [VERIFY]

## 6. Exit review

**Length:** 45 minutes. **Required attendees:** decision maker, champion, AE, SE. If the decision maker does not attend, the review is rescheduled once; after that the POC closes as "no decision".

**Agenda**

1. (5 min) Restate the problem and baseline in the prospect's words.
2. (15 min) Scorecard, criterion by criterion: evidence on screen, status *met / partly met / not met*, one sentence why. No new criteria.
3. (10 min) What we learned: gaps found, requests for the product team (logged separately, not promised).
4. (10 min) Decision and next step (outcomes below).
5. (5 min) Close: owners and dates for each action.

**Outcomes**

| Outcome | Condition | Next step |
|---|---|---|
| **Go** | Every must-have met | Order form and onboarding plan within 5 business days (*proposed*). Tenant expires as scheduled; production onboarding is a separate tenant. |
| **Go with conditions** | One must-have partly met, with a clear fix | Written conditions with owner and date; one extension allowed to verify. |
| **Extend once** | A blocker outside our control (e.g. their IT approval) | Documented extension, new exit date, same criteria. |
| **No-go** | A must-have not met, or no decision | Close the POC, purge on schedule, run a loss interview ([guide](win-loss-interview-guide.md)). |

**Record (fill in within 1 business day):**

```
POC: <prospect> · tenant: <account_id> · created: <date> · exit review: <date>
Attendees:
Baseline (stated by prospect):
Criteria:  1 <met|partly|not>  2 ...  (must-haves marked)
Outcome: <Go | Go with conditions | Extend once | No-go>
Conditions / actions (owner, date):
Product feedback logged (links):
Deletion requested by prospect: <yes/no>
Decision recorded by: <name>   Approved by: PENDING
```

## 7. Closing the POC

1. Confirm in `list` that the tenant is `expired` (or `active` with a documented extension).
2. After the retention window (default 7 days after expiry) run the purge command. It deletes the tenant's rows using the same table registry as the self-service delete-account function, then the login, and keeps only a registry tombstone (no personal data).
3. If the prospect asks for confirmation, send a short note: the date of the purge and that only synthetic data and the data they typed into the tenant were stored. [COUNSEL] before calling it a certificate of erasure.
4. Log the outcome in the CRM with the reason code.

## 8. Using the prospect's real data (only after the gate below)

Not part of the default POC. Before any real customer data of the prospect enters Vireek:

- A signed agreement covering data processing and the POC scope. [COUNSEL]
- The prospect confirms in writing they have the right to share the data and that it is limited to what the criteria need.
- A separate, non-demo tenant with its own retention date, not the synthetic demo tenant. [VERIFY] the retention and deletion path for that tenant.
- No outbound messages to the prospect's customers during the POC.

## 9. Roles

| Role | Responsibility | Person |
|---|---|---|
| Account executive | Qualification, criteria, exit review decision record | TBD |
| Solutions engineer | Provisioning, check-ins, walkthroughs, purge | TBD |
| Security contact | Questionnaire answers, evidence requests | TBD |
| Exec sponsor | Escalations, extension approval beyond the first | TBD |

Owners are placeholders because the repository does not name them.

## 10. Verification status of the tooling

| Check | Status |
|---|---|
| Unit tests for credentials, TTL, dataset, purge ordering (`npm run test:scripts:demo-tenant`) | Run, 13 passed |
| Migration executed on an in-process Postgres (PGlite) with stubbed auth (`npm run test:db:demo-tenants`) | Run, 40 checks passed |
| `create` against a real Supabase project (Auth admin API, inserts, rollback on failure) | **Not run** (no project access) |
| Login ban actually refuses sign-in in GoTrue; access-token tail | **Not run** |
| Purge against a project with real tables (`erase_user_rows` blocked list) | **Not run** |
| pg_cron hourly schedule present after migration | **Not run** |
| Insert column compatibility with the live `customers`, `calls`, `leads`, `jobs`, `team_members`, `business_profile` schema | **Not run**; columns were read from the migrations in the repository snapshot, which may be older than your database |

Manual checklist for the first real run: create a tenant, sign in, confirm the data renders, wait or force expiry, confirm sign-in is refused, run purge, confirm `list` shows `purged` and no rows remain for the account id.
