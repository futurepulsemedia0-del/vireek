FM-portal — Phase 1 Status (Path A, No API)
Date: 2026-11-05. This document records only what was actually completed and measured.
Completed and Verified
- fm_submission layer and 7 fm_* rule types on the compliance-rules engine (without a parallel engine).
- Rule Pack “ServiceChannel Managed 2026” with 8 rules, all in_review (not applied until reviewer approval).
- Migration executed on a real Postgres 16 instance (with stubs for auth/profile tables), twice consecutively (idempotent).
- 89 Vitest tests passing (39 existing engine tests + 50 new tests), and zero axe-core violations on the panel.
- Strict typecheck of new files completed without errors.
Not Completed
- Playwright e2e: not run (the full project build in the zip is broken: AuthContext.tsx and supabase.ts are incomplete).
- ESLint was not run on the new files. check-design-system reported no errors for the new files.
- Rule approval by a human reviewer (Compliance → Rule review): this is a human task.
- Customer-specific rules (other than ServiceChannel Managed), a proposal within 48 hours, and mandatory proposal content: not modeled.
- Removal of the old Guard evaluateOrder/PortalRules: intentionally not done (your local files differ from the zip). There are currently two rule sources: the Guard profile for the Orders/Audit tabs and the approved pack for the “Fix before sending” tab.
- Email-forward and PDF ingestion: not implemented (only Guard CSV is available).
- Saving rejection-learning suggestions as drafts: not implemented; only “Copy for review” is available.
- Official ServiceChannel/Corrigo API: NO-GO according to the memo until legal approval.
