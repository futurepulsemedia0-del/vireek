# Partner programme status

Last updated: 2026-11-03 · Detail and sources: `docs/integrations/partner-requirements-matrix.md`.
Owner column is **TBD** everywhere because no owner is named in the repo — assign one per row.
"Needs you" = needs an application, fee, legal signature or partner-manager approval that code cannot supply.

| Platform | Programme / gate | State today | Owner | Blockers | Next steps |
|---|---|---|---|---|---|
| ServiceTitan | App Marketplace Program → certification → annual re-cert | **Not applied.** Current connect flow collects customers' App Keys (prohibited "tunneling") | TBD | Needs you: application, annual dues, tenant fee/rev-share, certification calls. Sandbox not available | 1) Apply. 2) Stop onboarding new customers via App Key until certified (decision needed). 3) Fill Data+API questionnaire from security pack §3. 4) Build against sandbox |
| Housecall Pro | Unknown public programme (UNVERIFIED) | API-key connect works for MAX-plan customers only | TBD | Needs you: contact HCP partnerships | Ask for OAuth app + programme + sandbox; add 429/backoff; encrypt key |
| Jobber | Developer Center review → marketplace | Built as Draft app; no disconnect/webhooks | TBD | 2FA on dev account; >5 paying accounts in Draft gets blocked; no test account suite | Enable 2FA, pre-submission checklist, add disconnect + APP_DISCONNECT webhook (verify schema in GraphiQL), unify API version, THROTTLED backoff |
| QuickBooks | App assessment questionnaire (mandatory for production) → optional App Store | Technically strongest integration | TBD | Needs you: questionnaire, production keys, EULA/privacy/disconnect/launch URLs | Submit questionnaire (answers in security pack §2); configure URLs; decide on App Store listing |
| Google | Actions Center partner (12–16 wks); Business Profile API access + OAuth verification | Feed + owner-approved GBP sync built; **no Booking Server**; Calendar tokens plaintext | TBD | Needs you: interest form, API access request, verification; vertical choice | Move Google tokens to encrypted store first; submit forms; build Booking Server in sandbox |
| HubSpot | Public app listing (≥3 installs) → certification (≥60 installs, 6 months) | OAuth stub only; unused scopes | TBD | Needs you: public app + Tech Partner agreement | Decide whether to build real sync; otherwise do not list |
| Microsoft | Publisher verification → Publisher Attestation → M365 Certification | Calendar functions exist (not audited) | TBD | Needs you: Cloud Partner Program enrolment; eligibility check | Audit `microsoft-calendar-*` token storage; enrol; verify publisher |
| Cross-cutting | Security evidence | No SOC 2 / ISO / evidenced pen-test; owner TBD | TBD | Needs you: pen-test engagement, owner | Commission pen-test; close P0 items below |

## P0 engineering list (before any partner review) — code delivered 2026-11-04, NOT yet deployed/verified in your environment
1. Encrypt all provider credentials — **code done** (`provider_credentials` vault, backfill, dual-read); **you must deploy + backfill + scrub** (runbook). GBP still open (no connect flow).
2. Decide ServiceTitan onboarding policy (tunneling).
3. Disconnect/offboarding — **`provider-disconnect` done**; UI button not wired; remote revoke only for Google; Jobber APP_DISCONNECT webhook still open.
4. `oauthState.ts` fix delivered; `can_manage_*` checks on Jobber/HubSpot/Google starts **still open**.
