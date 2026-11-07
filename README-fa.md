# Apply the patch (from the project root, alongside the supabase folder)

git apply --check vireek-governance.patch     # Check only
git apply vireek-governance.patch             # Apply
# Or without git:
patch -p1 < vireek-governance.patch


# Before deployment (order matters)

1. supabase secrets set CRON_SECRET=<value> and ensure all cron jobs send the X-Cron-Secret header

2. supabase secrets set ESCALATION_WEBHOOK_SECRET=... STATUS_NOTIFY_WEBHOOK_SECRET=... (X-Webhook-Secret header in DB webhook)

3. supabase secrets set WHATSAPP_APP_SECRET=... SMS_WEBHOOK_URL=<exact URL registered in Twilio>

4. Do not set WEBHOOK_SIG_MODE (default: shadow). Leave GOVERNANCE_ENFORCE empty as well (shadow)

5. supabase db push (migration 20290201000000 — if its timestamp is older than your latest migration, rename the file)

6. npx vitest run supabase/functions/_shared ; supabase test db ; node scripts/check-fail-open-secrets.mjs ; node scripts/check-ungoverned-side-effects.mjs
