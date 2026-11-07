
Vireek × FM Portals — Feasibility Memo (Phase 0)
Preparation date: 2026-11-04

Status: Research and decision-making only. No integration code has been written.

This document is not legal advice. Items marked with ⚖️ must be referred to a lawyer.

Labels: VERIFIED = read from an official source as of this date. UNVERIFIED = unofficial or incomplete source. INACCESSIBLE = access was unavailable.

1. Go / No-Go Recommendation
Path

Decision

Condition

A. “Guard v2”: Expand the existing Work-Order Guard with an fm_submission surface in the compliance-rules engine, manual CSV/email ingestion, a “Fix before sending” list, and a “Money at risk” view

GO

No dependency on APIs or platform terms of service. The owner provides the data.

B. Read the official ServiceChannel API

NO-GO for now

1) Lawyer's opinion on Section 3.3 of the WSI agreement ⚖️ 2) Written confirmation from a ServiceChannel representative explaining how a third-party SaaS can obtain a client_id 3) Clarification of costs

C. Corrigo (CorrigoPro Direct)

Deferred

Subscription and representative contact required. Pricing is not published.

Scraping, storing user passwords, credential-sharing forms

PERMANENT NO-GO

As instructed by you.

Primary rationale: Path A offers the greatest value and can be delivered without legal risk. The API is only valuable if we want to retrieve rejection reasons automatically, which can be added later.

2. Existing Code Audit (From the Uploaded ZIP; May Differ From Your Local Version)
Important finding: The assumption that “Vireek only has PM” is not accurate. The Work-Order Guard module already exists in the ZIP and covers a substantial part of Phase 1.

Item

File

Status

Editable portal rules

src/lib/workOrderGuard.ts (PortalRules, SERVICECHANNEL_DEFAULTS, evaluateOrder, runAudit)

Exists, WO-oriented input

CSV import and batch deletion

src/lib/workOrderGuardImport.ts, wog_import_batches

Exists

Tables and security

supabase/migrations/20280215000000_work_order_guard.sql (RLS SELECT-only, writes through RPC, owner determined server-side)

Exists

outcome_reason for rejections

Same migration

Exists (free text)

Bank deposit matching

workOrderGuardMatching.ts

Exists

Sync security (AES-GCM encryption, host allowlist, retry queue, watermark)

supabase/functions/pm-sync-run, _shared/pm/engine.ts

Exists, PM only

Regulation-as-code engine

_shared/compliance-rules/

Exists, jurisdiction-based

Incompatibilities to resolve in Phase 1:

The compliance-rules engine is based on state/jurisdiction (jurisdiction). FM rules are platform/customer-based. A new dimension (portal/customer) is needed, not just a new surface.

The database surface field has a CHECK constraint limited to ('call','sms','email','quote','contract') in 20271110000000_compliance_rule_packs.sql. Adding fm_submission requires a migration.

Existing PortalRules is a flat object without citations, versions, or review status. It must be migrated to a typed Rule Pack, and the old code must be removed (following the “no parallel systems” principle).

Current evaluation covers only invoices/WO. It does not evaluate proposals.

Decision required from you (Section 8): Migration of PortalRules to the compliance-rules engine.

3. Validation of Existing Rules Against the Official 2026 Guide
Source: ServiceChannel Trade Partner 2026 Guide for Success (uploaded file dated 2025-10), reviewed on 2026-11-04. VERIFIED

https://servicechannel.com/wp-content/uploads/2025/10/Trade-Partner-Guidelines-2026.pdf

Existing code rule

Guide status

Notes

30-minute acceptance / 15-minute emergency acceptance

Confirmed (p. 8)

¼-mile check-in radius

Confirmed (p. 12)

Check-in only after proposal approval

Confirmed (p. 10)

Invoice within 10 days

Confirmed (pp. 9, 15)

Starting point: Completed/Confirmed status, not completion date. Code uses completedAt. A confirmedAt field is required. The ServiceChannel educational page calls this a “best practice.”

Invalid after 90 days

Confirmed (p. 15)

Another page says “may be ineligible.” The 90-day starting point is not consistent across texts. UNVERIFIED

One invoice per WO

Confirmed (p. 15)

Invoice ≤ NTE

Confirmed (p. 15)

ServiceChannel documentation states that submission above NTE is not possible. See Section 4.

Breakdown: labor, techs, materials, trip, freight

Confirmed (p. 15)

Some customers require more detailed itemization (SC University documentation).

allowSalesTax = false

Incomplete

The prohibition applies only when invoicing through ServiceChannel. Tax is permitted when invoicing the end customer directly. A single boolean is insufficient.

allowManagementFee = false

Incorrect terminology

The guide refers to “New Business Fees,” not management fees. Proposals containing them are automatically rejected. The rule also applies to proposals.

New rules in the guide that are missing from the code:

Proposal within 48 hours (24 hours for emergencies), with prompt submission (p. 10).

Mandatory proposal content: diagnosis description, before/after photos, part with serial number, itemization of miscellaneous items above $25 (p. 13).

Subcontractor invoice attachment (p. 15).

Proposal pricing valid for up to 30 days (p. 14).

Decline reason is mandatory (p. 6).

Scope warning: This guide applies to the ServiceChannel Managed (SCM) program. Non-SCM customers have their own rules (“Manage Client Requirements” in the portal). Therefore, the Rule Pack must be customer-specific, not a universal ServiceChannel package.

4. Platforms
4.1 ServiceChannel
Topic

Finding

Status

API

REST v3, OAuth 2.0, Swagger, Sandbox2 environment (sb2api.servicechannel.com)

VERIFIED — https://developer.servicechannel.com/basics/introduction/overview

Data coverage

Work order, proposal, invoice, location, asset

VERIFIED (SC University documentation)

App registration

Requires a Subscriber Super Admin or Provider admin account; client_id and client_secret are obtained from the App Registration page

VERIFIED — https://developer.servicechannel.com/basics/general/app-registration

Approval time

Unofficial source says 1–3 days; official documentation does not mention manual approval

UNVERIFIED (supergood.ai)

Integration section in Provider Automation

Must contact a ServiceChannel representative to activate

VERIFIED (SC University)

Authentication

Two grants: authorization code and password. Authorization code works without sharing passwords.

VERIFIED — developer.servicechannel.com/basics/general/authentication

Token

10-minute lifetime. Token request: once every 5 seconds per user

VERIFIED

Rate limit (Production)

300/minute per client_id, 600/minute per company. May change without notice.

VERIFIED — developer.servicechannel.com/basics/general/throttling

Duplicate prevention

10-second timeout for duplicate POST/PUT requests

VERIFIED

Webhooks

Configurable for WO, proposal, and invoice through Provider Automation

VERIFIED (SC University). Exact event count (unofficial source: ~28) UNVERIFIED

Invoice rejection reason via API

Unknown. Status Rejected exists and the customer rejects with a comment. Whether the comment/reason field is readable by providers through the API is unconfirmed

UNVERIFIED (Swagger not reviewed)

Status and NTE via API

WO status, NTE, proposal, NTE changes (history) exist in data models

VERIFIED (Data Direct tables) — provider-side access unconfirmed

Cost

ServiceChannel states that providers have a “tiered based on annual usage” plan. Pricing could not be accessed.

INACCESSIBLE

Official ISV partner program

A Solution Partner program exists (older article). ServiceTitan is a “Gold Partner.” Entry requirements for us could not be found.

INACCESSIBLE

ServiceTitan approach (observation, not recommendation): Their help page (updated 2026-10-15) asks customers to enter a ServiceChannel user's email and password, along with the Client ID/Secret, into a Google form. We will not copy this approach. Whether ServiceChannel's terms prohibit it: unknown. ⚖️

Limited competitor evidence: The same page mentions only sending NTE to a custom field, status mapping, and invoice mapping. It does not mention pre-submission validation. Absence from one page is not proof that the feature does not exist.

Competitive risk: ServiceChannel itself sells a customer-side “Decision Engine” and invoice/NTE validation, and states that invoices exceeding NTE cannot be submitted. Therefore, part of our “Fix before sending” functionality is already handled by the portal itself. Our actual value: before work starts/parts are ordered (the initial proposal), 10/90-day deadlines, customer-specific rules, and a consolidated multi-customer view (Money at risk).

4.2 Terms of Service (ToS) ⚖️
Source: Web Services Integration Terms of Service, last updated 2025-08-11. https://servicechannel.com/wsi-terms-of-service/ — VERIFIED

Note: This agreement applies to a customer who signs a Product Order Form. Whether it applies specifically to a third-party SaaS connecting through the developer portal has not been confirmed. Separate developer terms could not be found (INACCESSIBLE).

Clauses presenting risks:

3.3(a): Prohibits using the service or content “for the benefit of anyone other than the customer and its affiliates.”

3.3(b): Prohibits placing content in a “service bureau or outsourcing offering.” A multi-tenant SaaS could fall under this provision.

3.3(i): Prohibits access “to build a competing product.” ServiceChannel itself offers “ServiceChannel AI” and provider tools.

2.2: ServiceChannel may discontinue support for an integration with 30 days’ notice.

10.11: Terms may be changed unilaterally and even retroactively.

5.2: ServiceChannel reserves the right to use de-identified data.

Cross-customer rejection learning (aggregating rejection reasons from the portal) directly touches clauses 3.3(a)/(b). This is not an issue in Path A because the owner enters their own data and uses it only for themselves. Cross-owner aggregation will not be implemented in Phase 1 unless approved by a lawyer.

4.3 Corrigo (JLL)
Two APIs exist: CorrigoPro Direct (contractor-side) and Corrigo Enterprise. OAuth 2.0 and a sandbox environment. — VERIFIED (developer.corrigopro.com)

Events include NTE changed, Quote changed, Invoice status changed, Technician checked in/out. — VERIFIED

Activation: CorrigoPro Direct subscription and contact with a Corrigo representative required. — VERIFIED (2019 guide, outdated)

Pricing and approval time: INACCESSIBLE (users have asked the same questions in forums).

Contractor API invoice statuses are fewer than Enterprise statuses (3–4 versus 7) — developer report, UNVERIFIED.

Customer-specific documented rules (such as the official ServiceChannel guide) were not found.

4.4 Other Platforms
Fexa, ServiceTrade, and other FM portals: not researched. (ServiceTrade has public developer terms, but it is contractor-side software, not a customer portal.)

5. Data Audit (Owner's 6 Months of Invoices)
What already exists: CSV import, outcome and outcome_reason, runAudit with CSV export, deletable batches. (Read from files; import logic was not reviewed line by line.)

What is missing:

Structured categorization of rejection reasons (currently free text). Mapping to ruleKey.

Aging buckets: 0–10, 11–30, 31–60, 61–90, and over 90 days from Completed/Confirmed.

PDF ingestion: existence was not confirmed (UNVERIFIED). Recommendation: start with CSV + manual rejection-reason entry. PDF only after owner confirmation of extracted text.

Metrics to report (all based on owner data = measured; estimates separately labeled):

Number and amount of rejected / voided / expired / ineligible invoices.

Rejection rate by reason and by customer.

Time distribution between Completed/Confirmed and invoice submission.

Outstanding amount in each aging bucket.

Resubmission cycle time after rejection (a rejected invoice cannot be edited and requires a new number — SC University).

Privacy: Only that owner's data (user_id = account owner), no cross-owner aggregation, deletion by deleting the batch.

6. List of Items Not Accessible
API reference Swagger (exact rejection reason/comment fields).

ServiceChannel integration plan pricing.

Dedicated ServiceChannel developer terms (if separate).

Requirements for entering the ServiceChannel partner program.

CorrigoPro Direct pricing and approval time.

Fexa and other platforms.

Full January 2025 printed guide (only values were compared against the 2026 edition).

How Vireek, as a multi-tenant SaaS, can obtain a client_id (app registration requires a provider/subscriber account).

7. Risks
⚖️ Section 3.3 of the WSI agreement and uncertainty about whether it applies to us.

⚖️ Customer credential storage: Path B must use OAuth authorization code only, without storing passwords.

Customer-specific rules: a “ServiceChannel” package may be incorrect for a non-SCM customer. Unapproved rules remain drafts and must never block submissions.

Overlap with the portal's own validation. Our value must be in timing and financial visibility.

Rate limits can change without notice. Backoff and respect for Retry-After are required.

This ZIP may differ from your local version. Local files must be reviewed before Phase 1.

8. Decisions Required From You
Approve Path A (Guard v2, no API) to start Phase 1?

Migrate PortalRules to the compliance-rules engine with a new portal/customer dimension and fm_submission surface (migration on CHECK)? Or should Guard remain independent for now, with only a Rule Pack built on top of it? (My recommendation: migrate, because you requested “no parallel systems.”)

Path B: Do you authorize me to prepare a draft email to the ServiceChannel representative (questions from Section 6)? You will send it yourself.

First Rule Pack: Only “ServiceChannel Managed 2026,” or do you also have a specific customer in mind?

Lawyer: Is there someone who can review Section 3.3?

9. Sources (All Reviewed on 2026-11-04)
ServiceChannel Trade Partner 2026 Guide for Success — https://servicechannel.com/wp-content/uploads/2025/10/Trade-Partner-Guidelines-2026.pdf

ServiceChannel Developer Portal: Overview, App Registration, Authentication, Throttling, Requests, Sandbox Mode — https://developer.servicechannel.com/basics

ServiceChannel WSI Terms of Service (2025-08-11) — https://servicechannel.com/wsi-terms-of-service/

SC University (provider): Invoices, Creating an Invoice, API Integration — https://servicechannel.atlassian.net/wiki/spaces/SCUCP/pages/614924513/Invoices

ServiceChannel Integration Services — https://servicechannel.com/services-providers/integration-services/

ServiceChannel “Get paid faster” — https://servicechannel.com/learning-channel/get-paid-faster/

ServiceTitan Help: Set up ServiceChannel Integration (2026-10-15) — https://help.servicetitan.com/construction/docs/set-up-servicechannel-integration.md

CorrigoPro Direct API docs — https://developer.corrigopro.com/docs/working-with-invoices

CorrigoPro Direct Getting Started Guide (2019) — https://help.corrigopro.com/wp-content/uploads/2019/07/CorrigoPro-Direct-Getting-Started-Guide.pdf

supergood.ai API Report Card: ServiceChannel (unofficial, 2026-07) — https://supergood.ai/api-report-card/servicechannel
