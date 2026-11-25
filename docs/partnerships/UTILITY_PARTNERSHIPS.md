# Utility partnerships — operations sheet

Everything below is a fill-in template. Nothing here is a fact about any utility. DB mirror (status + agreement reference only): `utility_partnerships` (staff-only). **Do not store personal contact details in the database.**

## How the system uses a utility program
Territory (`utility_territories`, `incentive_programs.postal_prefixes`) → eligibility (Rebate Intelligence engine) → enrolment (`contractor_program_enrollments`) → submission rules (`utility_program_submission_profiles`) → tracking (`rebate_applications` + `rebate_application_events`).

## Per-utility record (copy one block per utility)
- Utility name: TODO(owner)    State(s): TODO(owner)    Service territory source / date: TODO(owner)
- Partnership status: prospect / in_discussion / agreement_signed / live / paused / ended
- Agreement: reference TODO(owner) · signed date TODO(owner) · term / renewal TODO(owner) · data-sharing terms TODO(counsel)
- Programs covered (incentive_programs.slug): TODO(owner)
- Contractor enrolment: who can enrol (Vireek vs each contractor) TODO(owner) · process TODO(owner) · renewal cadence TODO(owner)
- Submission: method (online_portal / email / mail / partner_api / point_of_sale / contractor_portal) TODO(owner) · URL TODO(owner) · deadline days after completion TODO(owner) · required documents TODO(owner)
- Pre-approval needed: TODO(owner) · lead time TODO(owner)
- Payout: to customer / to contractor TODO(owner) · typical timing TODO(owner) (the engine learns realisation from real outcomes; do not enter estimates here)
- Funding status source and check cadence: TODO(owner)
- Contacts (keep in the shared contacts system, not here): program manager TODO(owner) · contractor-enrolment desk TODO(owner) · escalation TODO(owner)

## Compliance checklist
- [ ] TODO(counsel): agreement template, data-sharing and customer-consent wording, marketing/endorsement limits
- [ ] TODO(counsel): rules on contractor-submitted rebates and fees in each state
- [ ] TODO(owner): who verifies program details and how often (`incentive_programs.last_verified_at`)

## Review cadence
Weekly: overdue / stale submissions (from `summarizeApplications`). Monthly: funding status and deadlines per live partner. Quarterly: re-verify every submission profile.
