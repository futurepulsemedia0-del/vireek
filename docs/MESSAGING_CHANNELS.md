# Telegram + Facebook Messenger channels

Both channels live in the Unified Inbox (`/dashboard/inbox`) and reuse `dm_channel_connections`,
`dm_conversations` and `dm_messages` (migration `20280101000000_telegram_messenger_channels.sql`).

## Flow
- Inbound: Telegram -> `telegram-webhook?c=<connection id>` (checked with a per-connection secret header).
  Messenger -> `messenger-webhook` (checked with `X-Hub-Signature-256` and `META_APP_SECRET`).
  Both store through `_shared/dmChannels/inbound.ts`; a provider retry is a no-op (unique provider message id).
- Outbound: `dm-send` (human replies). Gates: STOP opt-out, Messenger 24h window, healthy connection, length limits.
- Draft help: `dm-suggest` writes a Knowledge Base draft for the agent to review. It never sends.
- Connect / disconnect: `dm-connect`, from `/dashboard/settings/messaging-channels`. One bot / Page per tenant per channel.

## Secrets
| Name | Used by | Notes |
|---|---|---|
| `META_APP_SECRET` | `messenger-webhook` | Required. Without it every POST is rejected (fail closed). |
| `MESSENGER_VERIFY_TOKEN` | `messenger-webhook` | Any random string; same value in Meta > Messenger > Webhooks. |
| `META_GRAPH_VERSION` | `dm-connect`, `dm-send`, `messenger-webhook` | Optional, default in `_shared/dmChannels/protocol.ts`. |

## Troubleshooting
- Connection shows "Needs attention": the token was revoked / expired. Reconnect with a fresh token.
- Messenger replies rejected: the customer's last message is older than 24 hours.
- Telegram "blocked by the user": the customer blocked the bot; they must unblock and message again.
- Nothing arrives: check `supabase functions logs telegram-webhook` / `messenger-webhook`
  (`messenger_webhook_unknown_page` = the Page is not connected in this workspace).
