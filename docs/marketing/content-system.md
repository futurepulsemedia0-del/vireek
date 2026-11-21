# Vireek content system

> Owner: Marketing lead (role, not a named person) · Reviewed with: Compliance owner for anything touching claims, legal or security wording.
> Status: **working document**. Dates in the calendar are proposals until the Marketing lead confirms capacity.
> Items marked **[VERIFY]** are facts this repo could not prove. Items marked **[COUNSEL]** need a qualified legal reviewer. Neither is filled in with a guess.

This document does not replace the existing blog pipeline. It describes how that pipeline is used, which topics come from which buyer, when they ship, and who has to approve them. It is checked by `scripts/content/content-system-doc.test.mjs`, so the calendar and the trade table cannot silently drift from the real code.

## 1. What already exists (reuse, do not rebuild)

| Capability | Where | Notes |
|---|---|---|
| Markdown blog, one file per post | `content/blog/<slug>.md`, `_authors.json`, `_categories.json` | Format, dialect and rules: `content/blog/README.md` |
| Schema + cross-post validation | `scripts/blog/validate.mjs`, `scripts/blog/pipeline.mjs` | Title ≤ 60, description 140–160, valid category/author, broken-link check, ≥ 3 post links + ≥ 1 product link, heading order. `--strict` also fails on warnings |
| Article, FAQ and breadcrumb JSON-LD | `src/lib/blogSeo.ts` | `BlogPosting`, `FAQPage` (only when the post has `faq`), `Blog`, `CollectionPage`, `BreadcrumbList` |
| Public route list, canonical URLs, sitemap | `scripts/seo/routes.mjs`, `scripts/seo/build-seo.mjs` | `canonicalFor(path)` is the single definition of a canonical URL |
| Prerender and build gate | `scripts/seo/prerender.mjs`, `assert-prerendered.mjs`, `built-output.built.test.mjs` | Checks canonical, title, description, Open Graph for every prerendered route |
| Claim wording registry (certifications, SLA, uptime) | `src/lib/trust/claims.ts`, `npm run claims:check` | Status-based; blocks "we are certified" wording |
| Evidence register (numbers, comparisons) | `docs/claims-register.json`, `npm run claims:gate` | Added with this work; see `docs/compliance/claims-gate.md` |
| Content-page SEO gate | `scripts/content/check-content-pages.mjs`, `npm run content:check` | Added with this work; runs on `dist/` after the build |
| Editorial backlog (28 topics) | `BLOG_ROADMAP.md` | Source of the slugs in section 4 |

**Known gaps found while inspecting** (not fixed here, outside this task):

- `content/blog/README.md` tells editors to run `npm run blog:validate`, but `package.json` in the inspected snapshot has no such script. The same check runs with `node scripts/blog/validate.mjs [--strict]`. **[VERIFY]** whether the local copy already has the script.
- `content/blog/_authors.json` still contains the placeholder `author-1` ("TODO: Author name"). No post may use it until a real person with verifiable experience is entered.
- Posts dated in the future stay hidden until a rebuild runs after that date (`content/blog/README.md`). The inspected workflows contain no scheduled deploy. **[VERIFY]** how the Cloudflare deploy is triggered; if it is only on push, future-dated posts will not appear on their date.

## 2. Current inventory

Counted from `content/blog/*.md` in the inspected snapshot (13 posts; all dated 2026-08-18 to 2026-11-15):

| Category | Posts |
|---|---|
| trade-playbooks | hvac-emergency-call-triage, plumbing-missed-call-cost, roofing-storm-call-surge-playbook, electrical-emergency-call-triage, water-damage-restoration-first-hour-calls |
| ai-receptionist | ai-receptionist-cost (pillar), ai-receptionist-vs-answering-service |
| missed-calls | cost-of-a-missed-call (pillar) |
| operations | how-to-measure-missed-call-rate-home-services |
| templates | after-hours-call-routing-template, perfect-call-script-home-services |
| compliance | ai-vendor-security-checklist (`legalReview: true`), call-recording-consent-ai-receptionist (`legalReview: true`) |
| integrations | none yet |

Trade coverage: **5 of 13** trades on `/industries` have a playbook. The rest are the calendar's first priority because the buyer is already defined in `src/lib/industries.ts`.

## 3. ICP topics, taken from the trade pages and existing playbooks

The ideal customer is a home-service business whose owner or office lead cannot answer the phone while crews are on site. The trade-level pains below are copied in meaning from `src/lib/industries.ts` (`painPoints`, `terms`, `roi.emergencyLabel`), not invented. A trade counts as **covered** when a `trade-playbooks` post carries a tag equal to the trade slug.

<!-- icp:start -->
| Trade | Audience | Urgent call type | Recurring pain (from industries.ts) | Playbook | Next topic |
|---|---|---|---|---|---|
| hvac | HVAC companies | no-heat / no-cool calls | Emergency calls spike when the team is already on jobs; simple filter/thermostat questions clog dispatch | covered | Refresh `hvac-emergency-call-triage` with seasonal staffing (section 6) |
| plumbing | plumbing companies | burst-pipe & sewer-backup calls | A 2am burst pipe is a kept customer or a missed call; low-priority and true emergencies are handled alike | covered | Refresh `plumbing-missed-call-cost` with quote-on-the-phone guidance |
| roofing | roofing companies | storm-damage calls | Volume jumps after a storm; insurance details must be captured right the first time; crews are on roofs | covered | Quote follow-up sequence after inspections |
| electrical | electrical contractors | no-power / safety calls | Safety calls need immediate escalation; panel-upgrade estimates arrive after hours | covered | Emergency keyword list by trade (shared template) |
| restoration | restoration companies | active flood / fire calls | Time-sensitive calls; insurance information needed from call one; crews cannot staff a 24/7 line | covered | Rollout plan for 24/7 coverage with a small crew |
| locksmith | locksmith companies | lockout emergencies | Customers need an ETA immediately; after-hours jobs are the hardest to capture; real emergencies vs key copies | uncovered | Lockout call verification and scam-perception wording |
| pest-control | pest control companies | active infestation calls | Reassurance needed at once; quarterly-plan rescheduling eats office time; seasonal spikes | uncovered | Seasonal call playbook with recurring-plan intake |
| lawn-care | lawn care and landscaping companies | seasonal booking calls | Spring/fall new-customer floods; weather rescheduling ties up the phone; design estimates mixed with mowing signups | uncovered | Weather-reschedule call handling |
| cleaning | residential and commercial cleaning companies | new-client booking calls | Inquiries arrive mid-job; recurring clients reschedule constantly; commercial vs one-time handled differently | uncovered | Quote call script that fixes scope before booking |
| pool-service | pool cleaning and repair companies | green-pool / equipment calls | Green pool is urgent; weekly customers pull staff off routes; equipment failures need fast triage | uncovered | Seasonal opening and closing calls |
| appliance-repair | appliance repair companies | no-fridge / no-washer calls | A dead fridge is a same-day emergency to the customer; brand/model capture takes time; warranty vs non-warranty | uncovered | Appliance call triage script |
| solar | solar installation and service companies | system-down service calls | New-install leads are time-sensitive; monitoring-alert calls need triage; sales vs service routing | uncovered | Lead qualification by phone |
| painting | painting companies | estimate requests | A missed call is a lost bid; crews are on site all day; residential vs commercial qualifying questions differ | uncovered | Estimate booking calls |
<!-- icp:end -->

Cross-trade topics (not tied to one trade) come from the operations, templates, integrations and compliance rows of `BLOG_ROADMAP.md`. They appear in the calendar with `Trade / ICP = all`.

**Rules for ICP topics**

1. A trade post must be about a call situation the trade page already names. If a new situation is worth a post, add it to `src/lib/industries.ts` first so the site stays consistent.
2. Do not add garage-door content until garage door is added to `/industries` (the roadmap makes the same rule).
3. Seasonal timing in the calendar is a planning hypothesis. **[VERIFY]** against Vireek's own call-volume data before treating any month as peak season for a trade.

## 4. Editorial calendar

Cadence: up to two posts per week, Tuesday and Thursday. Holiday weeks are left empty on purpose (2026-12-22 to 2027-01-04). Priority A/B/C comes from `BLOG_ROADMAP.md`. All dates are proposals.

<!-- calendar:start -->
| Publish date | Slug | Category | Trade / ICP | Priority | Format | Legal review | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-24 | speed-to-lead-home-services-playbook | missed-calls | all | A | Playbook | no | Define response-time targets; any benchmark needs a cited source or is labelled illustrative |
| 2026-12-01 | cleaning-business-quote-call-script | trade-playbooks | cleaning | A | Script + FAQ | no | Fix scope before booking; recurring vs one-time |
| 2026-12-03 | ai-receptionist-vs-hiring-a-receptionist | ai-receptionist | all | A | Comparison with worked example | no | Worked example must be labelled illustrative; links to `/compare` and `/switch` pages |
| 2026-12-08 | solar-lead-qualification-by-phone | trade-playbooks | solar | A | Script + FAQ | no | Sales vs service routing |
| 2026-12-10 | texting-customers-consent-basics | compliance | all | A | Explainer | yes | **[COUNSEL]** transactional vs marketing texts, opt-out; `reviewedBy` only after a real review |
| 2026-12-15 | pest-control-seasonal-call-playbook | trade-playbooks | pest-control | A | Playbook | no | Recurring-plan calls and treatment-record intake |
| 2026-12-17 | emergency-keyword-list-by-trade | templates | all | A | Copyable template | no | Safety wording per trade must come from the customer's own safety lead, as in the existing triage posts |
| 2027-01-05 | ai-receptionist-rollout-plan-30-days | templates | all | A | Week-by-week plan | no | Only describe product steps that exist in `/features/*` |
| 2027-01-07 | booking-rate-benchmarks-and-how-to-improve | operations | all | A | Measurement guide | no | No benchmark figures without a source URL that was opened; see claims gate |
| 2027-01-12 | quote-follow-up-sequence-for-trades | operations | all | A | Cadence + templates | no | Texting steps must link to the consent post |
| 2027-01-14 | ai-receptionist-servicetitan-workflow | integrations | all | A | Workflow guide | no | **[VERIFY]** every sync claim against `/integrations/servicetitan` and the integration code |
| 2027-01-19 | ai-receptionist-jobber-workflow | integrations | all | A | Workflow guide | no | **[VERIFY]** against `/integrations/jobber` |
| 2027-01-21 | ai-receptionist-vendor-evaluation-scorecard | ai-receptionist | all | A | Scoring sheet | no | Do not score competitors on facts that cannot be sourced |
| 2027-01-26 | lawn-care-weather-reschedule-calls | trade-playbooks | lawn-care | B | Playbook | no | Route density and recurring customers |
| 2027-01-28 | pool-service-seasonal-opening-calls | trade-playbooks | pool-service | B | Playbook | no | Opening/closing season; chemistry vs repair triage |
| 2027-02-02 | appliance-repair-call-triage-script | trade-playbooks | appliance-repair | B | Script + FAQ | no | Repair-or-replace routing; warranty vs non-warranty |
| 2027-02-04 | locksmith-emergency-call-verification | trade-playbooks | locksmith | B | Playbook | no | Ownership and identity checks; keep any legal wording generic |
| 2027-02-09 | painting-estimate-booking-calls | trade-playbooks | painting | B | Script + FAQ | no | Interior vs exterior, residential vs commercial |
<!-- calendar:end -->

Not scheduled (backlog, from `BLOG_ROADMAP.md`): seasonal staffing, review requests, technician utilization, Google Calendar booking, missed-call-to-invoice, AI disclosure to callers, data retention for home services, KPI dashboard template, switching from voicemail. Pull from here when a slot opens.

The calendar adds no new legal topic without a `yes` in **Legal review**. The test fails if a `compliance` post is scheduled without it.

## 5. Quality bar for every post

- Frontmatter follows `content/blog/README.md`. Use `node scripts/blog/validate.mjs --strict` before review; strict mode also asks for a FAQ, sources and at least 1,500 words.
- No invented statistics. A number is either (a) in a worked example labelled "illustrative", or (b) backed by a source URL someone opened and an entry in `docs/claims-register.json`. The claims gate enforces this in CI.
- No claim about product behaviour that is not described on a `/features/*` or `/integrations/*` page.
- Comparisons name no competitor weakness that cannot be sourced.
- Author is a real entry in `_authors.json`; `vireek-team` is acceptable for company-voice posts.
- Cover image exists under `public/blog/` and has real alt text, or the post ships without a cover.
- AI-assisted drafting is allowed only as a first draft. Every sentence is still the editor's responsibility, and AI-written text goes through the same claims gate as human text.

## 6. Review workflow

| # | Stage | Owner (role) | Exit criteria |
|---|---|---|---|
| 1 | Brief | Marketing lead | Slug, trade/ICP, the one call situation, target reader, sources to open, and whether `legalReview` applies |
| 2 | Draft | Writer | File in `content/blog/` with `draft: true`; every number sourced or labelled illustrative |
| 3 | Subject review | Trade SME (a technician, dispatcher or owner who works in that trade) | Call scripts and triage steps reflect real practice; safety wording marked as "from your own safety lead" |
| 4 | Product accuracy | Product owner | Every product statement matches a `/features/*` or `/integrations/*` page or the code |
| 5 | Claims check | Compliance owner | `npm run claims:check` and `npm run claims:gate` pass; any new register entry has a real evidence URL, owner and expiry date |
| 6 | Legal review (only if `legalReview: true`) | Qualified reviewer **[COUNSEL]** | `reviewedBy` filled with the real reviewer, role and date. Never filled in advance |
| 7 | SEO and technical | Marketing lead | `node scripts/blog/validate.mjs --strict` passes; after a build, `npm run content:check` passes |
| 8 | Publish | Marketing lead | Remove `draft: true`, set `publishedAt` and `updatedAt`; merge; confirm the deploy ran (see the scheduled-deploy gap in section 1) |
| 9 | Post-publish | Marketing lead | Check the live page title, canonical and structured data once; add the URL to the sitemap submission if the team uses search consoles **[VERIFY]** |

Rules that apply at every stage:

- A reviewer can block. Nobody publishes over an unresolved compliance or legal comment.
- Changes after approval restart from stage 5 if they touch a number, a comparison or a legal statement.
- `updatedAt` changes only when the content materially changes, because it feeds `dateModified` and the sitemap `lastmod`.

**Refresh cadence.** Re-read every post at least every six months, and immediately when a claim-register entry it depends on is within 30 days of expiry (the claims gate prints that warning). The six-month interval is a team default, not a regulatory requirement.

## 7. CI gates that protect content

| Gate | Command | When it runs | Fails on |
|---|---|---|---|
| Blog schema and links | `node scripts/blog/validate.mjs` | Locally and by the blog Vite plugin | Schema, duplicate slug, broken link, heading order |
| Claim wording (certifications, SLA) | `npm run claims:check` | CI, lint-typecheck-test job | Public wording that asserts an unverified certification |
| Numeric and comparative claims | `npm run claims:gate` | CI, same job | A number or comparison with no register entry, or an expired/incomplete entry |
| Published page SEO | `npm run content:check` | CI, after `npm run build` | Missing title, description, canonical, Open Graph or JSON-LD on a published content page |
| Build gate (existing) | `npm run build` / `npm run test:built` | CI | Prerender failures, sitemap/robots problems |

## 8. Measurement

Targets are deliberately empty. They are set after a baseline exists, so none is invented here.

| Metric | Source | Baseline | Target |
|---|---|---|---|
| Posts published per month | `content/blog` `publishedAt` | **[VERIFY]** | set after 8 weeks |
| Share of trades with a playbook | section 3 table | 5 of 13 | set by Marketing lead |
| Demo/trial starts from blog CTAs | analytics **[VERIFY]** whether blog CTA clicks are tracked | none | set after tracking is confirmed |
| Claim-register entries expiring within 30 days | `npm run claims:gate` output | 0 (register is empty) | 0 |

## 9. Open items

- **[VERIFY]** Whether a scheduled deploy exists (section 1).
- **[VERIFY]** Whether the local copy has `blog:validate` in `package.json`.
- **[VERIFY]** Real author profiles to replace the `author-1` placeholder.
- **[COUNSEL]** Review of `texting-customers-consent-basics` and any later compliance post before it is marked reviewed.
- **[VERIFY]** Seasonality of each trade against Vireek's own call data (section 3, rule 3).
