# Listings (`/dashboard/listings`) — integrations & required keys

Listing Sync keeps each business location's public directory listings identical to ONE source of truth:
`business_locations` (name, address, phone, hours) + the account's website/description (`listing_settings`).

The feature works with **zero keys**: every link runs in *Copy & paste* mode (copy-ready record, a daily
"your details changed" reminder via the link state, and a confirm button). Each provider below is an **API
boundary** (`supabase/functions/_shared/listings/providers.ts`): it fails closed until its keys are set, and
writes stay OFF until the matching `*_PUSH_ENABLED` flag is `true`. Provider calls are **not live-verified** —
test each against a real account before announcing it.

## What each directory can do

| Directory | Read (drift check) | Write (auto-update) | Connect |
|---|---|---|---|
| Facebook Pages | yes | phone, website, address, hours (not the Page name) | OAuth (owner) |
| Yelp Fusion | yes (no website field) | no — owner edits on Yelp | business link/alias + API key |
| Apple Business Connect | yes (partner API) | yes, partner access only | Vireek partner credentials + Apple location ID per location |
| Bing Places | yes (partner API) | yes, partner access only | Vireek partner credentials + store code per location |

Modes: **push** (writes + daily verify) · **monitor** (daily verify only) · **manual** (copy & paste + confirm).

## Secrets (`supabase secrets set …`)

| Secret | Used for |
|---|---|
| `LISTINGS_STATE_SECRET` | HMAC signing of the Facebook OAuth `state` (any long random string) |
| `LISTINGS_CRON_SECRET` | `X-Cron-Secret` for `listings-sync` |
| `ADS_TOKEN_ENCRYPTION_KEY` | already set — encrypts stored Page tokens |
| `META_APP_ID` / `META_APP_SECRET` / `META_GRAPH_VERSION` | already used by Demand OS / Reputation |
| `FACEBOOK_LISTINGS_PUSH_ENABLED` | `true` only after Meta approves `pages_manage_metadata` |
| `YELP_API_KEY` | already used by Reputation |
| `APPLE_BC_CLIENT_ID` / `APPLE_BC_CLIENT_SECRET` / `APPLE_BC_TOKEN_URL` / `APPLE_BC_API_BASE` | Apple Business Connect partner API |
| `APPLE_BC_PUSH_ENABLED` | `true` only after Apple grants write access and the adapter is verified |
| `BING_PLACES_API_KEY` / `BING_PLACES_API_BASE` | Bing Places partner API |
| `BING_PLACES_PUSH_ENABLED` | `true` only after Microsoft grants write access and the adapter is verified |
| `SITE_URL` | post-OAuth redirect (defaults to https://vireek.com) |

## Provider setup

**Facebook** — In the Meta app (Facebook Login) add the redirect URI
`https://<project-ref>.supabase.co/functions/v1/listings-oauth-callback`. Scopes `pages_show_list`,
`pages_read_engagement`, `pages_manage_metadata` need **App Review**. Until approved, leave
`FACEBOOK_LISTINGS_PUSH_ENABLED` unset: Facebook then runs in monitor mode.

**Yelp** — Same Fusion key as Reputation. Fusion is read-only, so Yelp is always monitor mode.

**Apple / Bing** — Partner-only. Before setting `*_PUSH_ENABLED=true`, confirm the real endpoint paths and
field names with the partner documentation and adjust `partnerRequest()` + `engine.toPartnerPayload()` /
`normalizePartnerRemote()` (the only places that know the shape).

## Deploy

```
supabase db push
supabase functions deploy listings
supabase functions deploy listings-oauth-callback --no-verify-jwt
supabase functions deploy listings-sync --no-verify-jwt
```

## Schedule (hourly)

```sql
select cron.schedule('listings-sync', '15 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/listings-sync',
    headers := jsonb_build_object('X-Cron-Secret', '<LISTINGS_CRON_SECRET>', 'Content-Type', 'application/json'),
    body := '{}'::jsonb);
$$);
```

## Safety notes
- Tokens are AES-encrypted in `listing_connection_credentials` (RLS on, no policies → service role only).
- Clients can never write link state: every write goes through the service-role edge functions.
- A listing is never published while required details are missing (name, address, city, postal code, phone, valid hours).
- Editing a location flips its links to "Update needed" (DB trigger); a changed record is pushed on the next run.
- After a push, a still-mismatching listing is not re-pushed for 6 hours (platform moderation), then retried.
- Every push / check / confirmation is stored in `listing_sync_events` (pruned after 90 days).
