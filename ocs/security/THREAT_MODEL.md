# Threat model (working draft)

Scope: the Vireek multi-tenant SaaS — React SPA on Vercel, Supabase (Postgres + RLS, Auth, Storage, Realtime), Deno edge functions, third-party providers (voice, telephony, payments, AI, email, accounting), Capacitor apps, Chrome extension, public API/MCP. Derived from `ARCHITECTURE.md`, `docs/security/function-matrix.md`, `docs/security/rls-audit.md` and `docs/compliance/data-map.md`. This is an engineering analysis, not an assessment or certification. Review and update when an asset, trust boundary or provider changes.

## Assets
Customer PII (names, phones, addresses, call recordings/transcripts) · payment data (card capture by phone; Stripe) · provider/OAuth tokens (accounting, calendar, ads, bank) · API/agent/device keys · tenant business data (jobs, quotes, invoices) · AI prompts/outputs · audit log · service-role key.

## Trust boundaries
Browser/app → Supabase API (JWT + RLS) · Browser → edge functions (gateway JWT or self-auth) · Providers → webhook edge functions (signature) · Scheduler → cron functions (secret) · External agents → API/MCP (API key + scopes) · Staff console → privileged RPCs (`is_vireek_staff`).

## Threats and existing controls
| # | Threat (STRIDE) | Where | Existing control (evidence) | Gap / follow-up |
|---|---|---|---|---|
| T1 | Cross-tenant read/write (I, T) | Any table | RLS scoped by `get_account_owner_id()`; `scripts/security/rls-audit.mjs`; pgTAP tests | pgTAP CI job is `continue-on-error`; baseline replay issue (`supabase/tests/README.md`) |
| T2 | Forged webhook (S) | `*-webhook`, `*-callback` functions | Signature checks; see `docs/generated/WEBHOOKS.md` for functions with none detected | Review rows marked "none detected"; replay protection is not uniform |
| T3 | Unauthenticated function abuse (S, D) | `verify_jwt=false` functions | Cron/API-key/signature gates; rate limiting on many functions; matrix ratchet in CI | `config.toml` lists fewer `verify_jwt=false` functions than the matrix reports — reconcile |
| T4 | Privilege escalation staff/owner/technician (E) | Routes + RPCs | Route guards (`docs/generated/ROUTES.md`), RLS, staff RPC checks, MFA (AAL2) when enrolled | Confirm every privileged RPC checks role server-side, not only in UI |
| T5 | Secret leakage (I) | Repo, logs, client bundle | gitleaks in `security.yml`; `VITE_*` public by design; RUNBOOK §7 | Rotation cadence undecided |
| T6 | Provider token theft/misuse (I) | Accounting/ads/bank connections | Encrypted token storage (`*_TOKEN_ENCRYPTION_KEY`), OAuth state secrets | Key rotation requires re-encryption plan |
| T7 | Prompt injection / data exfiltration via AI (T, I) | Voice agent, interpreter, Ask Vireek | Grounded prompts, tool gating, `docs/compliance/dpia-voice-ai.md` | Per-tool authorization review for agent tools |
| T8 | Card data exposure (I) | Pay-by-phone | Recording paused and verified, fail closed (`docs/pci-pay-by-phone.md`) | Not a PCI attestation |
| T9 | Malicious input (T) | Edge function bodies | Mostly manual validation; schema validation in few functions | Increase schema validation coverage (matrix "No validation detected") |
| T10 | Supply chain (T) | npm, GitHub Actions | `npm audit`, CodeQL, Dependabot weekly | Pin/review action versions |
| T11 | Repudiation (R) | Admin and data changes | `audit_log` (no client write policy), flag audit | Platform log retention undefined |
| T12 | Availability / cost abuse (D) | AI, SMS, telephony | Rate limits, AI usage logs, capacity guard | Document budgets per provider |
| T13 | Malicious or over-broad extension (I) | Chrome extension | Tokens only in service worker; origin+path only stored | Content script runs on all http(s) pages — keep disclosure accurate |

## Review cadence
Re-run `npm run security:matrix` and `npm run security:rls`, regenerate `docs/generated/WEBHOOKS.md`, and revisit this table at least each time a new provider, public endpoint or role is added.
