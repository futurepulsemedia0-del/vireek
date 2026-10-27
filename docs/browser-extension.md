# Chrome extension: click-to-call + quick lead capture

Code: `chrome-extension/` (Manifest V3, no build step) · API: `supabase/functions/browser-extension` ·
Pure logic + tests: `supabase/functions/_shared/browser-extension/` · Table: `browser_extension_events`.

## How it works

- **Auth:** the popup signs in with Supabase Auth (email + password, TOTP MFA supported). Tokens live only in the
  service worker (`chrome.storage.local`); content scripts never see them. The edge function verifies the JWT,
  resolves the tenant with `get_account_owner_id()` and rejects aal1 sessions of MFA-enrolled users.
- **Lead capture:** `capture_lead` normalises input, de-duplicates by phone variants / email, inserts into `leads`
  through the caller's client (RLS applies) with `source = 'chrome_extension'`. Only the page origin + path is stored
  (query/hash stripped). Retried requests are idempotent (`request_id`).
- **Click-to-call (callback bridge):** the agent's phone (`pbx_extensions.mobile_e164`, else `profiles.phone`) rings
  first; when answered Twilio dials the customer showing the business number (`pbx_lines` caller ID, else an active
  `phone_numbers` row). Gates, in order: E.164 + premium/service-code block, country allow-list
  (`pbx_settings.outbound_country_codes`), self-call guard, rate limit (5/min, 150/day per user), DNC list, quiet hours
  (`gateOutbound`), verified caller ID.

## Deploy

1. Run `supabase/migrations/20271215000000_browser_extension.sql` (safe to run twice).
2. `supabase functions deploy browser-extension` (keep JWT verification ON; no `--no-verify-jwt`).
3. Secrets already used by the phone system must exist: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `SITE_URL`.
4. Optional retention: `select cron.schedule('browser-extension-events-prune','23 3 * * *',$$ select public.browser_extension_events_prune(180); $$);`

## Build the extension

1. Copy `public/web-app-manifest-192x192.png` to `chrome-extension/icons/icon.png`.
2. Edit `chrome-extension/lib/config.js` (Supabase URL, anon key, app URL).
3. Chrome > `chrome://extensions` > Developer mode > **Load unpacked** > select `chrome-extension/`.
4. Store release: zip the _contents_ of `chrome-extension/` without `*.test.js`, upload to the Chrome Web Store.

## Known limits

- If the agent's phone goes to voicemail within 22 s, the bridge can reach the voicemail; keep the ring timeout.
- The first call from a new Twilio number needs a verified/owned caller ID (error `caller_id_not_verified`).
- Tests: `npx vitest run chrome-extension supabase/functions/_shared/browser-extension src/lib/browserExtensionMigration.test.ts`.
