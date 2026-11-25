# Permit submission

## What works today (manual tracking)
Per job: create a permit application, pick the authority (jurisdiction, portal system, fees notes), keep a document checklist, file on the authority's own portal or by email/mail/in person, then record the reference number, fee, status changes and inspections. Status changes go through `transition_permit_application` (state machine + immutable timeline).

## Model
| Need | Where |
|---|---|
| Jurisdiction | `permit_authorities` (state, city, county, portal system, submission method) |
| Type, status, fees | `permit_applications` (`permit_type`, `status`, `fee_amount`, `fee_paid_at`) |
| Documents | `permit_documents` (this change) |
| Portal adapters | `src/lib/permitPortals.ts` (Accela, OpenGov stubs) |

## Stubs
`accelaAdapter` and `openGovAdapter` are never connected and never report success. `resolveSubmissionMode()` returns `manual` for every system today.

## Before a real adapter
`TODO(owner)`: per-authority API access and vendor credentials, stored server-side only (edge function, never the client). Map portal statuses to `PermitStatus`. Verify against the authority's real API before enabling `connected`.
