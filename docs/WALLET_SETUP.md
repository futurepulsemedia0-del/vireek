# Wallet passes — setup (Apple Wallet + Google Wallet)

Apple and Google are independent: configure one or both. A platform that isn't configured returns a clear
"not configured" message; nothing else breaks.

## 1. Apple Wallet

You need: an Apple Developer Program account, a **Pass Type ID**, its **certificate + private key**, Apple's **WWDR
G4 intermediate certificate**, and your **Team ID**. The same certificate signs passes AND authenticates pushes to
APNs — there is no separate APNs key for Wallet.

1. developer.apple.com → Certificates, Identifiers & Profiles → **Identifiers → + → Pass Type IDs** → register e.g.
   `pass.com.vireek.wallet`.
2. Create a private key + CSR on your machine (keep `pass.key` secret, never commit it):
   `openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr -subj "/CN=Vireek Wallet"`
3. Open the Pass Type ID → **Create Certificate** → upload `pass.csr` → download `pass.cer`.
4. Convert to PEM: `openssl x509 -inform DER -in pass.cer -out pass-cert.pem`
5. Download **Apple Worldwide Developer Relations – G4** from https://www.apple.com/certificateauthority/ then:
   `openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem`
6. Team ID: developer.apple.com → Membership details (10 characters).
7. Set the secrets (Supabase CLI):
   ```
   supabase secrets set APPLE_PASS_TYPE_ID=pass.com.vireek.wallet APPLE_TEAM_ID=ABCDE12345
   supabase secrets set APPLE_PASS_CERT_PEM="$(cat pass-cert.pem)" APPLE_PASS_KEY_PEM="$(cat pass.key)" APPLE_WWDR_PEM="$(cat wwdr.pem)"
   ```
   The key must be unencrypted PEM. If you only have a .p12:
   `openssl pkcs12 -in pass.p12 -nodes -nocerts -out pass.key` and `openssl pkcs12 -in pass.p12 -clcerts -nokeys -out pass-cert.pem`.
8. **Pass Type ID certificates expire after about a year.** Calendar the expiry; renew and replace the two secrets
   (they are read per request, no redeploy needed). Installed passes keep working.

## 2. Google Wallet

1. Google Pay & Wallet Console (pay.google.com/business/console) → create a business profile → copy the **Issuer ID**.
2. Google Cloud Console → enable the **Google Wallet API** → IAM → **Service Accounts** → create one → **Keys → Add key → JSON**.
3. Wallet Console → **Users** → invite the service-account e-mail (Developer or Admin).
4. Secrets:
   ```
   supabase secrets set GOOGLE_WALLET_ISSUER_ID=3388000000012345678
   supabase secrets set GOOGLE_WALLET_SA_JSON="$(cat service-account.json)"
   ```
5. **Demo mode:** until you request publishing access (Wallet Console → Google Wallet API → Manage → *Request
   publishing access*, short brand review), only Google accounts listed as **Test users** can save passes. Add your
   own account to test.

## 3. Optional secrets

| Secret | Purpose |
|---|---|
| `WALLET_ICON_PNG_B64`, `WALLET_LOGO_PNG_B64` | Base64 PNG (icon ≥ 87×87, logo ≤ 160×50). Default: solid brand-colour icon. |
| `WALLET_LINK_BASE` | Override the customer link base (default `${SITE_URL}/w`). |
| `SITE_URL`, `CRON_SECRET` | Already used by other functions. |

## 4. Deploy

```
supabase db push                                        # applies 20271120000000_wallet_passes.sql
supabase functions deploy wallet-pass --no-verify-jwt   # Apple devices can't send a Supabase JWT
supabase functions deploy wallet-sync --no-verify-jwt   # cron worker, protected by X-Cron-Secret
supabase functions deploy wallet-issue                  # JWT required (staff) / anon key (portal)
```

Schedule `wallet-sync` **every minute** with the same external cron as `arrival-window-notify`:
`POST https://<project>.supabase.co/functions/v1/wallet-sync` with header `X-Cron-Secret: <CRON_SECRET>`.

## 5. Verify

1. Dashboard → **Wallet Passes** → Appointments → pick a job → *Create link* → open it on an iPhone / Android.
2. Change the job's ETA or technician. Within ~1–2 minutes (cron) the pass updates and the iPhone shows a lock-screen
   message; the list goes "Updating…" → "In wallet".
3. When something doesn't update, check `wallet_push_outbox` (`status`, `last_error`) and the `wallet-sync` /
   `wallet-pass` logs.

## 6. Known limits

* English-only pass text; times use the timezone captured when the pass was issued.
* Apple refreshes a pass only while it stays in Wallet; deleting it removes the push registration.
* Google syncs PATCHed objects to the device on its own schedule.
* Gift-card and badge passes are staff-issued only (never from the customer portal).
