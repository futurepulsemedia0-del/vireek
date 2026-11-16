# Area owners

Every area needs one accountable person. `node scripts/governance/check-owners.mjs` warns (CI) while any owner is `TBD`;
run it with `--strict` on release branches once owners are assigned. Keep this file in sync with `.github/CODEOWNERS`.

| Area | Owner | Backup | Scope |
|---|---|---|---|
| security | TBD — assign a person | TBD — assign a person | Auth, RLS, secrets, vulnerability response, pen-test follow-up |
| voice | TBD — assign a person | TBD — assign a person | Vapi, call quality, voice-health-tick, forwarding, voice incidents |
| billing | TBD — assign a person | TBD — assign a person | Stripe, plans, failed payments, usage cost and margins |
| integrations | TBD — assign a person | TBD — assign a person | QuickBooks/Xero/Zoho, Twilio, calendar, sync errors |
| support | TBD — assign a person | TBD — assign a person | Tickets, Help Center, status page, incident comms, customer health review |
| compliance | TBD — assign a person | TBD — assign a person | Data retention, deletion, exports, SOC 2 evidence, legal holds |
