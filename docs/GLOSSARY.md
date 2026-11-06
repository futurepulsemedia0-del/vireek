# Glossary

Terms as used in this repository. Where a term has a deeper document, the link is the source of truth.

| Term | Meaning in Vireek |
|---|---|
| **Tenant / account owner** | One customer business. The tenant boundary is `public.get_account_owner_id()`; policies scope rows with `user_id = get_account_owner_id()` and staff of a business resolve to their owner (`ARCHITECTURE.md`). In TypeScript data access this appears as `accountOwnerId`. |
| **RLS** | PostgreSQL Row Level Security — the enforcement point for tenant isolation. Audit: `docs/security/rls-audit.md`. |
| **Edge function** | Supabase (Deno) function under `supabase/functions/<name>/index.ts`; shared code in `supabase/functions/_shared/`. Inventory: `docs/generated/EDGE_FUNCTIONS.md`. |
| **verify_jwt** | Gateway setting per edge function. `false` means the function must authenticate itself (webhook signature, cron secret, API key). Listed in `supabase/config.toml` and deploy flags; see `RUNBOOK.md` §2.3. |
| **Cron secret** | Shared secret a scheduled function checks (`X-Cron-Secret` / `CRON_SECRET`). Catalog: `docs/generated/CRON_CATALOG.md`. |
| **Function matrix** | Generated static analysis of every edge function's auth/validation: `docs/security/function-matrix.md`. |
| **Dashboard** | The business owner/office web app under `/dashboard/*` (`ProtectedRoute`). |
| **Technician app** | Field app under `/tech/*` (`TechnicianRoute`), also packaged with Capacitor as Vireek Field (`com.vireek.field`). |
| **Staff console** | Vireek-internal admin under `/staff/*` (`StaffRoute`, `is_vireek_staff()`). |
| **Partner** | External partner area guarded by `PartnerRoute`. |
| **Customer portal** | Token-based customer-facing pages (e.g. quote accept, portal history, `/emergency/:token`). |
| **Sarah** | The AI receptionist that answers calls (voice provider: Vapi). Persona: `docs/VOICE_PERSONA_BIBLE.md`. |
| **Shadow Mode** | Trial in which Sarah only observes calls and never speaks or acts; produces a Shadow Card per call and a Day-7 report. `docs/SHADOW_MODE.md`. |
| **Pay-by-phone** | PCI-safe card capture during a call: amount derived server-side, call recording paused and verified, fail-closed. `docs/pci-pay-by-phone.md`. |
| **Dispatch board** | Scheduling/assignment screen (`src/pages/DispatchBoardPage.tsx`). |
| **Trade Packs** | Trade-specific compliance/log modules (e.g. product register, compliance log, usage reports). |
| **MCP server / agent runtime** | Edge functions `mcp-server` and `agent-runtime` exposing scoped tools to external agents; API keys are hashed and rate-limited. See `docs/integrations/agent-readiness.md`. |
| **api-v1** | Public REST API (`supabase/functions/api-v1`, contract `public/openapi.json`, SDK in `packages/sdk`, CLI in `packages/cli`). |
| **Feature flag** | Server-controlled toggle with per-tenant overrides: `docs/FEATURE_FLAGS.md`. |
| **Product surface / Labs** | Which pages are in the main product vs. unverified "labs": `src/lib/surface/surface.manifest.json`, `docs/product-surface.md`. |
| **Claims registry** | Source of truth for public trust claims and their status: `src/lib/trust/claims.ts`, enforced by `npm run claims:check`. |
| **Migration version repair** | Procedure for duplicate/invalid migration versions: `docs/runbooks/migration-version-repair.md`. |
