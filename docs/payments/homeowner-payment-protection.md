# Homeowner payment protection — design and fill-in template

> **Status: DRAFT, feature OFF. Not legal advice.** Do not enable before licensing is confirmed (**item 100**; `TODO(owner)`: record the written
> confirmation reference). `TODO(counsel)` = needs a lawyer before customers see it.
> Code: `supabase/migrations/20290312000100_homeowner_payment_protection.sql`, `supabase/functions/payment-protection/`,
> `src/lib/paymentProtection.ts`, pages `/dashboard/payment-protection`, `/protect/:token`, `/staff/payment-protection`.

## 1. Flow
Contractor creates a protection for a job → sends the homeowner a one-time link → homeowner authorizes the card (not charged) →
work is done, contractor marks it complete (needs job completed + evidence) → homeowner confirms, **or** the review window passes with no
problem → payment is captured. Homeowner may raise a dispute any time before capture starts → staff review the job-timeline evidence →
release in full, release partially, or release the card hold.

## 2. What Stripe does and does not offer (verified against Stripe docs, 2026-11)
- Stripe **does not provide escrow** and says "escrow" has a precise legal meaning. Never use the word "escrow" in UI, emails or marketing: use "payment protection". `TODO(counsel)`: approved wording.
- **Implemented:** authorization hold — PaymentIntent `capture_method=manual`, **direct charge on the contractor's connected account**, card only.
  Funds stay reserved on the homeowner's card; Vireek never holds them. Online card holds are typically 7 days (Visa merchant-initiated: 5 days).
  Stripe reports the exact deadline as `capture_before`; we store it and never trust a fixed number. If it is missing, the hold is cancelled and the request fails.
  Extended authorizations (up to ~30 days) exist only for eligible card networks/merchant categories (`request_extended_authorization`); **not used** — `TODO(owner)` evaluate with Stripe.
- **Not implemented (by design):** separate charges and transfers / manual payouts, i.e. holding captured funds. That is what makes a platform a holder of customer funds and is the licensing question for item 100. `hold_mode` is CHECK-constrained to `auth_hold`.
- Consequence: protection only works for jobs that finish and settle inside the card-hold window. Longer jobs: `TODO(owner)` decide (staged deposits, extended auth, or licensed partner).

## 3. State machine
`draft → awaiting_authorization → held → completion_claimed → capturing → released`; side exits `voiding → voided`, `disputed`, `expired`, `failed`, `needs_review`.
Source of truth: table `payment_protection_transitions` (seed in the migration); mirrored in `src/lib/paymentProtection.ts`; a test fails if they differ.
Rules: contractor can never move funds to themselves (only homeowner, system after the window, or staff); homeowner cannot void unilaterally; terminal states are final;
every transition is row-locked, idempotent (key per event) and logged in append-only `payment_protection_events`.
Stripe side effects: commit state (`capturing`/`voiding`) → call Stripe with a deterministic Idempotency-Key → record result. Timeouts leave the state unchanged; the scheduler retries with the same key. Definitive Stripe refusals go to `needs_review` for staff — never auto-retried.

## 4. Dispute evidence
On dispute, `pp_build_evidence` snapshots the job timeline: status events (no GPS), photos (metadata, not files), checklist completions, `work_evidence` trust signals, protection events;
stored immutably with a SHA-256. Both sides add text notes. Not built: file uploads by the homeowner (`TODO(owner)`), GPS inclusion (`TODO(counsel)`: privacy).
Dispute reasons are a fixed list. Staff decide (full / partial / void) with a required note. `TODO(owner)`: who may mediate and conflict-of-interest policy; `TODO(counsel)`: terms, chargeback interaction, and what happens if the card hold expires mid-dispute (today: expires, nobody is charged, contractor falls back to normal invoicing).

## 5. Fail-closed controls (item 100 gate)
`payment_protection_controls`: `enabled=false` by default; can be enabled only with licensing ref + max amount + auto-release hours (CHECK). Kill switch stops new holds and automatic releases; expiry, void and staff resolution keep working so no hold is stranded.
The client flag `homeowner_payment_protection` (default OFF) only hides UI. Every change is audited with a reason.

## 6. Operations
- Secrets: `STRIPE_SECRET_KEY`, `SITE_URL` (existing), new `PAYMENT_PROTECTION_CRON_SECRET`, optional `PAYMENT_PROTECTION_LINK_TTL_HOURS` (default 72).
- `config.toml`: `[functions.payment-protection] verify_jwt = false` (the function authenticates JWT / token / cron secret itself).
- Scheduler (every 5 min): `POST /functions/v1/payment-protection` with header `X-Cron-Secret` and body `{"action":"tick"}`. It auto-releases, expires, retries stuck captures/voids and reconciles unreturned authorizations.
- Watch: `expiring_soon` in the tick response; holds in `needs_review`.
- Not built: Stripe webhook handling (reconciliation covers missed returns via tick), email/SMS delivery of the link (contractor copies it), notifications.

## 7. What the owner must supply
1. Licensing/counsel confirmation reference (item 100). 2. Maximum amount per hold. 3. Auto-release window (hours). 4. Approved customer-facing terms and wording (`TODO(counsel)`).
5. Dispute mediation policy. 6. Whether Vireek charges a fee (none implemented). 7. Whether to support longer jobs and how.
