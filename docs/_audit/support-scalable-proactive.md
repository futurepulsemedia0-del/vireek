# Audit — support-scalable-proactive

## Verified (static, from the uploaded ZIP — may be older than the working tree)
Tickets (support_conversations kind='ticket'), Help Center route mapping, status incidents + status-feed + synthetic monitoring,
export-run (CSV/XLSX/PDF), tenant-export (tar+NDJSON, no UI), delete-account, data-retention-sweep, owner-only audit log page,
CODEOWNERS (placeholders). Not found: health score, report-a-problem diagnostics, in-app incident banner, customer alerts, OWNERS.md.

## Changed / added
supabase/migrations/20290304000000_support_proactive_health.sql; supabase/tests/database/support_proactive_health.test.sql;
supabase/functions/proactive-alerts-tick/index.ts; src/lib/{customerHealth,supportDiagnostics}.ts (+ .test.ts);
src/components/support/SupportDock.tsx; src/components/status/IncidentBanner.tsx; src/components/FullExportButton.tsx;
src/pages/StaffCustomerHealthPage.tsx; scripts/governance/check-owners.mjs; scripts/scale-limits-scan.mjs;
docs/OWNERS.md; docs/SCALE_READINESS.md; docs/runbooks/post-incident-template.md.
Edited: supportTicketsApi.ts, DashboardNav.tsx, App.tsx, ExportsPage.tsx, .github/workflows/ci.yml.

## Verification
PASSED: 14 unit tests via ad-hoc shim; tsc --strict on the two pure libs; check-owners warn/strict; scale-limits-scan (23 findings).
NOT RUN: vitest, full tsc, eslint, build, SQL migration, pgTAP, e2e, edge function, k6.

## Not done
Real forwarding health check; email/SMS alert channel; tenant-export covers 6 tables only; deletion/retention flow not verified end to end;
status components for DB/payments/sync unverified; 10x load test; pgTAP for diagnostics trigger (needs support_conversations required columns).

## Residual risks
Fixed row caps in 23 scheduled reads; heuristic alerts may false-positive; SupportDock is fixed-position and may overlap mobile UI.

## Needs human (manual)
Run migration on staging, then deploy proactive-alerts-tick, set CRON_SECRET, create the 30-minute cron; assign owners in docs/OWNERS.md and CODEOWNERS;
enable Code Owners review; run npm run typecheck, lint, test, supabase test db; decide alert channels.
