# Direct Mail (postcard) channel

Print-and-mail postcards through **Lob**, with a unique QR code + offer code on every mailer, attribution through the
existing landing pages, and cost-per-booked-job reporting. Dashboard: `/dashboard/direct-mail` (account owner, or team
members with billing access).

## Audience, address check, cost estimate
- **Audience:** campaign → "Add from a saved audience" uses your Audiences (customer segments only; leads have no address). `marketing_opt_in` is not filtered (postal mail does not need it).
- **Address check:** "Check addresses" calls Lob US verification. Live key: undeliverable addresses are removed from the send (not printed, not charged). Test key: results are shown but nothing is removed.
- **Cost estimate:** mailers × your per-mailer estimate, against the budget cap; Lob's real price replaces it after sending.

> **Status: not live-verified.** Built from Lob's documentation and tested against mocks only. Send 2–3 test-mode proofs before the first live mailing.

## How attribution works
1. Every mailer gets a 9-symbol code (8 random + 1 check symbol, no I/L/O/U), e.g. `7QX2-M9PD-K`.
2. The QR code is `{SITE_URL}/m/{CODE}`. Scanning records one scan, then redirects to
   `/lp/{slug}?utm_source=direct_mail&utm_medium=postcard&utm_campaign=dm-{8 hex}&utm_content={code lowercase}`.
3. The existing landing-page analytics store those UTMs on `landing_page_events`. The report joins
   `utm_content = lower(tracking_code)` (plus source/medium) to find leads/bookings, and follows `jobs.lead_id` to jobs.
4. Phone/walk-in responses are logged in **Results → Log a response** by typing the code printed on the card.
5. **Booked job** = non-cancelled job reachable from a mailer (counted once per campaign). **Revenue** = `invoice_amount`
   of completed attributed jobs. **Cost** = Lob's `price` per submitted mailer (falls back to your per-mailer estimate and is
   marked with `*`).

Limits to know: UTM attribution is spoofable by anyone who edits a URL (same as every UTM system); a person who scans,
leaves, and books by phone without the code is not attributed.

## Credentials / configuration

| What | Where | Required | Notes |
|---|---|---|---|
| `DIRECT_MAIL_KEY` | Supabase secret | **Yes** | 32 random bytes, base64: `supabase secrets set DIRECT_MAIL_KEY=$(openssl rand -base64 32)`. Encrypts each account's Lob key + webhook secret (AES-256-GCM). Losing it makes stored keys unreadable; users re-enter them. |
| `SITE_URL` | Supabase secret | **Yes** | Public origin used inside QR codes (e.g. `https://vireek.com`). It is printed on paper — never change the domain without keeping `/m/:code` working. |
| `LOB_API_VERSION` | Supabase secret | No | Pin a Lob API version (`Lob-Version` header). |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase (automatic) | Yes | |
| `VITE_SUPABASE_URL` | Vercel | Yes (already set) | Used to display the webhook URL. |
| Lob **API key** (`test_…` / `live_…`) | Entered per business in **Direct mail → Setup** | **Yes** | From Lob dashboard → Settings → API Keys. Each business uses its own Lob account/billing. Use `test_` first: proofs only, nothing mailed or charged. |
| Lob **webhook signing secret** | Entered per business in **Setup** | Strongly recommended | Lob dashboard → Settings → Webhooks → add the URL shown in Setup, events: postcard mailed / in_transit / in_local_area / processed_for_delivery / re-routed / delivered / returned_to_sender / failed. Without the secret every webhook is rejected (fail closed) and statuses stay at "Sent to printer". |

Lob account prerequisites (their side): verified account, US return address, payment method for live mode, and (for
marketing mail) a registered business/brand per Lob's current requirements.

## Deploy
```bash
supabase db push                                   # migration 20271102000000_direct_mail_channel.sql
supabase secrets set DIRECT_MAIL_KEY=$(openssl rand -base64 32) SITE_URL=https://vireek.com
supabase functions deploy direct-mail-settings
supabase functions deploy direct-mail-send
supabase functions deploy direct-mail-verify
supabase functions deploy direct-mail-webhook --no-verify-jwt   # public: protected by token + HMAC signature
```

## Safety properties
- Pieces are claimed atomically (`FOR UPDATE SKIP LOCKED`); each print request carries `Idempotency-Key = piece id`, so
  retries/crashes cannot mail a household twice. Sending is chunked and resumable.
- A budget cap pauses sending *before* it would be exceeded; a rejected API key pauses the campaign immediately.
- Duplicate addresses and the do-not-mail list are skipped. Only draft campaigns can be edited.
- API keys never reach the browser (no table grants; encrypted at rest). Reads are RLS-scoped to the account owner + managers.

## Verify before the first live send
1. Send 2–3 pieces in **test mode**, open each **Proof** PDF: check QR scans, nothing overlaps the address block (artwork
   reserves a conservative back-side zone; Lob's exact template may differ slightly per size).
2. Scan with a phone → you land on your landing page; a lead submitted there shows up under Results.
3. Confirm the webhook: after mailing in live mode statuses move to *In the mail* / *Delivered*.
