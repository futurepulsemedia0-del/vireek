# Vireek

**The AI operating system for home service businesses** — plumbing, HVAC, electrical, roofing,
restoration, and beyond. Vireek started as an AI voice receptionist that answers every call
24/7, captures leads, and books appointments so a missed call never becomes a lost job. It has
since grown into the full operating layer a service business runs on: dispatch, CRM, technician
performance, marketing attribution, financial operations, and franchise-scale multi-location
management — all in one system, wired together end to end.

**Live site:** https://vireek.com

## What Vireek does

### Voice AI & call intelligence
Answers, transcribes, and scores every inbound and outbound call; routes by language and intent;
detects emergencies and escalates to a human; flags upsell opportunities and objections; verifies
price accuracy in real time; supports cloned brand voices; and stays compliant with A2P 10DLC
registration and do-not-call suppression.

### Booking & dispatch
A public, no-login booking flow every channel points at (voice, web, referral links); AI-assisted
and manual dispatch with auto-assignment; live ETA tracking; route optimization; double-booking
protection; technician capacity locking; on-call rotation and escalation; and weather- and
demand-driven surge pricing.

### CRM & customer lifecycle
Unified customer records with cross-channel memory; a self-service customer portal for
rescheduling and history; automated no-show and VIP handling; review and referral requests; and
membership plan lifecycle management.

### Technician performance & coaching
Per-technician scorecards — first-time-fix rate, callback rate, utilization, CSAT, revenue — with
rule-based AI coaching notes and training-gap detection, all computed from real job history.

### Financial operations
Per-job cost tracking and true gross-margin profitability; a price book with enforcement and
two-way sync to ServiceTitan and Housecall Pro; quotes with automated follow-ups and BNPL
financing offers; smart payment collection and dunning; cash-flow forecasting; underpriced-job
detection; and a missed-revenue recovery ledger that chases estimate-to-cash gaps automatically.

### Marketing & growth intelligence
Multi-touch marketing attribution from click to campaign; referral programs; regional demand and
competitor data ingestion; cross-tenant benchmarking so an operator can see how they stack up
against similar businesses; and outbound campaign automation.

### Equipment, parts & risk
Equipment lifecycle tracking with failure-risk analysis, parts inventory availability, warranty
intelligence and alerting, and insurance claim status tracking with automated customer texts.

### Enterprise, multi-location & franchise
A franchise command center for multi-location and multi-brand operators; commercial contract and
SLA management; a contractor network hub with labor-sharing and disaster mutual-aid coordination
for overflow and emergency capacity; and enterprise identity (SSO/SCIM) for larger organizations.

### Integrations & developer platform
OAuth-based syncing with Google Calendar, HubSpot, and Jobber; job push/pull with external field
service management systems; a versioned public API with API keys; an event bus for outbound
webhooks; and an automation marketplace for reusable workflows.

### AI & business decisioning
A business decision engine and real-time AI insights surface what needs attention across a
business day; visual AI estimating turns a photo into a tiered quote; and a vertical-specific AI
data pipeline tailors playbooks per trade.

This is not an exhaustive list — the platform spans **150+ database migrations**, **70+ backend
functions**, and **169 dashboard and marketing pages**. See `supabase/migrations/` and
`src/pages/` for the full, current surface area; this README describes the shape of the product,
not every feature in it.

## Stack

- **Frontend:** React 18 + TypeScript + Vite, Tailwind CSS, Framer Motion, React Router
- **Backend:** Supabase (Postgres + Auth + Row Level Security + Edge Functions)
- **Testing:** Vitest (unit), Playwright (end-to-end)
- **Hosting:** Vercel (SPA rewrite configured in `vercel.json`)

## Getting started

```bash
npm install
cp .env.example .env   # fill in your Supabase project values
npm run dev
```

## Scripts

| Command              | Purpose                                       |
| --------------------- | ---------------------------------------------- |
| `npm run dev`         | Start the Vite dev server                      |
| `npm run build`       | Production build                               |
| `npm run typecheck`   | Run `tsc --noEmit` against the app config      |
| `npm run lint`        | Run ESLint                                     |
| `npm run lint:design` | Check adherence to the design system tokens    |
| `npm run format`      | Format the codebase with Prettier              |
| `npm run format:check`| Check formatting without writing changes       |
| `npm run test`        | Run unit tests once (Vitest)                   |
| `npm run test:watch`  | Run unit tests in watch mode                   |
| `npm run test:e2e`    | Run end-to-end tests (Playwright)              |
| `npm run preview`     | Preview the production build locally           |

## Environment variables

Create a `.env` file (never commit it — see `.gitignore`) with:

```
VITE_SUPABASE_URL=your-supabase-project-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, and third-party API keys
for the integrations above) are set via `supabase secrets set ...` for the Edge Functions in
`supabase/functions/` — they are never exposed to the client bundle.

## Project structure

```
src/
  components/     Shared UI, layout, and marketing-section components
  contexts/       Auth, theme, and toast React contexts
  lib/            Supabase client + typed table interfaces, domain logic, pricing/industry data, hooks
  pages/          One file per route (marketing pages + authenticated dashboard pages)
supabase/
  migrations/     SQL migrations (schema + Row Level Security policies)
  functions/      Deno Edge Functions (voice webhooks, dispatch, billing, integrations, AI agents)
e2e/              Playwright end-to-end specs
```

## Database & security

All tenant data (`profiles`, `calls`, `leads`, `jobs`, `team_members`, and every feature table
added since) is protected by Postgres Row Level Security — every policy scopes reads/writes to
the authenticated account, so one business can never query another's data. Enterprise accounts
additionally get SSO and SCIM-provisioned identity. See `supabase/migrations/` for the full policy
set and `src/pages/SecurityPage.tsx` for the public-facing summary.

## Deploying

The project deploys to Vercel out of the box — `vercel.json` rewrites all routes to `index.html`
for client-side routing. Set the two `VITE_*` environment variables above in your Vercel project
settings, then deploy. Edge Function secrets are deployed separately via the Supabase CLI.
