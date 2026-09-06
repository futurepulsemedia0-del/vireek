# Vireek

AI voice receptionist for home service businesses (plumbing, HVAC, electrical, roofing,
restoration). Vireek answers every call 24/7, captures leads, books appointments, and syncs
with your CRM — so a missed call never becomes a lost job.

**Live site:** https://vireek.com

## Stack

- **Frontend:** React 18 + TypeScript + Vite, Tailwind CSS, Framer Motion, React Router
- **Backend:** Supabase (Postgres + Auth + Row Level Security + Edge Functions)
- **Hosting:** Vercel (SPA rewrite configured in `vercel.json`)

## Getting started

```bash
npm install
cp .env.example .env   # fill in your Supabase project values
npm run dev
```

## Scripts

| Command            | Purpose                                  |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Start the Vite dev server                |
| `npm run build`     | Production build                         |
| `npm run typecheck` | Run `tsc --noEmit` against the app config |
| `npm run lint`      | Run ESLint                               |
| `npm run preview`   | Preview the production build locally     |

## Environment variables

Create a `.env` file (never commit it — see `.gitignore`) with:

```
VITE_SUPABASE_URL=your-supabase-project-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

Server-only secrets (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`) are set via
`supabase secrets set ...` for the Edge Functions in `supabase/functions/` — they are never
exposed to the client bundle.

## Project structure

```
src/
  components/     Shared UI, layout, and marketing-section components
  contexts/       Auth, theme, and toast React contexts
  lib/            Supabase client + typed table interfaces, pricing/industry data, hooks
  pages/          One file per route (marketing pages + authenticated dashboard pages)
supabase/
  migrations/     SQL migrations (schema + Row Level Security policies)
  functions/      Deno Edge Functions (usage alerts, AI insights, demo chat)
```

## Database & security

All tenant data (`profiles`, `calls`, `leads`, `jobs`, `team_members`, etc.) is protected by
Postgres Row Level Security — every policy scopes reads/writes to `auth.uid()`, so one
account can never query another account's data. See `supabase/migrations/` for the full
policy set and `src/pages/SecurityPage.tsx` for the public-facing summary.

## Deploying

The project deploys to Vercel out of the box — `vercel.json` rewrites all routes to
`index.html` for client-side routing. Set the two `VITE_*` environment variables above in
your Vercel project settings, then deploy.
