# Agent Readiness

Audit + approved auto-fix for how complete, consistent and machine-readable a customer's public business data is.
A readiness score, **not** a ranking: nothing here predicts where Google, Gemini or ChatGPT will show a business.

## Pieces
| Piece | Where |
|---|---|
| Scoring engine, rules, fix planner (pure) | `supabase/functions/_shared/agent-readiness/{rules,engine,siteAudit,monitoring}.ts` |
| SSRF/robots-guarded page fetch | `.../urlGuard.ts`, `.../fetchPage.ts` |
| Owner scan / weekly cron / public tool | `supabase/functions/agent-readiness-{scan,cron,public}` |
| Tables + RPCs (RLS, apply/undo) | `supabase/migrations/20281101000000_agent_readiness.sql` |
| Dashboard `/dashboard/agent-readiness`, public `/agent-readiness` | `src/pages/AgentReadiness*.tsx` |

## Honesty rules (enforced in code + tests)
- Unmeasurable checks are `not_measured`, never 0; the score re-weights over what was measured and shows `coverage`.
- Nothing is saved until the owner approves a diff; apply only writes the server-stored `after` text and only if the row still equals `before`; every apply is undoable.
- AI-visibility results are samples (no collector ships yet; the engine accepts samples and labels them).
- Every rule links to its Google/web.dev source; rules that may change carry a "may change" badge. **Re-verify every link by `reviewBy` (2027-02-01).**

## Deploy
    supabase db push
    supabase secrets set AGENT_READINESS_HASH_SALT=<32+ random chars> AGENT_READINESS_CRON_SECRET=<random>
    supabase functions deploy agent-readiness-scan
    supabase functions deploy agent-readiness-public --no-verify-jwt
    supabase functions deploy agent-readiness-cron --no-verify-jwt
Schedule `agent-readiness-cron` daily with header `X-Cron-Secret` (accounts are re-scanned when their last scan is >6 days old).

## Not built yet
Google Business Profile read (categories/photos/attributes/suspension), NAP directory checks, AI-visibility sampling,
GBP hours/review-reply auto-apply, hosted JSON-LD page, LLM-written descriptions, call-to-answer time, lead-volume chart (calls only).
