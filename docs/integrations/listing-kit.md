# Vireek — marketplace listing kit

Copy is written to match what exists **today**; each platform section lists what must be true before the listing can go live. Items in [brackets] are facts only you can supply (pricing, SLA, URLs). Never publish a claim the product cannot yet back.

## Shared assets
- **Short description (≤120 chars):** Vireek answers calls, books jobs on your real schedule and writes them into your system.
- **Privacy / Terms URLs:** [https://vireek.com/privacy] [https://vireek.com/terms] — confirm they are live.
- **Support:** [support email], hours [..]. **SLA:** take values from `src/lib/trustPack/sla.ts` (not inspected) — do not invent.
- **Pricing display:** [must equal the public pricing page; HubSpot checks this].
- **Screenshots (capture list, 1600×1000, light + dark):** 1) connect screen, 2) mapping settings, 3) booking appearing in the FSM, 4) sync log, 5) disconnect confirmation.
- **Release notes template:** `vX.Y — Added / Changed / Fixed / Security / Known limitations`.

## Demo-video script (≈3 min, reusable)
0:00 problem (missed calls) → 0:20 connect account (show permission screen) → 0:50 choose what syncs (show mapping) → 1:20 customer books; job appears in the partner app → 2:00 disconnect from Vireek and show access removed (**HubSpot certification and Intuit require showing disconnect**) → 2:30 where data goes, support contact.

## One-pagers ("Why Vireek")
- **ServiceTitan:** Missed-call recovery that books straight onto the schedule. *Only publishable after certification; today's App-Key connect must not be advertised.*
- **Housecall Pro:** Books jobs from every call into Housecall Pro. Requires MAX-plan API access.
- **Jobber:** Turns calls into Jobber clients and jobs. Today: client + job creation, price-book import.
- **QuickBooks:** Invoices and payments reconcile both ways with per-entity direction and conflict rules (newest-wins / Vireek / QuickBooks / manual).
- **Google:** Online booking feed from live availability with owner-approved Business Profile updates. Reserve/agentic booking: not live — requires Google approval.
- **HubSpot:** Contact sync — **not built; do not list.**
- **Microsoft:** Calendar connection (not audited here).

## Per-platform listing text and onboarding (in each platform's terms)

### QuickBooks Online (ready to draft once assessment passes)
**Title:** Vireek — jobs, invoices and payments for service businesses. **Features:** sync customers, items, accounts, invoices, payments; choose direction per entity; duplicate-safe; void handling. **Scope:** `com.intuit.quickbooks.accounting`.
**Onboarding:** 1) Dashboard → QuickBooks → Connect. 2) Sign in to Intuit, pick the company, Authorize. 3) Mapping → Defaults: income account, deposit account, tax code. 4) Run first sync; review log. 5) Disconnect anytime in Vireek (revokes at Intuit) or from Intuit's connected apps.

### Jobber
**Features:** create client and job from a booked appointment; import products to the price book. **Onboarding:** 1) Dashboard → Price Book → Connect Jobber. 2) Approve access in Jobber. 3) Confirm product import. 4) Book a test appointment and check Jobber. 5) Disconnect: *(not built yet — required before submission)*.

### ServiceTitan *(blocked until certified)*
Target onboarding after certification: install from the ServiceTitan App Marketplace → authorise → map Business Unit / Job Type per service → test booking. Today's manual credential flow must not be offered to new customers.

### Housecall Pro
1) Confirm MAX plan. 2) App Store → API → Generate key (admin). 3) Paste into Vireek. 4) Test booking. Webhook setup: not supported yet.

### Google
Owner enables the booking feed after readiness checks pass; proposals for Business Profile services are approved by an owner before anything is applied. Actions Center booking: *not available*.

### HubSpot / Microsoft
No listing until the integrations are built / attested.

## HubSpot "Shared data" table (draft — only after a real sync exists)
| Object | Direction | Why |
|---|---|---|
| Contacts | read + write ⇒ **bi-directional** | create/update callers as contacts |
