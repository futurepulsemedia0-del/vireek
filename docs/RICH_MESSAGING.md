# RCS Business Messaging + Apple Messages for Business

Two extra channels in the Unified Inbox (`/dashboard/inbox`), delivered through one approved messaging
aggregator (**Sinch Conversation API**). Customers whose phone supports it get verified-sender rich cards
(booking confirmation, technician ETA, pay-now, reschedule) with read receipts; everyone else gets the same
content by SMS automatically. Opt-outs are shared with SMS.

| Piece | Where |
| --- | --- |
| Tables, RLS, worker RPCs | `supabase/migrations/20271201000000_rich_messaging_rcs_amb.sql` |
| Pure logic (routing, cards, fallback, receipts, inbound) | `supabase/functions/_shared/richMessaging/*.ts` (all unit-tested) |
| Shared STOP / START / HELP keywords | `supabase/functions/_shared/messaging/optOut.ts` |
| Aggregator adapter (only file that knows Sinch's wire format) | `_shared/richMessaging/sinch.ts` |
| Webhook (inbound, receipts, capability, opt-out) | `supabase/functions/rich-webhook` |
| Inbox reply + send card | `supabase/functions/rich-send` |
| SMS-fallback / quiet-hours release worker (cron) | `supabase/functions/rich-fallback-sweep` |
| Inbox UI + tenant settings | `src/lib/unifiedInbox.ts`, `src/pages/UnifiedInboxPage.tsx`, `src/pages/RichMessagingSettingsPage.tsx` |

## How a message flows

```
sendRich()  ─ consent (dnc_suppressions / thread opt-out / Apple "conversation deleted")
            ─ route per recipient:  Apple thread → AMB
                                    RCS approved + capable (or unknown, attempt_on_unknown) → RCS
                                    otherwise → SMS via sendCompliantSms (A2P + STOP + quiet hours)
            ─ quiet hours (same gate as SMS; held rows are released by rich-fallback-sweep)
            ─ row saved FIRST (its id = aggregator correlation_id), then aggregator call
            ─ fallback armed: deadline = now + fallback_after_seconds, provider ttl = same
rich-webhook ─ DELIVERED / READ → cancel fallback, show ticks in inbox
             ─ FAILED → immediate SMS fallback (claimed atomically: can never run twice)
rich-fallback-sweep (cron, 1/min) ─ no receipt by deadline → SMS fallback
```

* SMS fallback **always** goes through `sendCompliantSms()`, so A2P approval, the shared STOP list and quiet
  hours still apply. If A2P is not approved the fallback fails visibly (`status = failed`) rather than vanishing.
* Capability is cached per recipient in `rich_capabilities` (capable 72 h, not capable 12 h, unknown 15 min). Any
  inbound RCS message or delivery receipt marks a number capable; `RECIPIENT_NOT_REACHABLE` marks it not capable.
* Apple Messages is **customer-initiated only** and identifies people with an opaque id (`urn:mbid:…`), not a phone.
  So "capable" means "an Apple thread exists". A deleted conversation blocks sending until the customer writes again.
* Marketing is rejected (`MARKETING_NOT_SUPPORTED`): RCS/Apple need a proper opt-in flow first.

## Consent and opt-out (shared with SMS)

* `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT` (exactly the list `sms-webhook` uses) write to
  `dnc_suppressions`, the list `sendCompliantSms()` and outbound calling already check. One STOP blocks every channel.
* `START` / `UNSTOP` remove only the customer's own `customer_opt_out` row. `HELP` / `INFO` get the help text.
* A STOP is applied **before** the duplicate check, so a provider retry after a crash still ends suppressed.
* Apple threads without a known phone are opted out at thread level (`rich_conversations.opted_out_at`).

## Provider approval (what has to happen outside the code)

### RCS Business Messaging
1. Create a Sinch Build account, enable **Conversation API**, create an access key (Key ID + Key Secret).
2. Ask Sinch for an **RCS Sender Agent** for the tenant: brand name, logo, colour, description, website, support
   phone/email, privacy policy URL, opt-in description. Google and each carrier verify the brand and then
   "launch" the agent per carrier (days to weeks; some carriers are slower).
3. Create the Conversation API **app in the same region** as the agent (a mismatch causes channel errors and missing
   receipts). Set up the RCS channel on the app with the agent's `authName` / `authToken`.
4. Add a **webhook** to the app: target = the `rich-webhook` URL, secret = `SINCH_WEBHOOK_SECRET`, triggers
   `MESSAGE_INBOUND`, `MESSAGE_DELIVERY`, `EVENT_INBOUND`, `CAPABILITY`, `OPT_OUT`.

### Apple Messages for Business
1. Register at Apple Business Register and choose **Sinch** as the Messaging Service Provider; Apple reviews
   brand name, logo and use case. You receive a **Messages for Business account id (MBA-ID)**.
2. Connect the MBA-ID to the Conversation API app (Sinch setup guide) and use the same webhook.
3. Add entry points customers can tap (Business Chat button on the website, Maps, Safari, Siri, QR code) —
   conversations can only start from the customer's side.

### Credentials to collect
| Secret / value | Where used |
| --- | --- |
| `SINCH_PROJECT_ID`, `SINCH_KEY_ID`, `SINCH_KEY_SECRET` | edge-function secrets (`supabase secrets set …`) |
| `SINCH_WEBHOOK_SECRET` | edge-function secret, also entered on the Sinch webhook |
| `CRON_SECRET` | already used by your other crons |
| per tenant: Conversation API **app id**, region, RCS agent id, MBA-ID, verified sender name | `rich_messaging_accounts` (operator-owned columns) |

### Approving a tenant (operator, SQL editor / service role)
```sql
update rich_messaging_accounts set
  provider_app_id = '<sinch app id>', provider_region = 'us',
  rcs_status = 'approved', rcs_agent_id = '<agent id>', rcs_enabled = true,
  amb_status = 'approved', amb_business_id = '<MBA-ID>', amb_enabled = true,
  verified_sender_name = '<name as verified>'
where user_id = '<tenant user uuid>';
```
Tenants can request access from `/dashboard/settings/rich-messaging` (RPC `request_rich_messaging_access`) and can
only edit display and behaviour fields; status, app id and agent ids are protected by column-level grants.

## Deploy

```bash
supabase db push                                   # or run the .sql in the SQL editor
supabase secrets set SINCH_PROJECT_ID=… SINCH_KEY_ID=… SINCH_KEY_SECRET=… SINCH_WEBHOOK_SECRET=…
supabase functions deploy rich-webhook --no-verify-jwt
supabase functions deploy rich-fallback-sweep --no-verify-jwt
supabase functions deploy rich-send
# schedule every minute, header  X-Cron-Secret: <CRON_SECRET>   (same cron service as arrival-window-notify)
#   POST https://<project>.functions.supabase.co/rich-fallback-sweep
```

## Sending a card from server code

```ts
import { buildCard } from "../_shared/richMessaging/cards.ts";
import { createRichDeps, loadBrandName } from "../_shared/richMessaging/runtime.ts";
import { sendRich } from "../_shared/richMessaging/send.ts";

const deps = createRichDeps(admin);
const account = await deps.loadAccount(userId);
const content = buildCard(
  { template: "technician_eta", jobId, technicianName: "Sam", etaMinutes: 25, timeZone: "America/New_York", trackUrl },
  { name: await loadBrandName(admin, userId, account), logoUrl: account?.brandLogoUrl, phone: "+15551234567" },
);
const result = await sendRich(deps, { userId, phone: customerPhone, content, source: "arrival-window-notify", dedupeKey: `eta:${jobId}` });
```
`dedupeKey` makes cron retries safe. Templates: `booking_confirmation`, `technician_eta`, `pay_now`, `reschedule`.
Tapping a button arrives in the inbox as a `reply` message (`Tapped: reschedule (job_9)`); acting on it is still a human step.

## Must be verified against a real Sinch project before go-live

`sinch.ts` is written from Sinch's documentation but **not live-verified** (same convention as `sendSms.ts`).
Run one test number per channel and confirm each item; every one is isolated in `sinch.ts`:

1. Channel ids `RCS` and `APPLEBC` (Apple Messages for Business).
2. RCS identity format in requests/webhooks (`15551230001` vs `+15551230001`); inbound is normalised either way.
3. `CAPABILITY` webhook body (`capability_notification` with `capability_status`).
4. `OPT_OUT` webhook body and the Apple "conversation deleted" event name.
5. `MESSAGE_DELIVERY` echoes our `correlation_id` and uses reason code `RECIPIENT_NOT_REACHABLE` for non-RCS phones.
6. The `ttl` send field expires an undelivered RCS message (this is what prevents RCS + SMS both arriving).
7. How Apple downgrades cards (list picker / rich link): check the pay-now and reschedule cards on a real iPhone.

## Known limits / follow-ups

* No AI auto-reply on these two channels yet (`auto_reply_*` is wired for `sms` / `email` only); replies are human.
* Apple Pay, time picker and list picker native messages are not generated (cards are downgraded by the provider).
* `rich_conversations` / `rich_messages` hold customer PII: register them with your DSAR / retention tooling
  (`_shared/compliance/ownedTables.ts`) the same way you handle `sms_*` tables.
