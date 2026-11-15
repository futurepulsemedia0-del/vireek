# ADR-0001: Infrastructure as code — should Vireek adopt Terraform?

Status: **PROPOSED — recommends NOT adopting Terraform now.** Becomes final when the decision owner signs at the bottom.
Date: 2026-11-14
Decision owner: founder

## Question

Does Terraform (or its fork OpenTofu) add enough value for Vireek's current stack to justify the state, credentials and apply risk it introduces? If yes, add minimal declarative config for **one** resource group. If no, record the decision and stop.

## Evidence basis and labels

Static read of the uploaded repository snapshot. Nothing was run against a live provider account, so dashboards, DNS zones, plans and permissions were not seen.

- **Verified** — read in the repository (path given).
- **Reported** — stated by the founder in conversation; the repository cannot confirm it.
- **[VERIFY]** — a fact that must be checked in a dashboard or with the vendor before anyone relies on it. This includes the current coverage, maturity and version of any Terraform provider named below.
- **[COUNSEL]** — needs legal review (licensing, contractual or audit wording).

## Inventory of managed infrastructure

| # | Surface | Where it is defined today | In the repo? | Left in a dashboard (click-ops) |
|---|---|---|---|---|
| 1 | **Web app + edge worker** on Cloudflare Workers, Worker `vireek` | `wrangler.jsonc` (name, entry, assets, observability, custom-domain routes for `vireek.com` and `www.vireek.com`), `worker/index.ts`, `cf-build.sh` (Verified). Git-connected build, build command `bash cf-build.sh`, deploy `npx wrangler deploy` (Reported). | Yes, mostly | Workers Builds settings, build-time variables and secrets [VERIFY] |
| 2 | **Vercel** | `vercel.json` (rewrites, security headers, CSP), `api/win-card.ts`, `.github/workflows/vercel-preview-smoke.yml` (Verified). The founder reports the move to Cloudflare is in progress; which host serves production is not provable from the repo (see [entity audit](../brand/06-entity-dependency-audit.md), finding 5). | Yes | Project, domains, env vars [VERIFY] |
| 3 | **Supabase project** (Postgres, Auth, Storage, Edge Functions, pg_cron) | 779 migration files in `supabase/migrations/`; `supabase/config.toml` holds `verify_jwt` per function; about 480 function directories deployed by `.github/workflows/edge-functions.yml` (`supabase functions deploy --use-api`, secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`); about 110 distinct pg_cron job names and the storage buckets are created in SQL (Verified). | Yes, strongly | Plan, region and compute size, Auth settings (site URL, redirect allow-list, providers, passkey RP ID per `docs/AUTH_PASSKEYS_SOCIAL_LOGIN_ALERTS.md`), function secret values, backups and PITR [VERIFY] |
| 4 | **DNS and domains** — `vireek.com` zone on Cloudflare (Reported); registrar [VERIFY]; business mailbox on Namecheap Private Email with MX/SPF/DKIM/DMARC that must stay intact (Reported); Resend sending-domain records; `status.`, `app.`, `in.` (inbound email) subdomains; customer landing-page CNAME target | **Nothing.** Only a checklist, [`docs/EMAIL_DELIVERABILITY.md`](../EMAIL_DELIVERABILITY.md); the entity audit confirms the records are not in the repo (Verified). | **No** | Everything |
| 5 | **Monitoring** — synthetic probes + SLOs + public status feed; Grafana Cloud dashboard; Sentry/GlitchTip; GA4 | Probes, SLO definitions, incident tables, cron ticks and edge functions are in SQL/TS ([runbook](../runbooks/synthetic-monitoring.md)). Grafana dashboard JSON is in `ops/grafana/voice-observability.dashboard.json` but is **imported by hand**; alert rules deliberately live in code, not in Grafana ([runbook](../runbooks/voice-observability.md)). Sentry and GA4 are only DSN/measurement-ID env vars (Verified). | Mostly | Grafana data source and import, Sentry project and alert settings, status-page DNS [VERIFY] |
| 6 | **GitHub** — repo, Actions, secrets | 21 workflows in `.github/workflows/` (Verified) | Workflows yes | Repo and branch-protection settings, Actions secrets |
| 7 | Vendor control planes (Stripe, Twilio, Vapi, Resend, Apple, Google) | Callback URLs and keys referenced in code and docs | Partly | Configured in each vendor's UI. Not infrastructure for this decision. |

No `*.tf`, `*.tfvars`, Pulumi or OpenTofu file exists anywhere in the snapshot (Verified by file search).

### What the inventory says

Rows 1, 3, 5 and 6 are already declarative in the tool that owns them (`wrangler.jsonc`, migrations plus `config.toml` plus CI, SQL, workflows). The only large undeclared surface is **row 4, DNS**, followed by a handful of dashboard-only settings in rows 1, 3 and 5.

## Assessment

| Criterion | Finding |
|---|---|
| **Reviewability / audit trail** | The real gain, and it applies to DNS and dashboard settings only. Today a DNS change has no pull request, no reviewer and no history outside the Cloudflare audit log [VERIFY]. |
| **Drift detection** | Useful for DNS. Little value for rows 1, 3, 5 and 6 because the repo already is the source of truth and CI redeploys it. |
| **Disaster recovery** | DNS could be rebuilt from code. The Supabase project could not: the project reference is hard-coded in `vercel.json`, `api/win-card.ts`, `public/openapi.json` and in customer-facing webhook URLs, so recreating the project is not a recovery path, and Terraform would not change that (entity audit, finding 6). |
| **Second environment** | None evidenced (one production project; CI replays migrations on a local database). Terraform's strongest argument, environment parity, does not apply yet [VERIFY]. |
| **Overlapping sources of truth** | A Terraform Cloudflare Worker resource would duplicate `wrangler.jsonc`; a Terraform Supabase resource would sit beside migrations, `config.toml` and the CLI. Two writers to one resource is the classic way to cause drift, not prevent it. |
| **Moving target** | The hosting move from Vercel to Cloudflare is in flight (Reported). Code written now would either encode resources about to be retired or freeze a half-finished cutover. |
| **Blast radius of a mistake** | High for the one thing worth managing. Dropping or duplicating an SPF record or an MX record breaks mail; the entity audit rates that risk **H** and warns never to publish two SPF records. A first `apply` against an imported zone is exactly where that mistake happens. |
| **New secrets and state** | Adds a state backend with locking, and a CI token with edit rights on the zone, to a repository whose audit already found a populated `.env` inside a shared archive (entity audit, finding 7). That is more to protect for a low change rate. |
| **Tooling choice** | Terraform's licence changed in 2023; OpenTofu is the fork. Choosing between them is a licensing question **[COUNSEL]**, and provider coverage and maturity for Cloudflare, Supabase, Vercel, Grafana and Sentry must be checked first **[VERIFY]**. |
| **Team size and change rate** | Not knowable from the repo. Infra changes appear rare compared with feature changes; one infra-capable person is assumed **[VERIFY]**. |

## Options considered

| | A. Do nothing new (status quo) | B. Terraform/OpenTofu for the DNS zone only | C. Terraform/OpenTofu for everything | D. Native config stays authoritative; revisit IaC on triggers |
|---|---|---|---|---|
| Fixes the DNS audit-trail gap | No | Yes | Yes | Not until a trigger fires |
| New credentials / state | None | Yes | Yes, many | None |
| Overlap with `wrangler.jsonc`, `config.toml`, migrations | None | None | **Heavy** | None |
| Risk during the hosting migration | None | Medium: imports a zone that is still changing | High | None |
| Cost to adopt | 0 | Low-medium | High | 0 now |

## Decision

**Option D. Do not adopt Terraform now, and add no Terraform files.**

1. The native, already-declarative files remain the source of truth: `wrangler.jsonc`, `supabase/config.toml` with the migrations, `vercel.json` while Vercel exists, and the workflows.
2. Terraform would change one meaningful thing today (DNS review history) and in exchange adds state, a zone-edit credential and an apply step that can break email, during an unfinished hosting migration.
3. This ADR is the record. Nothing else is added.

## Revisit when any one of these is true

1. The hosting migration is finished and has been stable for a full quarter (so the config is not a moving target).
2. A second environment or a second zone needs to match production.
3. A DNS or dashboard-setting change causes an incident or a near-miss.
4. More than one person needs to change DNS, Supabase or Cloudflare settings and a reviewed trail is wanted.
5. A customer, auditor or insurer asks for change-managed infrastructure **[COUNSEL]**. Do not describe infrastructure as change-controlled in any external document until it is.

### If revisited, the first and only resource group

The Cloudflare DNS zone for `vireek.com`. Constraints for that work:

- Import the live records first and require an **empty `plan`** before the first apply.
- Mark MX, SPF, DKIM and DMARC records `prevent_destroy`; keep exactly one SPF record per name.
- Remote state with locking, no secrets in state, and an API token scoped to DNS edit on that one zone.
- Do not manage the Supabase project resource, Supabase Auth settings or Worker resources in the same change.
- Decide Terraform versus OpenTofu first **[COUNSEL]**, then pin and verify provider versions **[VERIFY]**.

## Consequences

- **Positive:** no new credentials, state or apply risk; no second source of truth beside the CLIs the stack already uses; nothing to unwind if the hosting plan changes.
- **Negative:** DNS and dashboard-only settings stay manual and unreviewed. Recovery of those settings after an account problem is manual.
- **Residual risks to track:** records for email authentication exist only in the DNS dashboard; the Supabase project reference stays hard-coded; `vercel-preview-smoke.yml` depends on Vercel preview deployments and will need a replacement or removal when Vercel is retired [VERIFY].

## Open items (not resolved by this ADR)

- [ ] Which host serves production today (Cloudflare Worker or Vercel) **[VERIFY]**
- [ ] Registrar, and who holds admin on the Cloudflare, Supabase, Vercel and GitHub accounts **[VERIFY]**
- [ ] Whether a staging Supabase project exists **[VERIFY]**
- [ ] A current export of the DNS records, stored somewhere access-controlled **[VERIFY]**
- [ ] Terraform versus OpenTofu licensing position **[COUNSEL]**

## How the inventory counts were taken

`ls supabase/migrations | wc -l` (779); directories under `supabase/functions` excluding `_shared` (about 480); distinct `cron.schedule('<name>'` names across the migrations (about 110); `ls .github/workflows` (21). File search for `*.tf`, `*.tfvars`, `Pulumi*`, `*.tofu` returned nothing. Counts come from the uploaded snapshot and may differ from the working tree.

## Sign-off

Decision owner: ____________________  Date: ____________  Decision: [ ] accepted  [ ] changed to: ____________
