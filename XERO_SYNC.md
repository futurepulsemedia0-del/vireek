# Xero sync: setup, behaviour and limits

**Status: NOT LIVE-VERIFIED.** Built from Xero's public documentation (OAuth 2.0, Accounting API, webhooks,
rate limits, idempotency keys) and tested with mocked data only (`src/lib/xero.test.ts`, 59 cases).
Run the smoke test below against a Xero **Demo Company** before any real organisation.

## 1. Xero developer app
1. developer.xero.com → New app → "Web app".
2. Redirect URI: `https://<project-ref>.supabase.co/functions/v1/xero-oauth-callback`
3. Scopes used (granular, valid for apps created after 2 March 2026): `offline_access accounting.contacts accounting.settings accounting.invoices accounting.payments`
4. Optional webhooks: delivery URL `https://<project-ref>.supabase.co/functions/v1/xero-webhook`, subscribe to Invoices + Contacts, copy the signing key.

## 2. Secrets
```
supabase secrets set XERO_CLIENT_ID=... XERO_CLIENT_SECRET=...
supabase secrets set XERO_STATE_SECRET=$(openssl rand -hex 32)
supabase secrets set XERO_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
supabase secrets set XERO_WEBHOOK_KEY=...        # only if webhooks are used
# CRON_SECRET and SITE_URL are already set for QuickBooks / CRM sync
```

## 3. Deploy
```
supabase db push
supabase functions deploy xero-oauth-start
supabase functions deploy xero-oauth-callback --no-verify-jwt
supabase functions deploy xero-webhook --no-verify-jwt
supabase functions deploy xero-sync-run --no-verify-jwt
```
Schedule: see the pg_cron snippet at the bottom of `20280101000000_xero_sync.sql`.

## 4. Behaviour
- Entities: accounts, contacts, items, invoices (ACCREC), payments, plus read-only tax rates. Pull then push, field-level three-way merge, manual conflict review.
- **Idempotent**: existing Xero records are matched (name/email, item code, account code, invoice number) and linked; creates carry an `Idempotency-Key` (record + payload hash); unique link constraints; merge never rewrites unchanged data.
- **Retry**: network/5xx back-off, 429 honours `Retry-After` (capped 45 s, daily limit stops the run), 401 refreshes the rotated refresh token once; dependency waits are kept in per-entity retry lists.
- **Multi-currency**: money documents sync only when Xero's base currency equals Vireek's (Settings → Regional); otherwise they are skipped with a visible reason. Foreign-currency Xero invoices are converted to the base currency at the rate stored on the Xero invoice (original currency, amounts and rate are kept on the link and shown in the log). Payments on them are valued at the invoice rate. Mode `skip` ignores foreign invoices.
- **Tax**: Xero tax rates are cached read-only; the mapping UI picks the rate for taxable and tax-free invoices. Vireek's tax amount is sent exactly (allocated per line).
- Webhooks cover invoices and contacts only; everything else is picked up by the 15-minute schedule.

## 5. Known limits
- Realised FX gain/loss on foreign payments is **not posted**; it is reported in the log.
- Foreign-currency invoices and their payments are edited in Xero, not pushed from Vireek.
- Deletes, supplier bills, credit notes, prepayments/overpayments, inventory items, tracking categories are not synced.
- One Xero organisation per Vireek account; selecting several in the consent screen is rejected and the extra grants are removed.
- Xero refresh tokens expire after 60 days without use (the UI warns at 14 days).
- Assumptions to confirm on the Demo Company: contact/item partial updates keep sibling fields; invoice update with `LineItems` replaces lines; `where`/`order`/`Statuses` filters and `If-Modified-Since` behave as documented; `Idempotency-Key` is accepted on PUT.

## 6. Demo Company smoke test (30 min)
1. Connect, confirm organisation name, base currency and "Demo company" badge.
2. Mapping → pick sales account, deposit account, tax rates → Save → Sync now. Expect contacts/items/accounts linked, tax-rate table filled.
3. Create a sales invoice in Xero (approve it) → Sync now → appears in Vireek. Repeat with a EUR invoice; check the log line shows the conversion.
4. Record a payment in Xero → synced; the invoice becomes paid. Run Sync now twice: second run must report no changes (idempotency).
5. Create/send an invoice from Vireek → appears AUTHORISED in Xero with the same total (otherwise a conflict is logged).
6. Change one contact field on both sides → conflict card appears; resolve both ways.
7. Disconnect → app disappears from Xero's connected apps.
