# ADR — Org scaling: when to split teams, add on-call tiers and create functions

- **Status:** Proposed (not yet accepted by an owner)
- **Date:** 2026-11-19
- **Decision owner:** TBD **[VERIFY]**. `docs/OWNERS.md` has no named person for any area today.
- **Scope:** Vireek's own engineering, support and go-to-market organisation. It does **not** cover the customer-facing on-call feature (`business_profile.on_call_schedule`, `escalation_events`), which routes *tenants'* calls and is a product feature, not Vireek's rota.
- **Evidence base:** the repository snapshot uploaded on 2026-11-19, measured with the commands in §9. Documents in the repo disagree with each other in places; where they do, the number measured today is used and the discrepancy is listed in §8. Nothing here was measured against production, GitHub settings, PagerDuty or Supabase.
- **Explicit non-goal:** this ADR makes **no headcount, hiring, budget or title commitment**. A trigger that fires opens a decision. It does not authorise a hire.

## 1. Question

Growth in tenants, call volume and code surface will eventually make today's lightweight setup (a handful of ownership areas, one weekly primary/secondary rota, a support tier model that describes functions, not titles) a bottleneck. What observable condition should cause us to (a) split a team or ownership area, (b) add an on-call tier, or (c) create a dedicated function, so that the decision rests on counted signals and not on the feeling that "we are busy"?

## 2. Current state (what exists, what does not)

| Topic | What the repo shows | Source |
|---|---|---|
| Ownership areas | 6 areas (security, voice, billing, integrations, support, compliance); **all 6 have no assigned owner or backup** | `docs/OWNERS.md`, `node scripts/governance/check-owners.mjs` (6 warnings) |
| Code ownership | `.github/CODEOWNERS` uses 8 distinct `@OWNER_*` placeholders; GitHub ignores invalid owners, so it protects nothing yet | `.github/CODEOWNERS`, `DECISIONS_NEEDED.md` D-7 |
| Engineering on-call | One primary and one secondary, weekly, hand-off Monday 10:00 local, 10 minutes to acknowledge, then secondary, then engineering manager. Page budget of 6/hour. Whether PagerDuty is configured is **unverified** | `docs/incident/incident-management.md`; `docs/compliance/insurance-program.md` row E2 |
| Incident roles | IC, technical/operations lead, comms lead, scribe; one person may hold several in a SEV3. Roster is `TBD` | `docs/runbooks/incident-response.md` |
| Support tiers | T1 frontline, T2 specialist, T3 engineering on-call. "Roles are functions, not job titles." Roster and tool `TBD` | `docs/support/tier-model.md`, `escalation-to-engineering.md` |
| Support targets | S1 30 min / 4 h, S2 2 h / 24 h, S3 8 h / 72 h, S4 24 h / 120 h. **Proposed**, calendar time, no business-hours calendar, no auto-paging on overdue | `docs/support/response-time-targets.md` |
| Alert pipeline | `observability_alert_log` records trigger/resolve/digest per channel (`pagerduty`, `slack`, `ticket`, `status`), severity SEV1–SEV4, `delivered`; log retained 180 days | `supabase/migrations/20280402000000_voice_observability.sql`, `docs/runbooks/voice-observability.md` |
| Reliability targets | SLOs are **PROPOSED and unmeasured**; no k6 results recorded | `docs/SLO.md`, `docs/SCALE_READINESS.md` |
| Customer health | Bands healthy ≥ 75, watch 50–74, at_risk 25–49, critical < 25; risk levels `high`/`medium`; no stored risk history | `docs/customer-success/at-risk.md` |
| Business KPIs | GDR/NDR, activation, module attach, take rate, CAC payback (manual inputs) at `/staff/founder-kpis` | `docs/ANALYTICS_METRICS.md` Part B |
| Sales evidence | Staff-only win/loss records, minimum 5 decided deals before a rate is shown | `src/lib/winLoss.ts` (`MIN_DECIDED_FOR_RATE = 5`), `docs/sales/win-loss-interview-guide.md` |

## 3. Decision

1. **Signals, not headcount.** Every trigger below is a condition on a signal with a named source. A trigger that has no working source is **inactive** (§7) until the source exists. Fixing measurement comes before reorganising.
2. **Two-review rule.** A trigger fires when its conditions hold at **two consecutive quarterly reviews** (the first-week review already defined in `incident-management.md`). The exceptions are marked "single-event" and fire immediately.
3. **Escalation ladder.** Firing never jumps straight to a new team. The owner must record why each cheaper option does not fit, in this order: (1) remove the cause (fix, automate, tune the alert), (2) re-scope or re-assign existing ownership, (3) formalise a role or rota, (4) split the team or create the function.
4. **Fix noise before adding people.** No on-call tier is added while the share of non-actionable pages is above the gate in §5 (B0).
5. **All numbers are PROPOSED defaults [VERIFY with the decision owner].** They exist so the first review has something to calibrate against. Change them in the decision log (§10), not silently.
6. **Boundary before team.** A team split must follow an interface that already exists or is created first (edge function, schema, shared module with its own tests). Splitting people along an unclear boundary is rejected.

## 4. Signal catalogue

### 4.1 Repo signals (re-run, do not trust the table)

| ID | Signal | Snapshot value (2026-11-19) | How to re-measure |
|---|---|---|---|
| G1 | Areas without owner or backup | 6 of 6 | `node scripts/governance/check-owners.mjs` |
| G2 | Distinct CODEOWNERS placeholders | 8 | `grep -o '@OWNER_[A-Z]*' .github/CODEOWNERS \| sort -u` |
| C1 | Fixed-cap reads in scheduled functions (tenants silently skipped past the cap) | 23 | `node scripts/scale-limits-scan.mjs` |
| C2 | Production code files over 800 / over 1,500 lines | 127 / 13 of 4,663 scanned | command in §9 |
| C3 | Edge-function folders (excluding `_shared`) / migration files | 484 / 801 | `ls -d supabase/functions/*/ \| grep -v _shared \| wc -l`; `ls supabase/migrations \| wc -l` |
| C4 | Unit/test files (`*.test.ts(x)`, src + supabase/functions) / pgTAP files | 1,265 / 100 | `find` as in §9; `ls supabase/tests/database \| wc -l` |

### 4.2 Operating signals (need production or process data)

| ID | Signal | Source today | Status |
|---|---|---|---|
| O1 | SEV1/SEV2 pages per week, by severity | `observability_alert_log` (`channel='pagerduty'`, `kind='trigger'`) | Source exists (query in §9). Not run |
| O2 | Pages that did not reach the pager | `observability_alert_log.delivered = false` | Source exists. Not run |
| O3 | Share of non-actionable pages | "noisy alert" ticket filed the same day (`incident-management.md`) | **No store.** Count manually until one exists |
| O4 | Incidents by severity, MTTA, MTTR, post-mortem actions older than 30 days | Post-mortems (`docs/runbooks/post-incident-template.md`) | **No structured store.** Manual |
| O5 | Who was pulled in during an incident (area owners called) | Post-mortem timeline | **Not captured as a field.** Add to the template |
| O6 | Error-budget burn per SLO | `docs/SLO.md` | **Inactive.** SLOs are proposed and not measured |
| O7 | S1/S2 first-response and resolution overdue share | `src/lib/supportSla.ts`, `supportSlaApi.ts` reference `support_sla_targets` / `support_overdue_tickets` | **[VERIFY]** no `CREATE` for either object was found in `supabase/migrations` in this snapshot |
| O8 | Share of active accounts at `high` / `medium` success risk | `computeSuccessRisk()` in `src/lib/successTools.ts`; `staff_success_overview()` | Source exists; no history, so only point-in-time |
| O9 | Gross / net dollar retention, activation | `/staff/founder-kpis`, `docs/ANALYTICS_METRICS.md` | Source exists; target values **[VERIFY]** (none defined in the repo) |
| O10 | Win/loss "price" share of decided losses | `win_loss_summary` (staff only) | Source exists; ignore buckets with fewer than 5 decided |
| O11 | Median PR time-to-first-review per CODEOWNERS path | GitHub API | **Not collected** |
| O12 | Discount-request age and volume (deal desk) | `docs/sales/pipeline.md` once the pipeline is in use | Depends on that feature being adopted |

## 5. Triggers

### A. Splitting a team or ownership area

**Precondition A0.** The area has a named owner **and** a different named backup in `docs/OWNERS.md` (G1 = 0 for that area). If not, the first action is to assign them. This is not a split.

**Fires when at least two of A1–A4 hold** for the area at two consecutive reviews:

| ID | Condition (PROPOSED) | Signal |
|---|---|---|
| A1 | ≥ 2 SEV1/SEV2 incidents in the quarter whose root-cause category falls in this area | O4 (root-cause categories: provider, deploy, DB, config, tool, telephony) |
| A2 | The area's scheduled functions still hold fixed caps and C1 has not dropped between the two reviews | C1 |
| A3 | Owner and backup are one person, **or** the backup has no merged change in the area for 90 days, **or** median time-to-first-review on the area's paths exceeds 1 business day in both months | G1, git history, O11 |
| A4 | The area contains a file over 1,500 lines that is changed in at least 5 merged PRs in the quarter | C2 plus git history |

**Single-event trigger (A-S).** One confirmed cross-tenant data exposure caused by code in an area forces a review of that area's ownership within 5 business days, regardless of A1–A4.

**What the proposal must contain:** the boundary (named module, function or schema), owner and backup for each side, the interface contract and its tests, and the condition under which the two sides merge back.

**Do not split when** the signal is driven by one incident, or when O3 shows that most pages in the area were non-actionable (tune alerts first).

### B. Adding on-call tiers

Today's rota is one primary + one secondary with escalation to the engineering manager. It is the baseline. The customer-facing on-call feature is out of scope (header).

**Gate B0 (applies to every tier below).** In the review quarter: O2 shows no undelivered SEV1/SEV2 pages, **and** the non-actionable share (O3) is at most 30 %. Otherwise the action is "fix alerts", not "add a tier". The alert-fatigue controls already in `alertRules.ts` (volume gate, confirmation, hysteresis, cooldown, page budget of 6/hour, inhibition) must be confirmed active before this gate can be passed **[VERIFY]**.

| Tier | Fires when (PROPOSED) | Signals |
|---|---|---|
| B1 Domain secondary (for example voice) | One domain accounts for at least 50 % of SEV1/SEV2 pages in the quarter **and** in at least 30 % of those incidents the on-call had to pull in an area owner | O1, O5 |
| B2 Out-of-hours split | At least 25 % of SEV1/SEV2 pages fall between 22:00 and 06:00 in the rota's local time, **or** the 10-minute acknowledge target is missed in two or more incidents in the quarter | O1 timestamps, O4 |
| B3 Dedicated incident commander | Two SEV1/SEV2 incidents overlapped in the quarter, **or** two SEV1 post-mortems show the IC was also the person debugging | O4, O5 |
| B4 Support after-hours tier (T1/T2) | Two or more S1 tickets missed the 30-minute first response outside business hours in the quarter | O7 (**inactive until O7 is verified**) |
| B5 Load guard (single-event) | Any one on-call person receives pages above the 6/hour budget in three separate weeks of a quarter. First action: alert tuning (ladder step 1) | O1 |

A tier is a rota slot with a hand-off rule and a runbook entry. It is not a job.

### C. Creating a function

A function is a named, accountable responsibility with its own backlog, metrics and runbook. It may be staffed by one person part-time, by a rotation or by an outside provider. That choice is outside this ADR.

| Function | Fires when (PROPOSED) | Signals |
|---|---|---|
| C-Support operations | S1/S2 overdue share exceeds 10 % in two consecutive quarters, **or** more than 25 % of tickets reach T3 with an escalation packet | O7 (**inactive until verified**), escalation packets |
| C-Customer success | `high` + `medium` risk accounts exceed 20 % of active accounts at two reviews, **or** the 2-business-day first-touch policy for `high` is missed for more than 20 % of cases | O8, `at-risk.md` (policy numbers are **[VERIFY]**) |
| C-Security and compliance | Any signed customer commitment with a security or availability obligation is entered in the commitments register (single-event), **or** evidence rows still marked unverified are older than 90 days at two reviews | `DECISIONS_NEEDED.md` D-8/D-9/D-10, `insurance-program.md`. Legal content **[COUNSEL]** |
| C-Reliability and platform | C1 has not decreased across two reviews **and** the 10x readiness list in `SCALE_READINESS.md` is incomplete, **or** any SLO burns more than 100 % of its budget in two of four months | C1, O6 (**inactive until SLOs are measured**) |
| C-Revenue operations / deal desk | Discount requests pending for more than 2 business days at the 90th percentile in the quarter, **or** "price" is the stated reason in at least 40 % of decided losses with at least 5 decided | O10, O12 |

## 6. Alternatives considered

- **Headcount or ARR thresholds.** Rejected: explicitly out of scope, and none of the inputs exist in the repo. They would also promise hiring the business has not decided to do.
- **Calendar-based reorganisation** (reorg every N months). Rejected: ignores the signals that show whether anything is actually broken.
- **Do nothing until something fails.** Rejected: the repo already shows leading indicators (unowned areas, fixed caps, unverified pager) that are cheap to track.

## 7. Consequences

- **Several triggers cannot fire today**: O3, O4, O5, O6, O7, O11 have no working source. Until they do, the only live triggers are those based on G1/G2/C1/C2 and O1/O2/O8–O10, and those need an owner to run the queries.
- **First 90 days are measurement work**: assign owners (G1), replace CODEOWNERS placeholders (G2), confirm the pager is configured, add the O5 field to the post-mortem template, verify or create the support SLA objects (O7), and decide where incident data is stored.
- **Cost of the rule:** a short quarterly review (it extends the review already specified in `incident-management.md`). No new tooling is required to start.
- **Risk:** proposed thresholds may be wrong. The decision log (§10) is where they are changed, with a reason.

## 8. Discrepancies found while writing this ADR

These affect how far the numbers can be trusted. None was fixed here; they are out of scope.

| Item | Observed |
|---|---|
| `docs/SCALE_READINESS.md` says CI runs `node scripts/scale-limits-scan.mjs --max=23` | No reference to `scale-limits-scan` in `.github/workflows` or `package.json` **[VERIFY]**. The ratchet may not exist |
| `package.json` defines `debt:report` | `scripts/governance/debt-report.mjs` is not in the snapshot; `docs/governance/TECH_DEBT.md` (3,768 files scanned, 678 migrations) is therefore stale against today's counts |
| `docs/SCALE_READINESS.md`: 112 `cron.schedule` entries | `grep -o "cron.schedule" supabase/migrations/* \| wc -l` gives 135; the counting method differs (this may include comments or re-schedules) **[VERIFY]** |
| `docs/product-surface.md`: 345 edge-function folders | 484 folders today (excluding `_shared`) |
| `DECISIONS_NEEDED.md` D-8..D-10 point to `docs/registers/*.json` | `docs/registers/` does not exist in the snapshot |
| `docs/support/response-time-targets.md` describes `support_sla_targets` and `support_overdue_tickets` | Not found in `supabase/migrations`; only referenced from `src/lib/supportSla*.ts` **[VERIFY]** |

## 9. How to measure

```bash
# G1, G2
node scripts/governance/check-owners.mjs
grep -o '@OWNER_[A-Z]*' .github/CODEOWNERS | sort -u

# C1
node scripts/scale-limits-scan.mjs | head -1

# C2 (production code, tests and .d.ts excluded)
find src supabase/functions worker api -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -name '*.test.*' ! -name '*.d.ts' -print0 | xargs -0 wc -l \
  | awk '$2!="total"{n++; if($1>800)a++; if($1>1500)b++} END{print n" files; >800: "a"; >1500: "b}'

# C3, C4
ls -d supabase/functions/*/ | grep -v _shared | wc -l
ls supabase/migrations | wc -l
find src supabase/functions -name '*.test.ts*' | wc -l
ls supabase/tests/database | wc -l
```

```sql
-- O1: SEV1/SEV2 pages per week, last 13 weeks (log retention is 180 days)
select date_trunc('week', created_at) as week, severity, count(*) as pages
from public.observability_alert_log
where channel = 'pagerduty' and kind = 'trigger'
  and severity in ('SEV1', 'SEV2')
  and created_at >= now() - interval '13 weeks'
group by 1, 2
order by 1, 2;

-- O2: pages that were not delivered
select date_trunc('week', created_at) as week, count(*) as undelivered
from public.observability_alert_log
where channel = 'pagerduty' and kind = 'trigger' and delivered = false
  and created_at >= now() - interval '13 weeks'
group by 1
order by 1;
```

These queries were written against the column list in the migration. They were **not executed** against a database.

## 10. Review and decision log

Review: first week of each quarter, together with the recurring-causes review in `incident-management.md`. The reviewer records the value of each live signal, which triggers hold, and the outcome. A trigger that holds once is noted; at the second consecutive review it fires and the ladder in §3 is walked.

| Date | Trigger | Signals (values) | Ladder step reached | Decision | Owner |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |

## 11. Open items

1. Name the decision owner and the owner and backup of each area **[VERIFY]**.
2. Confirm or replace every PROPOSED number in §5 at the first review.
3. Set target values for GDR/NDR and activation (O9). None are defined in the repo **[VERIFY]**.
4. Decide where incident, MTTA and MTTR data lives (O4, O5).
5. Any external statement about on-call coverage, response times or compliance commitments needs review before use **[COUNSEL]**.
