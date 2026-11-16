# Vireek Blog: Audit and Editorial Roadmap

Based on `vireek-main__4_.zip` (files dated 2026-11-13). Facts below come from the code; anything I could not verify is marked.

## 1. What exists today

| Finding | Evidence |
|---|---|
| The `/faq` page has **no blog section** in code | `src/pages/FAQPage.tsx` contains no blog/article references. The blog lives at `/blog`. |
| Live `/faq` could not be read | `vireek.com/faq` is a client-rendered SPA; fetching it returns only the homepage meta tags. **NOT VERIFIED:** what the live page renders. |
| Posts in this zip | **7**, all in the legacy file `src/lib/blog.ts` |
| Markdown posts in this zip | **0**. `content/blog/` has only `README.md`, `_authors.json`, `_categories.json`. The Markdown pipeline (`scripts/blog/*`) is ready but nothing has been migrated in this snapshot. |
| Live count | **NOT VERIFIED.** Your memory of editing across several chats means the live repo may differ from this zip. |

### The 7 existing posts are all thin

Approximate word counts, counted from `blog.ts` (the validator's target for new posts is 1,500–2,500):

| Slug | ≈ Words |
|---|---|
| ai-receptionist-cost | 529 |
| cost-of-a-missed-call | 402 |
| hvac-emergency-call-triage | 340 |
| ai-receptionist-vs-answering-service | 344 |
| ai-vendor-security-checklist | 309 |
| perfect-call-script-home-services | 318 |
| plumbing-missed-call-cost | 284 |

Every one is a rewrite candidate. None has FAQ, sources, tables, or related-reading structure.

### Coverage gaps by category (`_categories.json`)

| Category | Existing posts | Gap |
|---|---|---|
| missed-calls | 2 | After-hours, voicemail, speed-to-lead depth |
| ai-receptionist | 3 | Buyer guides OK in topic, too short |
| trade-playbooks | 2 (HVAC, plumbing) | **11 of 13 trades on `/industries` have no playbook** |
| operations | 0 | Measurement, dispatch, reviews, quoting |
| integrations | 0 | ServiceTitan, Jobber, QuickBooks, Google Calendar |
| compliance | 0 | Consent, texting, AI disclosure |
| templates | 0 | Scripts, routing, KPI dashboard |

## 2. Delivered in this batch (6 articles, full text)

All files are in `content/blog/`. Each passed the checks listed in the final report.

| Slug | Category | Words | Purpose |
|---|---|---|---|
| roofing-storm-call-surge-playbook | trade-playbooks | ≈2,250 | Storm-spike call handling for roofers |
| electrical-emergency-call-triage | trade-playbooks | ≈1,780 | Safety-first triage script |
| water-damage-restoration-first-hour-calls | trade-playbooks | ≈1,700 | Restoration first-hour workflow, insurance wording |
| call-recording-consent-ai-receptionist | compliance | ≈1,700 | Consent and AI disclosure (`legalReview: true`) |
| how-to-measure-missed-call-rate-home-services | operations | ≈1,620 | Four formulas, worked example, sampling method |
| after-hours-call-routing-template | templates | ≈1,540 | Copyable routing table, scripts, escalation chain |

## 3. Backlog: next 28 articles

Priority A = highest search and conversion value. Slugs are valid under the validator rules.

### Trade playbooks (fills the 11 uncovered trades)

| # | Slug | Pri | Angle |
|---|---|---|---|
| 1 | pest-control-seasonal-call-playbook | A | Seasonal spikes, recurring-plan calls, treatment-record intake |
| 2 | lawn-care-weather-reschedule-calls | B | Rain reschedule surges, route density, recurring customers |
| 3 | cleaning-business-quote-call-script | A | Scope clarity before booking, recurring vs one-time |
| 4 | locksmith-emergency-call-verification | B | Lockout calls, identity and ownership checks, scam perception |
| 5 | pool-service-seasonal-opening-calls | B | Opening and closing season, chemistry issues, repair triage |
| 6 | appliance-repair-call-triage-script | B | Model and symptom capture, repair-or-replace routing |
| 7 | solar-lead-qualification-by-phone | A | Qualifying homeowners, roof and bill questions, appointment setting |
| 8 | painting-estimate-booking-calls | B | Scope questions, interior vs exterior, seasonality |
| 9 | garage-door-emergency-calls | C | Only if added to `/industries` first |

### Operations and growth

| # | Slug | Pri | Angle |
|---|---|---|---|
| 10 | speed-to-lead-home-services-playbook | A | Response-time targets and how to measure them |
| 11 | booking-rate-benchmarks-and-how-to-improve | A | Defining booking rate, call-to-job funnel |
| 12 | seasonal-staffing-for-call-spikes | B | Planning from call logs |
| 13 | review-requests-after-service-calls | B | Timing, wording, opt-out handling |
| 14 | technician-utilization-and-dispatch-basics | B | Route and capacity basics |
| 15 | quote-follow-up-sequence-for-trades | A | Cadence and templates |

### Integrations and workflows

| # | Slug | Pri | Angle |
|---|---|---|---|
| 16 | ai-receptionist-servicetitan-workflow | A | What to sync, what to keep manual (verify against `/integrations/servicetitan`) |
| 17 | ai-receptionist-jobber-workflow | A | Same, for Jobber |
| 18 | google-calendar-booking-for-small-trades | B | Calendar rules, buffers, double-booking |
| 19 | missed-call-to-invoice-workflow | B | Lead to paid job, with QuickBooks and Stripe |

### Compliance and trust

| # | Slug | Pri | Angle |
|---|---|---|---|
| 20 | texting-customers-consent-basics | A | Transactional vs marketing, opt-out (needs `legalReview: true`) |
| 21 | ai-disclosure-to-callers | B | How and when to tell callers it is AI |
| 22 | customer-data-retention-for-home-services | B | Retention schedule and deletion requests |

### Templates and checklists

| # | Slug | Pri | Angle |
|---|---|---|---|
| 23 | emergency-keyword-list-by-trade | A | Copyable lists per trade |
| 24 | ai-receptionist-rollout-plan-30-days | A | Week-by-week rollout |
| 25 | home-service-call-kpi-dashboard-template | B | Six-line scoreboard |
| 26 | ai-receptionist-vendor-evaluation-scorecard | A | Scoring sheet with weighted criteria |

### Comparison and buyer guides (use `/compare` and `/switch` pages)

| # | Slug | Pri | Angle |
|---|---|---|---|
| 27 | ai-receptionist-vs-hiring-a-receptionist | A | Total cost comparison with a worked example |
| 28 | switching-from-voicemail-to-ai-receptionist | B | Migration steps, ties to `/switch/voicemail` |

## 4. Rewrite queue for the 7 existing posts

Rewrite to 1,500+ words each, add FAQ, sources where numbers are cited, tables, and 3+ cross-links. Suggested order, by search and conversion value:

1. ai-receptionist-cost
2. cost-of-a-missed-call
3. ai-receptionist-vs-answering-service
4. perfect-call-script-home-services
5. hvac-emergency-call-triage
6. plumbing-missed-call-cost
7. ai-vendor-security-checklist

## 5. Rules for every new article

- Never invent statistics. Use "illustrative" worked examples or cite a source URL you have opened.
- Legal topics: `legalReview: true`, add `reviewedBy` only after a real qualified reviewer signs off.
- Do not claim product capabilities that are not in `/features/*` or `/integrations/*`.
- Link only to routes that exist in `STATIC_PUBLIC_PATHS` or the data-route lists.
- Add a cover image (`public/blog/*.webp`) and real author bios before launch. `_authors.json` still has a TODO placeholder.
