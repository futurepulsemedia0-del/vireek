# Microsoft 365 / Outlook calendar sync — setup

Two-way sync for the office calendar and for each technician's personal calendar.

- **Outlook → Vireek:** busy/free time is stored in `calendar_busy_blocks` (time and show-as only; no titles, attendees or bodies).
- **Vireek → Outlook:** every scheduled job becomes an Outlook event (category `Vireek`, shown as Busy) on the assigned technician's calendar and on the office calendar.
- **Job events are two-way:** if a user moves a *scheduled* job's event in Outlook after Vireek's last push, the job is rescheduled in Vireek. In every other disagreement Vireek wins. Deleting an event in Outlook never cancels the job; Vireek stops re-creating it until the job itself changes.

## 1. Azure app registration (once, per environment)

1. Azure Portal → **Microsoft Entra ID → App registrations → New registration**.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts** (use *organizations only* if you never want Outlook.com accounts, and set `MICROSOFT_CALENDAR_TENANT_ID=organizations`).
3. Redirect URI, platform **Web**:
   `https://<project-ref>.supabase.co/functions/v1/microsoft-calendar-oauth-callback`
4. **API permissions → Add → Microsoft Graph → Delegated:** `Calendars.ReadWrite`, `User.Read`, `offline_access`. None of these needs admin consent in most tenants; strict tenants will show "admin approval required" and the user sees a clear message in Vireek.
5. **Certificates & secrets → New client secret.** Copy the **Value** (not the Secret ID).
6. Optional but recommended for enterprise customers: set a **Publisher domain** / verified publisher so the consent screen does not show "unverified".

## 2. Supabase secrets

```bash
supabase secrets set MICROSOFT_CALENDAR_CLIENT_ID=<Application (client) ID>
supabase secrets set MICROSOFT_CALENDAR_CLIENT_SECRET=<client secret VALUE>
supabase secrets set MICROSOFT_CALENDAR_STATE_SECRET=$(openssl rand -hex 32)
# optional, default "common": common | organizations | consumers | <tenant GUID or domain>
supabase secrets set MICROSOFT_CALENDAR_TENANT_ID=common
```

`SITE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already used by your other integrations.

> **Client secrets expire** (max 24 months). Put the expiry date in a calendar; when it lapses every connection fails with "Needs reconnect".

## 3. Deploy

```bash
supabase db push
supabase functions deploy microsoft-calendar-oauth-start
supabase functions deploy microsoft-calendar-oauth-callback --no-verify-jwt
supabase functions deploy microsoft-calendar-sync
supabase functions deploy microsoft-calendar-disconnect
```

Then schedule the background sync (SQL block is in the migration header; replace `<project-ref>` and `<service-role-key>`). It runs every 5 minutes and picks the 25 least-recently-synced calendars per run.

## 4. How it behaves

| Topic | Behaviour |
|---|---|
| Who can connect | Office calendar: owner/admin (or `can_manage_team`). Personal calendar: the technician themselves. |
| Tokens | Stored only in `microsoft_calendar_secrets` (no client access). Refresh tokens rotate and are re-saved on every refresh. |
| Disconnect | Deletes tokens, busy blocks and event links. Optionally removes Vireek-created events from Outlook. Revoke the app fully at https://myapps.microsoft.com. |
| Failures | Temporary errors retry automatically; 5 in a row, or revoked/denied access, flips the connection to *Needs reconnect* and shows the recovery banner in Integrations. |
| Window | Busy time from 1 day ago to 120 days ahead; the window is re-baselined automatically. |
| All-day events | Stored as returned in UTC, so a "busy" all-day event can spill into the neighbouring day by the UTC offset. |

## 5. Using busy time in availability checks

```sql
select public.calendar_is_busy('2027-03-02T15:00Z', '2027-03-02T16:30Z', '<team_member_id>');           -- signed-in users
select public.calendar_is_busy_for_owner('<owner_id>', '2027-03-02T15:00Z', '2027-03-02T16:30Z', null);  -- edge functions (null = office)
```

## Troubleshooting

- `invalid_state` / `AADSTS50011`: the redirect URI in Azure does not exactly match the callback URL above.
- `admin_consent_required`: a tenant admin must approve the app (Entra → Enterprise applications → Permissions).
- Technician sees "Only technicians on the team…": their login is not linked to a `team_members.user_id`.
