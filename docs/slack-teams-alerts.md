# Slack & Microsoft Teams alerts

Settings page: `/dashboard/settings/slack-teams` (owner, or team members with **Manage Team**).

## How it works

1. An owner connects Slack and/or Teams via OAuth (`chat-integrations` edge function).
2. Each alert type (emergency, new job, missed call, low CSAT) is mapped to a channel.
3. Postgres triggers on `calls`, `jobs` and `call_feedback` call `dispatch_chat_alerts()`, which hits
   `chat-alerts-dispatch` via pg_net — only when an enabled rule exists. Failures never block the original write.
4. Every attempt is logged to `chat_alert_deliveries` and shown on the page.

OAuth tokens live in `chat_connection_secrets` (RLS on, no policies, privileges revoked): only edge functions can read them.

## Required secrets

​```bash
# Shared
supabase secrets set CHAT_OAUTH_STATE_SECRET=$(openssl rand -hex 32)
supabase secrets set SITE_URL=https://vireek.com
# Already set if the developer event bus / push notifications are deployed:
#   PUSH_DISPATCH_SECRET, and the Postgres settings
#   app.settings.edge_function_base_url + app.settings.push_dispatch_secret

# Slack
supabase secrets set SLACK_CLIENT_ID=... SLACK_CLIENT_SECRET=...

# Microsoft Teams
supabase secrets set TEAMS_CLIENT_ID=... TEAMS_CLIENT_SECRET=...
supabase secrets set TEAMS_TENANT=organizations   # optional (default: organizations)
​```

## Slack app (api.slack.com/apps → Create New App)

- **Redirect URL:** `https://<project-ref>.supabase.co/functions/v1/chat-integrations`
- **Bot token scopes:** `chat:write`, `chat:write.public`, `channels:read`, `groups:read`
- Private channels: invite the app first (`/invite @Vireek`).

## Microsoft Teams (Entra ID → App registrations → New registration)

- **Supported account types:** accounts in any organizational directory (multitenant).
- **Redirect URI (Web):** `https://<project-ref>.supabase.co/functions/v1/chat-integrations`
- **Delegated Microsoft Graph permissions:** `offline_access`, `User.Read`, `Team.ReadBasic.All`,
  `Channel.ReadBasic.All`, `ChannelMessage.Send`
- Create a client secret (Certificates & secrets) and use its **Value** as `TEAMS_CLIENT_SECRET`.
- Teams messages are posted **as the person who connected**. If that account is removed or its
  refresh token is revoked, the page shows "Needs attention" and the owner reconnects.

## Deploy

​```bash
supabase db push
supabase functions deploy chat-integrations --no-verify-jwt
supabase functions deploy chat-alerts-dispatch --no-verify-jwt
​```
