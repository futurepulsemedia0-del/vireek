# Holdco restructure runbook (draft)

> **Status: DRAFT planning aid. Not legal or tax advice.** Every item tagged **[REQUIRES COUNSEL]** (legal), **[REQUIRES TAX]** or **[REQUIRES CONTRACT REVIEW]** must be decided by qualified professionals; engineering only executes their decision. Companion: [06-entity-dependency-audit.md](06-entity-dependency-audit.md). Facts not provable from the repo are **UNVERIFIED**.

## Design principles

1. **Insert the holdco above the operating company; keep everything customer-visible fixed**: brand "Vireek", `vireek.com`/`app.vireek.com`/`in.vireek.com`, passkey RP ID, bundle IDs `com.vireek.field`/`com.vireek.home`, API key prefixes (`vrk_*`, `sk_vireek*`), Supabase project ref and webhook hosts, CNAME target, encryption keys.
2. **Prefer transferring ownership of an account over creating a new one.** Where a new registration is unavoidable (A2P brand, possibly Stripe), run old and new **in parallel** and switch only after the new one is approved and tested.
3. **Whether the operating company keeps contracts or they move is a counsel/tax decision [REQUIRES COUNSEL][REQUIRES TAX].** This runbook is structured so most technical phases are valid under either outcome (Path A: operating company stays contracting party; Path B: contracts/accounts move to a new entity).
4. **One change window per risky system; freeze the rest.** No feature launches, key rotations, domain/DNS or migration changes during phases 3-6.
5. Never record secret values in tickets, chat, or this repo.

## Roles

Incident commander · Engineering lead · Counsel liaison · Finance/tax owner · Support lead · Comms owner. Each provider needs **two named owners** by end of Phase 0 (today many references point to one mailbox, `ali@vireek.com`).

## Phase 0 — Discovery and decisions (no production change)

**Preconditions:** executive approval to start; counsel engaged.
**Steps**
1. Fill `docs/integrations/providers/OWNER_REGISTER.md` for every provider: account owner, account ID, environments, granted scopes, webhooks, last key rotation, contract/DPA status.
2. Export (read-only) and store securely: DNS zones for all domains, registrar/registrant, TLS setup, SPF/DKIM/DMARC records, Stripe webhook/endpoint list, Twilio number list + A2P brand/campaign status, Vapi assistants/numbers, Apple Team ID/Play signing state, Supabase org/billing, Vercel/Cloudflare team and project (confirm which serves production).
3. Collect signed customer and vendor contracts; flag assignment, change-of-control and notice clauses **[REQUIRES CONTRACT REVIEW]**.
4. Counsel decides Path A vs B, target contracting/processor/controller entity, SCC/DPA party, governing law and venue (`[State]` placeholders in Terms/MSA) **[REQUIRES COUNSEL]**; tax decides invoicing, sales-tax registrations, seller identity **[REQUIRES TAX]**.
5. Re-run the inventory greps on the **current working tree** (zip may be stale): `legal_business_name|ein` (A2P), `vireek\.(com|ai|co)`, `[a-z]{20}\.supabase\.co`, `vrk_|sk_vireek`, `com\.vireek`, `User-Agent`.
6. Build the customer notice list from DPA/MSA notice clauses (subprocessor/party change periods).
**Verification:** register has zero blank owner cells; two owners per provider; decision memo signed; change-freeze calendar agreed.
**Rollback:** none needed (no production change).
**Exit gate:** go/no-go meeting.

## Phase 1 — Legal and contract groundwork (counsel-led)

**Preconditions:** Phase 0 decisions.
**Steps** (all **[REQUIRES COUNSEL]** unless stated)
1. Draft/approve: updated Terms, MSA, DPA and GDPR DPA party identity; assignment/novation notices or affiliate-processor language; Privacy Policy controller identity; Subprocessors list (incl. any intra-group entity); SMS terms; cookie notice if controller changes.
2. Decide re-acceptance vs notice for existing customers and for acceptance records.
3. Fill `LEGAL_ENTITY` values (Impressum) and `[State]` governing-law placeholders in Terms/MSA with counsel-approved text.
4. Execute SCC annexes / UK Addendum if applicable; update TIAs (`docs/compliance/transfers-and-contracts.md`).
5. Vendor paperwork: DPAs, assignments, novations for Stripe, Twilio, Vapi, AI providers, Supabase, Vercel/Cloudflare, Resend, Lob, data providers **[REQUIRES CONTRACT REVIEW]**.
6. Confirm voice-clone rights and recording-notice wording with the new party **[REQUIRES COUNSEL]**.
7. Confirm public claims (SOC 2 / trust page) remain accurate; update `docs/claims-register.json` with trust-owner sign-off.
**Verification:** counsel sign-off recorded; all documents versioned with effective dates; no code changed yet.
**Rollback:** withdraw drafts; nothing is published.

## Phase 2 — Readiness engineering (no behavior change, flags default OFF)

**Preconditions:** Phase 0 complete. Implement as separate reviewed PRs (this audit changes no code).
**Steps**
1. Make the legal-entity name/address data-driven from one source (`legalEntity.ts`) behind a feature flag defaulting OFF; no visible change until Phase 5.
2. Remove hard-coded Supabase project ref from `vercel.json`, `api/win-card.ts`, `public/openapi.json`, `public/embed/analytics.html`, `scripts/openapi.mjs` where a build-time variable is feasible (keeps URLs identical in output).
3. Add entity-version snapshot to acceptance records going forward (additive, idempotent migration with rollback note) so future events record which entity accepted.
4. Add a CI check that fails if API-key prefixes, RP ID, `INBOUND_EMAIL_DOMAIN`, bundle IDs or CNAME target change.
5. Decide Vercel vs Cloudflare as single production target; document in `ARCHITECTURE.md`.
**Verification:** lint, typecheck, full tests green; built artifacts byte-identical in URLs; migrations run on fresh DB and existing schema.
**Rollback:** revert PRs; flags remain OFF.

## Phase 3 — Long-lead external registrations (parallel, no cutover)

**Preconditions:** Phase 1 decisions on target entity.
**Steps**
1. **A2P 10DLC:** if the registered legal name/EIN will change, submit the new brand and campaign now under the new entity; keep the old one live. Use text approved by counsel **[REQUIRES COUNSEL]**.
2. **Apple/Google:** start App Transfer / Play transfer or enrol the new developer account (D-U-N-S, seller name, agreements) **[REQUIRES COUNSEL]**. Fill real Team ID in `apple-app-site-association` and certificate fingerprints in `assetlinks.json` only when known (currently placeholders).
3. **Meta Business, Google Cloud/OAuth verification, Microsoft publisher, HubSpot/Jobber/Intuit/Xero apps:** open ownership-change or re-verification requests; record expected lead times.
4. **Stripe:** open a support case describing the planned legal change; follow Stripe's instructions; do **not** create a second platform account unless counsel/tax require it **[REQUIRES COUNSEL][REQUIRES TAX]**.
5. Add holdco-approved staff as co-owners on every provider and on GitHub, registrar, DNS, Supabase, Vercel/Cloudflare, Apple, Google Play.
**Verification:** each request has a ticket ID, owner and ETA in the register; new A2P brand status tracked to approved.
**Rollback:** cancel/withdraw requests; old registrations untouched.

## Phase 4 — Account ownership transfers (infrastructure, one system per window)

**Preconditions:** Phases 1-3 gates passed; change freeze on key rotation; status-page notice if any user impact is possible.
**Order (lowest risk first):** GitHub org/repo → Sentry/GA/status page → Resend (keep domain/DKIM) → AI providers (billing/owner only) → Lob → Supabase org billing/ownership (**never recreate the project**) → Vercel/Cloudflare team → Vapi org → Twilio (ownership/billing; numbers stay) → Stripe (per Phase 3 outcome) → Apple/Google store transfers → registrar registrant change.
**For each system**
- *Pre-checks:* export config; record webhook endpoints, scopes, last rotation; confirm backup owner; snapshot DNS/records; confirm no pending billing failure.
- *Execute:* provider-documented transfer; keep IDs, keys, endpoints and domains unchanged.
- *Verify:* synthetic checks below.
- *Rollback:* provider-specific reverse transfer or revert ownership change; if a key was accidentally rotated, restore from secret store (stored-token keys `BANK_TOKEN_KEY`, `TELEMATICS_ENCRYPTION_KEY`, `ADS_TOKEN_ENCRYPTION_KEY`, `SIEM_ENCRYPTION_KEY` must never change).
**Synthetic verification checklist (run after each step)**
- Login with password, Google/Apple sign-in, and a **passkey** on `app.vireek.com`.
- Stripe: test checkout and billing portal; webhook deliveries (`stripe-webhook`, `stripe-payment-webhook`) return 2xx.
- Voice: test inbound call → `vapi-webhook` receives events; recording notice plays; transcript saved.
- SMS: send/receive on a registered number; opt-out keyword works.
- Email: send via `email-send`; SPF/DKIM/DMARC = PASS (Gmail "Show original"); inbound alias at `in.vireek.com` reaches `email-webhook`.
- Push: web push and one Android + iOS test push.
- Universal links open the app for `/tech`, `/dashboard`, `/login`.
- Custom-domain landing page loads via customer CNAME; `/m/{CODE}` QR redirect works; `/badge-api`, `/feeds/*.xml`, `/.well-known/agent-card.json` respond.
- API/MCP: call with a `vrk_live_` test key from allow-listed client; BI export run succeeds.
- Cron functions still authenticate (`X-Cron-Secret`).

## Phase 5 — Legal cutover and visible changes

**Preconditions:** Phase 4 complete; counsel-approved documents; support briefed.
**Steps**
1. Publish updated legal pages with new effective date and version; archive previous versions **[REQUIRES COUNSEL]**.
2. Turn ON the entity flag from Phase 2 (invoice/footer/legal text); confirm Impressum shows no missing fields.
3. Switch A2P Messaging Service to the approved new brand/campaign; keep old available for rollback.
4. Update provider-facing legal names: OAuth consent screens, store listings/seller name, Stripe statement descriptor/business profile, Lob return address, Meta business profile **[REQUIRES COUNSEL for wording]**.
5. Start issuing invoices/receipts under the new party per tax decision **[REQUIRES TAX]**.
6. Send customer communications (checklist below) within contractual notice periods.
**Verification:** Impressum/legal pages render; invoice PDF shows correct seller; SMS delivery rates normal for 48 h; store listings show correct seller; no spike in auth, webhook or email failures (Sentry + provider dashboards).
**Rollback:** flag OFF (restores previous text); re-point Messaging Service to old brand; republish previous legal versions (kept archived). Legal rollback itself **[REQUIRES COUNSEL]**.

## Phase 6 — Stabilization and cleanup (2-4 weeks)

**Steps:** monitor error budgets and deliverability; rotate secrets that were shared during the project (new values only via secret stores); decommission unused old registrations only after a quiet period and counsel approval; update `OWNER_REGISTER.md`, `docs/compliance/data-map.md`, subprocessors list, and this audit; post-mortem.
**Verification:** zero open Sev-1/2 tied to the change; register current; old A2P brand retired only after 30 days stable.
**Rollback:** keep old accounts read-only until closure sign-off.

## Customer-communication checklist

- [ ] Counsel-approved message: what changes (legal party/paperwork), what does **not** (service, brand, domain, numbers, API keys, integrations, passkeys).
- [ ] Notice period per MSA/DPA satisfied; recipients include each customer's legal/contract contact **[REQUIRES COUNSEL]**.
- [ ] Re-acceptance flow ready only if counsel requires it; no forced logout.
- [ ] Updated DPA/subprocessor notification sent where the processor or subprocessor list changes **[REQUIRES COUNSEL]**.
- [ ] Invoice/remit-to/tax-ID change notice with effective date **[REQUIRES TAX]**.
- [ ] Integrators/API customers: statement that hosts, key prefixes, webhook URLs, IPs/User-Agents are unchanged; changelog entry.
- [ ] Support macros, FAQ and status-page entry; support staff trained; contact addresses unchanged.
- [ ] EU/UK/CA/AU customers: transfer-mechanism wording reviewed **[REQUIRES COUNSEL]**.
- [ ] Partners/marketplaces (Google, directory listings) notified per their rules.
- [ ] Post-change confirmation message after Phase 5 verification.

## Stop conditions (abort and roll back the current phase)

Passkey or login failure rate above normal · Stripe webhook failures · inbound call drops · SMS filtering spike · email DMARC failures · universal links/push failing after store transfer · any unplanned key rotation · counsel withdraws approval.

## Hard "do not change" list during the project

RP ID `vireek.com` · `vireek.com`, `app.vireek.com`, `in.vireek.com` DNS records · custom-domain CNAME target · Supabase project ref and function URLs · bundle IDs/package names · API key prefixes and `X-Vireek-*`/User-Agent strings · VAPID key pair · `BANK_TOKEN_KEY`, `TELEMATICS_ENCRYPTION_KEY`, `ADS_TOKEN_ENCRYPTION_KEY`, `SIEM_ENCRYPTION_KEY` · `/m/*`, `/badge-api/*`, `/feeds/*`, `/lp/*`, `/.well-known/*` routes.
