# Secret rotation runbook

Principle: add the NEW secret first, deploy consumers, verify, then revoke the OLD one. Never print secrets; set them only via `supabase secrets set`, the Vercel dashboard or the provider console.
Evidence for "rotate now?" = gitleaks scan of the REAL git history (`gitleaks detect --redact`). Without it, rotating is precautionary.

Order (dependencies first):
1. Supabase: rotate the JWT secret / API keys per the Supabase dashboard docs (invalidates sessions). Update Vercel `VITE_SUPABASE_ANON_KEY`, edge secrets `SUPABASE_SERVICE_ROLE_KEY`, redeploy the frontend, then smoke test login.
2. Credential-vault keys: add the new key FIRST in the env var read by `credentialKeysFromEnv()` (new key first, old key kept for decrypt), run `provider-credentials-backfill`/re-seal, then remove the old key.
3. Stripe: roll `STRIPE_SECRET_KEY` and each webhook signing secret (`whsec_…`); update secrets, deploy `stripe-webhook`, `stripe-payment-webhook`, `stripe-dispute-webhook`; send a test event.
4. Twilio: rotate auth token (or API key), update secrets, test `sms-webhook` signature validation.
5. Vapi: rotate the private key and `VAPI_SERVER_SECRET` (must match the token of the Vapi credential on the Server URL: `Authorization: Bearer` or legacy `x-vapi-secret`; see `vapi-webhook-secret-header.md`); rotate the public key and `VITE_VAPI_PUBLIC_KEY`.
6. Meta: `META_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN`; Xero: `XERO_CLIENT_SECRET`, `XERO_WEBHOOK_KEY`, `XERO_STATE_SECRET`, `XERO_TOKEN_ENCRYPTION_KEY` (re-encrypt tokens first); QuickBooks, Jobber, HubSpot, Google client secrets the same way (also `*_STATE_SECRET`).
7. Resend, Plaid, ElevenLabs, AI providers: create new key, update secrets, deploy, test one call, revoke old key.
8. VAPID: `npx web-push generate-vapid-keys`; this invalidates existing push subscriptions (users must re-subscribe). Update `VITE_VAPID_PUBLIC_KEY` and the server private key together.
9. Shared secrets: `CRON_SECRET`, `EMAIL_WEBHOOK_SECRET`, `WEBHOOK_SIG_MODE=enforce`.
Verify: run each integration's smoke test, check logs for `webhook_sig_rejected`, confirm old keys are revoked in every console.
Rollback: keep the old value until all consumers are verified; the vault supports two keys during the overlap window.
