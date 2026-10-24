# Google agentic-booking readiness

Status: **built up to the Google partner-approval boundary.** Everything below that boundary is
real and tested; everything beyond it is intentionally not exposed.

## What ships

| Piece | Where |
|---|---|
| Public availability feed (per business) | `supabase/functions/google-booking-feed` — `GET ?slug=<slug>&format=bundle\|availability\|services` |
| Availability engine (timezone-aware) | `supabase/functions/_shared/google-booking/availability.ts` |
| Structured data (schema.org JSON-LD) | `src/hooks/useGoogleStructuredData.ts` on `/book/:slug`, opt-in |
| GBP sync with owner approval | `gbp_sync_proposals` + `gbp_propose_sync` / `gbp_decide_proposal` / `gbp_begin_apply`, applied by `gbp-sync` |
| Owner UI | `/dashboard/google-booking` |

## Consistency with the booking engine

The feed is computed from ONE atomic DB snapshot (`get_google_feed_snapshot`) with the same rules as
`/book/:slug` (`src/lib/bookingPolicy.ts`): hours, holidays, lead time, window, duration grid, buffers,
live-job overlap. It then applies capacity on top (sum of technician `max_jobs_per_day`, minus the
emergency reserve from `capacity_demand_policies`, nothing on a "full" day). The feed can only REMOVE
slots versus the booking engine, never add (`availability.test.ts` asserts parity). Bookings are still
protected by `jobs_no_double_booking`, so a stale slot fails with `slot_taken`, never double-books.

Slots expire after 120 s (`valid_until`); `snapshot_id` changes whenever the slot set changes.

## Never publish unverified availability

The feed returns 404 (publishes nothing) unless ALL hold: owner switched the feed on, online booking
enabled, business timezone set AND valid, hours configured, at least one visible service. Switching the
feed on is refused server-side (`not_ready`) while any of those fail.

## Google Business Profile

Services and service areas are only ever *proposed*. An owner/admin approves; the approval is void if the
source data changes afterwards (`stale`). `gbp-sync` is additive (never removes or edits existing Google
service items), is off unless `GBP_APPLY_ENABLED=true`, and needs a connected
`integrations` row (`google_business_profile`: `access_token`, `refresh_token`, `expires_at`,
`location_name` = `locations/<id>`). Service areas need Google place IDs, so they are applied manually
and confirmed with "I applied it manually".

## Google program requirements (the approval boundary)

Verify against Google's current docs before each step — programs change.

1. **Actions Center / Reserve with Google (appointments)**: scheduling partners send Merchant, Service and
   Availability feeds (SFTP) and run a Booking Server Google calls to check, lease and create bookings;
   a merchant with no future availability or no service cannot go live. There is a sandbox (sandbox feed
   SFTP + sandbox booking server) that must never complete bookings against live inventory.
   Entry is via Google's partner portal and approval — not self-serve.
2. **Business Profile APIs**: access must be requested and approved for the Google Cloud project; the
   OAuth scope is sensitive and needs Google OAuth verification.
3. **AI Mode agentic booking** is rolled out with named partners and via Google's partner programs; there is
   no public self-serve switch. Local-services expansion was announced at I/O 2026.

## Go-live checklist

1. Apply to Google's partner program; record status in `/dashboard/google-booking`.
2. Adapt `format=bundle` to Google's feed spec in the sandbox (field names are Vireek-canonical, not Google's).
3. Build the Booking Server (check availability / lease / create) on top of `create_public_booking_with_settings`.
4. Request Business Profile API access, create the OAuth connection, set `GBP_APPLY_ENABLED=true`.

## Deploy

    supabase db push                      # 20271120000000_google_agentic_booking.sql
    supabase functions deploy google-booking-feed
    supabase functions deploy gbp-sync
    supabase secrets set SITE_URL=https://app.vireek.com
