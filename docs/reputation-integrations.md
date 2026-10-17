# Reputation (`/dashboard/reputation`) — integrations & required keys

The feature works with **zero keys** (staff log reviews manually, AI/template drafts, trends, alerts).
Each provider below is an **API boundary**: it fails closed (`NOT_CONFIGURED`) until its keys are set, and the
provider calls are **not live-verified** — test each against a real account before announcing it.

## What each provider can do

| Platform | Import reviews | Post reply via API | Connect |
|---|---|---|---|
| Google Business Profile | yes | yes | OAuth |
| Yelp Fusion | up to 3 excerpts | no (owner posts on Yelp, then marks replied) | business id/alias, API key |
| Facebook Pages | recommendations | no (manual) | OAuth |

## Secrets (`supabase secrets set …`)

| Secret | Used for |
|---|---|
| `REPUTATION_STATE_SECRET` | HMAC signing of the OAuth `state` (any long random string) |
| `REPUTATION_CRON_SECRET` | `X-Cron-Secret` for `reputation-sync` |
| `ADS_TOKEN_ENCRYPTION_KEY` | already set for Demand OS — encrypts stored tokens |
| `GOOGLE_BUSINESS_CLIENT_ID` / `GOOGLE_BUSINESS_CLIENT_SECRET` | Google OAuth client |
| `YELP_API_KEY` | Yelp Fusion key |
| `META_APP_ID` / `META_APP_SECRET` / `META_GRAPH_VERSION` | already used by Demand OS |
| `SITE_URL` | post-OAuth redirect (defaults to https://vireek.com) |

## Provider setup

**Google** — Enable *My Business Account Management*, *My Business Business Information* and the legacy *My Business API (v4, reviews)* in Google Cloud. Request Business Profile API access (approval is required by Google). OAuth scope `https://www.googleapis.com/auth/business.manage`. Authorized redirect URI:
`https://<project-ref>.supabase.co/functions/v1/reputation-oauth-callback`.

**Facebook** — In the Meta app add *Facebook Login*, same redirect URI. Scopes `pages_show_list`, `pages_read_engagement`, `pages_read_user_content` need **App Review**.

**Yelp** — Create a Fusion app, set `YELP_API_KEY`. Yelp returns at most 3 review excerpts and has no reply API.

## Deploy

```
supabase db push
supabase functions deploy reputation
supabase functions deploy reputation-oauth-callback --no-verify-jwt
supabase functions deploy reputation-sync --no-verify-jwt
```

## Schedule (every 2 hours)

```sql
select cron.schedule('reputation-sync', '0 */2 * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/reputation-sync',
    headers := jsonb_build_object('X-Cron-Secret', '<REPUTATION_CRON_SECRET>', 'Content-Type', 'application/json'),
    body := '{}'::jsonb);
$$);
```

## Safety notes
- Tokens are AES-encrypted in `review_connection_credentials` (RLS on, no policies → service role only).
- Review text is untrusted: fenced in the AI prompt, output parsed + length-bounded, risky replies get UI warnings.
- Alerts only fire for reviews ≤ 14 days old and at/below the account's threshold.
- AI drafts are rate limited (40/hour/account) and always fall back to a labelled template.
