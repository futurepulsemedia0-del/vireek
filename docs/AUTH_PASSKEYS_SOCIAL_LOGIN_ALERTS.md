# Passkeys, Google/Apple sign-in and login alerts

## What ships

| Piece | Where |
| --- | --- |
| Passkey sign-in (button + browser autofill) | `src/pages/LoginPage.tsx`, `src/lib/passkeys.ts` |
| Google + Apple sign-in | `src/pages/LoginPage.tsx`, `src/components/auth/SocialAuthButtons.tsx` |
| Manage passkeys (add / rename / remove) | `src/components/settings/PasskeysCard.tsx` in Security Settings |
| New-device / new-location alerts (email + push) | `supabase/functions/login-alert`, `supabase/functions/_shared/security/login-alert-engine.ts` |
| Alert history + idempotency | migration `20270402000000_login_events_and_alerts.sql` |

Everything uses Supabase Auth's own features: native passkeys (`supabase.auth.registerPasskey`, `signInWithPasskey`, `auth.passkey.*`) and `signInWithOAuth`. No custom WebAuthn crypto.

> Supabase documents passkeys as **experimental** — the API may change. All SDK calls live in `src/lib/passkeys.ts`, so a change touches one file.

## 1. Required provider setup (dashboard — cannot be done from code)

### Passkeys
1. Supabase Dashboard → **Authentication → Passkeys** → enable.
2. **RP ID**: your bare domain, e.g. `vireek.com` (no scheme, port or path). Using the apex covers `app.vireek.com` too.
   **Never change it after users enroll — every existing passkey stops working.**
3. **RP origins** (max 5, HTTPS required except loopback): `https://vireek.com`, `https://app.vireek.com`, plus `http://localhost:5173` for dev.
   Passkeys registered on `localhost` are separate from production ones.
4. **RP display name**: `Vireek`.
5. Client needs `@supabase/supabase-js >= 2.105.0` and `auth: { experimental: { passkey: true } }` (done in `src/lib/supabase.ts`).

Not available for: SSO/SAML users and anonymous users (Supabase limitation). Registration requires a confirmed email.

### Google
1. Google Cloud Console → APIs & Services → Credentials → **OAuth client ID** (Web application).
2. Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase → **Authentication → Providers → Google** → paste Client ID + Secret, enable.

### Apple
1. Apple Developer → Identifiers: create an **App ID** with *Sign in with Apple*, then a **Services ID** (this is the web "client ID").
2. Services ID → Configure: domain `<project-ref>.supabase.co`, return URL `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Keys → create a key with *Sign in with Apple*; download the `.p8` (one-time download). Note **Key ID** and **Team ID**.
4. Supabase → **Providers → Apple**: Services ID as Client ID, and the generated secret (a JWT you generate from Team ID, Key ID and the `.p8` — see Supabase's Apple login guide).
5. **The Apple client secret expires after at most 6 months — set a calendar reminder to regenerate it.** Sign-in silently breaks when it lapses.
6. Users who pick *Hide My Email* get `…@privaterelay.appleid.com`. Our emails (OTP, alerts) only reach them if your sending domain / Resend from-address is registered under Apple Developer → *Sign in with Apple for Email Communication*.
7. Apple only returns the user's name on the very first authorization.

### URL configuration
Supabase → **Authentication → URL Configuration**: Site URL `https://app.vireek.com` (or your production URL); add `https://app.vireek.com/**` and `http://localhost:5173/**` to Redirect URLs. OAuth returns to `/dashboard`.

Identities with the same verified email are linked automatically by Supabase (Google/Apple/password on one account).

## 2. Database + edge function

```bash
supabase db push                      # applies 20270402000000_login_events_and_alerts.sql
supabase functions deploy login-alert
supabase secrets set SITE_URL=https://app.vireek.com
# already used elsewhere in the project: RESEND_API_KEY, RESEND_FROM_EMAIL
# optional:
supabase secrets set ALLOWED_ORIGINS=https://vireek.com,https://www.vireek.com
supabase secrets set GEOIP_LOOKUP_URL='https://ipwho.is/{ip}'   # any JSON geo API; {ip} is substituted
```

Push alerts reuse the existing pipeline: the function inserts a `notifications` row, and the existing `trigger_dispatch_push_notification` + `send-push-notification` deliver it. That already needs the `app.settings.*` and VAPID setup from `20260912000000_push_notifications.sql`.

Retention (keeps 12 months):
```sql
select cron.schedule('prune-login-events', '17 3 * * *', $$select public.prune_login_events()$$);
```

## 3. How alerts work

1. After a login is *fully complete* (past the OTP step-up), `<ProtectedRoute>` calls `login-alert` once per session.
2. The function verifies the JWT, then reads the session's **IP and user agent from Supabase Auth's own `auth.sessions` row** — not from the request body — so a client cannot claim to be a known device.
3. It compares against the user's last 180 days of `login_events`:
   - **New device**: unseen `vrk_device` cookie (or, with no cookie, an unseen user-agent).
   - **New location**: country not seen before (country-level to avoid noise; both sides must have a known country).
   - The very first event for a user is recorded silently (baseline) — this also prevents an alert flood for existing users on deploy day.
4. On a hit: email via Resend + push via `notifications`. Max 5 alert emails/hour/user. `session_id` is unique, so retries and parallel tabs never double-alert.

Known limits (by design / trade-off):
- The trigger is client-initiated. A fully custom client that deliberately skips the call would skip the alert; the data it would report is still server-verified. A database trigger on `auth.sessions` would be stricter, but the `auth` schema is managed by Supabase and may not allow custom triggers.
- Technician / Staff / Partner route wrappers don't use `<ProtectedRoute>`; add `useLoginAlert(Boolean(session))` to them if those users should get alerts too.
- Team-member push: push subscriptions are stored under the account owner's id (existing design), so a team member's *email* alert always works but push reaches the owner's devices.
- Two machines with an identical user-agent that both signed in without the trusted-device cookie (e.g. Google/Apple) are indistinguishable.
- Capacitor/native shells: passkeys in a WebView need Associated Domains (iOS) / Digital Asset Links (Android) for the RP ID; not configured here.

## 4. Tests

```bash
npm test -- src/lib/loginAlert.test.ts src/lib/passkeys.test.ts src/components/settings/PasskeysCard.test.tsx
```

Manual QA: register a passkey in Security Settings → sign out → sign in with the button and via the email-field autofill → rename and remove it → sign in from a private window on a second browser (expect a *new device* email + push) → sign in through a VPN in another country (expect *new location*).
