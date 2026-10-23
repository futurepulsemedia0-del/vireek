# Property-management integrations

Page: `/dashboard/property-management` · Edge function: `pm-sync-run` · Migration: `20271110000000_pm_integrations.sql`

Providers: Buildium, Propertyware, Rentvine, AppFolio, Yardi Voyager.

## What syncs

| Direction | Data | Notes |
|---|---|---|
| Provider → Vireek | Work orders | Written into `work_orders`, so the approval gate, NTE cap and billing rules still apply. |
| Provider → Vireek | Units, tenant contacts | Tenant contacts fill the work order's site contact. Deleted on disconnect. |
| Provider → Vireek | Approvals | The provider's approval value maps to `approval_status`. Default when absent: `pending`. |
| Vireek → provider | Status updates | Queued by a database trigger when `work_orders.status` changes. |
| Vireek → provider | Invoices | Queued when a visit becomes `invoiced`. |

Conflict rules: the provider owns title, description, PO, site, contact, NTE and approval. Status is three-way against the last-synced snapshot; if both sides moved, Vireek wins (and is pushed), except a provider cancellation, which always wins. Nothing is ever deleted in either direction.

Every write to a provider is OFF by default and starts as a **dry run** (the exact request is logged, nothing is sent).

## Required access, per provider

Confidence: **auth + base URL** are from the vendor's public documentation. **List/update paths and field names** are best-known defaults: verify them in the provider's sandbox with *Settings → Fetch sample* and correct them in *Field mapping* / *Advanced: endpoints* (no deploy needed).

### Buildium (plan required)
- Premium plan; the customer turns on the Open API and creates an API key (client ID + secret). Production `https://api.buildium.com/v1`, sandbox `https://apisandbox.buildium.com/v1`.
- Headers `x-buildium-client-id` / `x-buildium-client-secret`. Give the key work orders, rentals/units, tenants and bills permissions.
- Invoices post a vendor bill. You need your vendor ID and a GL account ID (Settings → Writing back).

### Propertyware (self-serve)
- Customer creates an API key; you also need their organization (system) ID. Base `https://api.propertyware.com/pw/api/rest/v1`.
- Headers `x-propertyware-client-id`, `x-propertyware-client-secret`, `x-propertyware-system-id`.
- Defaults: work orders, units, status update. Tenant list and invoices need endpoints from the Propertyware docs.

### Rentvine (self-serve)
- Customer creates a role limited to maintenance, units and tenants, then an API key (key + secret) tied to it. HTTP Basic. Base `https://<subdomain>.rentvine.com/api/manager`.
- Default: work-order search only. Status and invoice writes need endpoints from docs.rentvine.com.

### AppFolio (partner access required)
- AppFolio Stack partner approval; the customer enables API access and issues client ID + secret. Reading works with API access; **writing work orders needs separate AppFolio approval**.
- Default: read-only via the reports endpoints (POST, no paging). Switch writes on only after approval, by adding endpoints.

### Yardi Voyager (partner access required)
- Yardi interface partnership and a licensed Service Requests interface per customer (license fees apply). The customer gives you interface URL, username, password, server name, database, platform, interface entity and license.
- Read-only (SOAP `GetServiceRequests_Login`, one request per property code). The payload is parsed tolerantly but **must be validated in a Yardi sandbox**. Hosted `*.yardi.com` / `yardiaspx*.com` hosts are allowed; on-prem hosts need `PM_EXTRA_ALLOWED_HOSTS`.

## Setup

1. Apply the migration (requires the CRM-sync and work-orders migrations).
2. Secrets: `supabase secrets set PM_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)` (CRON_SECRET already exists). Optional `PM_EXTRA_ALLOWED_HOSTS=host1,host2`.
3. `supabase functions deploy pm-sync-run --no-verify-jwt`
4. Schedule the pg_cron snippet at the bottom of the migration (every 5 minutes: pull + queue drain).
5. Connect the **sandbox** first, fetch a sample, fix mapping, run with dry run ON, read the sync log, then switch dry run off.

## Retry queue

Failures retry with exponential backoff (30 s doubling, capped at 6 h, ±20 % jitter, honours `Retry-After`), up to 8 attempts. 429 and 5xx retry; 401 pauses the connection and asks to reconnect; 403, 404 and 4xx fail immediately with the provider's reason. Failed items can be retried or cancelled from the Retry queue tab. Many changes to one record collapse into a single pending push.

## Known limits

- Invoice pushes cannot be made fully idempotent across a crash between the provider's response and our write; use unique invoice numbers (the provider normally rejects duplicates).
- AppFolio report endpoints are single-response (no paging); very large accounts may need provider-side filters.
- Webhooks are not used; polling runs every 5 minutes.
- Approvals are read from the provider; approving inside Vireek is not pushed back.
