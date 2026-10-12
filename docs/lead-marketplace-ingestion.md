# Lead-marketplace ingestion — setup & parsing guide

Angi · HomeAdvisor · Thumbtack · Nextdoor · Google Local Services Ads (LSA)

## How it works

```
Marketplace ──webhook──▶ lead-marketplace-ingest ─┐
Marketplace ──email────▶ <token>+<tag>@<domain> ──▶ email-webhook ─▶ handleMarketplaceEmail ─┤
                                                                                              ▼
                        parse (tolerant) → event row (idempotent) → lead row (source + cost)
                                                                                              ▼
                        auto-reply ≤ 60 s: SMS + email in parallel → response_ms recorded
                                                                                              ▼
                        Dashboard → Lead Marketplaces: cost per lead / per BOOKED job / reply SLA
```

- Lead row is created synchronously; the reply runs in `EdgeRuntime.waitUntil`, so the marketplace gets a fast 200.
- **60 s guarantee:** a deterministic template is always sent. AI personalizes the SMS only if it finishes within its time budget AND passes validation (no prices, no foreign links, names your business); otherwise the template goes out.
- SMS goes through `sendCompliantSms` (A2P gate + STOP list). If SMS is blocked, the email still goes. 9pm–8am (tenant time zone): email only; phone-only leads wait for the sweeper at 8am.
- Retries: duplicate deliveries re-attempt a failed reply (max 3 attempts); a cron sweeper recovers anything stuck.
- Duplicates: webhook + email for the same customer (same provider, same day) collapse into ONE lead. The same customer on two different marketplaces creates two leads on purpose — each marketplace charged you.

## 1. One-time deployment

1. Run the migration `supabase/migrations/20270410000000_lead_marketplace_ingestion.sql`.
2. Deploy (no JWT — external senders can't present one; the secret token is the auth):
   ```
   supabase functions deploy lead-marketplace-ingest --no-verify-jwt
   supabase functions deploy email-webhook
   ```
3. Secrets (most already exist): `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `INBOUND_EMAIL_DOMAIN`, `CRON_SECRET`, Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`) and an approved A2P campaign for SMS. AI uses the provider keys `askVireekAi` already uses.
4. Frontend env: `VITE_INBOUND_EMAIL_DOMAIN` (same domain as `INBOUND_EMAIL_DOMAIN`).
5. Schedule the sweeper (every minute):
   ```sql
   select cron.schedule('lead-marketplace-sweep', '* * * * *', $$
     select net.http_post(
       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/lead-marketplace-ingest?action=sweep',
       headers := jsonb_build_object('X-Cron-Secret', '<CRON_SECRET>')
     );
   $$);
   ```

## 2. Required parsing setup (per marketplace)

> The marketplaces' payloads and emails are partner-private and change without notice. The parsers are tolerant by design, but **you must verify each marketplace with one real lead** before relying on it. Nothing here was verified against live production traffic.

Open **Dashboard → Lead Marketplaces → Connect marketplaces**, enable the provider, set the default cost per lead, and save. Each card then shows a **webhook URL** and a **forwarding email address**.

### A. Webhook (preferred when the marketplace offers it)
- Paste the webhook URL into the marketplace's lead/webhook settings (Thumbtack and Angi offer partner/API webhooks; availability depends on your account — ask your rep). If it lets you set a header, send the token as `X-Vireek-Token: <token>` or `Authorization: Bearer <token>` instead of `?token=` (URLs end up in logs).
- Zapier / Make can forward any marketplace's notification as JSON to the same URL.
- JSON or form-encoded bodies are accepted. Keys are matched case/punctuation-insensitively at any depth (`LeadPrice` = `lead_price` = `price.amount`).

### B. Email forwarding (works for all five, incl. Google LSA)
1. In your mailbox (Gmail / Outlook), create a rule: *from the marketplace's notification sender → forward to* the address on the card, e.g. `a1b2c3d4e5f6+angi@in.yourdomain.com`.
2. The `+angi` / `+homeadvisor` / `+thumbtack` / `+nextdoor` / `+lsa` tag tells Vireek the source even when forwarding hides the original sender.
3. Gmail requires confirming a forwarding address: the confirmation email arrives in **Inbox → Unified Inbox** (it is not a marketplace lead, so it falls through). Open it and click the link.
4. Cost: if the email states a price (e.g. "You were charged $38.00"), it is parsed. Otherwise your **default cost per lead** is applied and shown as "(default)".

### C. Verify with a real lead
- Wait for / trigger one lead, then check the Recent activity table: status `lead created`, correct cost, auto-reply `sent`.
- Or test now with curl (replace URL):
  ```
  curl -X POST "<webhook URL>" -H 'Content-Type: application/json' \
    -d '{"FirstName":"Test","LastName":"Lead","PhoneNumber":"+15551234567","Email":"you@yourdomain.com","Category":"Plumbing","Description":"Test lead","LeadPrice":"$40.00"}'
  ```

### D. If a notification does not parse
Failures never lose a lead: the email still lands in your Unified Inbox and a `parse_failed` event stores the raw sample for 30 days.
```sql
select provider, received_via, parse_error, raw_payload
from lead_marketplace_events where status = 'parse_failed' order by received_at desc limit 5;
```
Then extend the parser (no other code changes needed):
- **Webhook field not recognized** → add its normalized name (lowercase, letters/digits only) to the matching alias list in `parseWebhookPayload` in `supabase/functions/_shared/lead-marketplace/parsers.ts`.
- **Email label not recognized** → add the label text to the matching regex in `LABELS` (same file). Add the sample as a test in `parsers.test.ts`.
- **Sender not detected** → add its domain to `PROVIDER_DOMAINS`.

Warnings you may see on events: `phone_from_body_scan` / `email_from_body_scan` (no labeled field; fell back to scanning the body), `no_contact_info` (no phone/email → lead created, no auto-reply), `cost_unparseable_or_out_of_range`.

## 3. Reporting definitions

- **Cost per lead** = known spend ÷ leads received in the period.
- **Booked** = lead has ≥ 1 non-cancelled job, linked by `jobs.lead_id` **or** the same phone (last 10 digits) on a job created after the lead arrived.
- **Cost per booked job** = known spend ÷ **booked leads** (a lead with 3 jobs counts once; total jobs are shown separately).
- **Paid revenue** = `invoice_amount` of booked jobs with `invoice_status = 'paid'`.
- **Reply time** = from Vireek receiving the lead to the first successful SMS/email send (not from the customer's submission on the marketplace, which Vireek cannot observe).
- Cohort rule: only leads received in the window; bookings after the window end are not counted.
- Leads with unknown cost are flagged; spend is understated when any exist.

## 4. Compliance notes (not legal advice)

- First replies are explicitly marked automated and the SMS carries STOP language; STOP replies are honored by the existing suppression list.
- Check each marketplace's terms about contacting leads outside their platform and about auto-responses; some require responses inside their messaging.
- Customer replies to the email thread arrive in the Unified Inbox via the tenant alias; SMS replies via the existing SMS webhook.

## 5. Tests

```
npm test -- lead-marketplace leadMarketplace
```
Covers: phone/money/email normalization, provider detection (incl. forwarded mail and alias tags), webhook + email parsing per marketplace shape, dedupe, the full pipeline (idempotency, SLA budget, SMS→email fallback, quiet hours, retry cap, dead-worker recovery, AI fallback/validation, parse-failure pass-through) and the report math.
