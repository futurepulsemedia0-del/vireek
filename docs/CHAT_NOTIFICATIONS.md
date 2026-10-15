# Slack & Microsoft Teams notifications

Events → Postgres triggers → `chat_events` outbox → `chat-notify-dispatch` → Slack / Teams.
Buttons (Acknowledge / Assign) come back through `chat-slack-webhook` and `chat-teams-bot`, then every delivered copy of the message is re-rendered so Slack and Teams always agree.

| Event | Source | Buttons |
|---|---|---|
| Emergency call | `calls.is_emergency` becomes true | Acknowledge, Assign |
| Missed call | `calls.status` becomes `missed` | Acknowledge, Assign |
| New job | `jobs` insert | Assign |
| Job completed | `jobs.job_status` becomes `completed` | – |
| Low CSAT | `call_feedback.rating` ≤ route threshold (default 2) | Acknowledge |
| Payment failed | `payment_requests.status` = `failed`, or the owner's subscription (`profiles.payment_failed_at`) | Acknowledge |

"Assign" sets `jobs.assigned_technician_id` (the job itself, or the scheduled job booked from that call) and also acknowledges. Every action is written to `audit_log`.

## Secrets (`supabase secrets set NAME=value`)

| Secret | Used by | Where to get it |
|---|---|---|
| `CHAT_TOKEN_ENCRYPTION_KEY` | all | `openssl rand -base64 32` — encrypts Slack tokens (AES-256-GCM). **Losing it forces every workspace to reconnect.** |
| `PUSH_DISPATCH_SECRET` | dispatch | already set for push/webhooks; must equal `app.settings.push_dispatch_secret` |
| `SITE_URL` | all | already set (e.g. `https://vireek.com`) |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Slack OAuth | Slack app → Basic Information → App Credentials |
| `SLACK_SIGNING_SECRET` | `chat-slack-webhook` | same page; verifies every button click / event |
| `SLACK_STATE_SECRET` | Slack OAuth | `openssl rand -hex 32` |
| `TEAMS_OAUTH_CLIENT_ID`, `TEAMS_OAUTH_CLIENT_SECRET` | Teams sign-in | Entra app registration #1 (**multi-tenant**, "Accounts in any organizational directory") |
| `TEAMS_STATE_SECRET` | Teams OAuth | `openssl rand -hex 32` |
| `TEAMS_BOT_APP_ID`, `TEAMS_BOT_APP_SECRET` | `chat-teams-bot`, sending | Azure Bot's Entra app (#2) |
| `TEAMS_BOT_TENANT_ID` | sending | your tenant id if the bot is **single-tenant** (new bots must be); omit only for a legacy multi-tenant bot |

Never commit these. The Slack token lives only in `chat_connection_secrets` (RLS on, no policies, privileges revoked) — the browser can never read it.

## Slack app (api.slack.com/apps → From manifest)

```yaml
display_information: { name: Vireek }
features:
  bot_user: { display_name: Vireek, always_online: true }
oauth_config:
  redirect_urls: [https://<project-ref>.supabase.co/functions/v1/chat-slack-oauth-callback]
  scopes: { bot: [chat:write, chat:write.public, channels:read, groups:read] }
settings:
  interactivity: { is_enabled: true, request_url: https://<project-ref>.supabase.co/functions/v1/chat-slack-webhook }
  event_subscriptions:
    request_url: https://<project-ref>.supabase.co/functions/v1/chat-slack-webhook
    bot_events: [app_uninstalled, tokens_revoked]
  org_deploy_enabled: false
  socket_mode_enabled: false
```
Private channels: run `/invite @Vireek` in the channel.

## Microsoft Teams
1. **Entra app #1 (sign-in)** — multi-tenant, redirect URI `https://<project-ref>.supabase.co/functions/v1/chat-teams-oauth-callback`, no API permissions beyond `openid profile`. Create a client secret.
2. **Azure Bot (app #2)** — Azure portal → Azure Bot → *Single tenant*. Messaging endpoint: `https://<project-ref>.supabase.co/functions/v1/chat-teams-bot`. Enable the **Microsoft Teams** channel. Create a client secret on its app registration.
3. **Teams app package** — zip `manifest.json` + two icons (192×192 colour, 32×32 outline) and upload via Teams → Apps → Manage your apps → Upload (or publish to your org / the Teams Store):
```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17", "version": "1.0.0", "id": "<TEAMS_BOT_APP_ID>",
  "developer": { "name": "Vireek", "websiteUrl": "https://vireek.com", "privacyUrl": "https://vireek.com/privacy", "termsOfUseUrl": "https://vireek.com/terms" },
  "name": { "short": "Vireek" },
  "description": { "short": "Vireek alerts", "full": "Receive Vireek alerts and acknowledge or assign them from Teams." },
  "icons": { "outline": "outline.png", "color": "color.png" }, "accentColor": "#2563EB",
  "bots": [{ "botId": "<TEAMS_BOT_APP_ID>", "scopes": ["team"], "isNotificationOnly": false }],
  "permissions": ["identity", "messageTeamMembers"], "validDomains": []
}
```
4. In Vireek → Integrations → Connect Microsoft Teams (links your tenant), install the app in a Team → channels appear automatically.

## Deploy
```
supabase db push
supabase functions deploy chat-slack-oauth-start chat-teams-oauth-start chat-notify-admin
supabase functions deploy chat-slack-oauth-callback chat-teams-oauth-callback chat-notify-dispatch chat-slack-webhook chat-teams-bot --no-verify-jwt
```
Optional retry sweep (failed deliveries + events whose first dispatch was lost), every 5 minutes with pg_cron:
```sql
select cron.schedule('chat-notify-retry', '*/5 * * * *', $$
  select net.http_post(url := current_setting('app.settings.edge_function_base_url') || '/chat-notify-dispatch',
    headers := jsonb_build_object('Content-Type','application/json','x-push-dispatch-secret', current_setting('app.settings.push_dispatch_secret')),
    body := '{"retry_due": true}'::jsonb) $$);
```

## Security notes
- Slack requests: HMAC-SHA256 signature + 5-minute replay window. Teams requests: Bot Framework JWT (issuer, audience, `serviceurl` claim).
- OAuth `state` is HMAC-signed and expires in 10 minutes. Only the account owner can connect/disconnect/edit routes (server + RLS).
- A button click is accepted only if the signed request comes from the connected workspace/tenant **and** the event belongs to that account; technicians are validated against the account's team.
- The Teams `serviceUrl` receives our bot token, so it must match an allow-list of Microsoft hosts.
- Invoice amounts are never sent; phone/address can be switched off per event.

## Tests
`npm test` — `supabase/functions/_shared/chat-notify/chatNotify.test.ts` (message models, Block Kit, Adaptive Cards, signatures, encryption, SSRF guard) and `src/lib/chatNotifications.test.ts` (UI helpers + server/UI catalogue parity).
