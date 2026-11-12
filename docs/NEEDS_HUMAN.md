# Needs human — consolidated (2026-11-12)

Everything here requires you (credentials, legal authority, money, real people, or a live environment). Order = suggested priority.

## A. Do first (unblocks verification)
1. `nvm use` (see `.nvmrc`, Node 22) → `npm ci` → run and record exact counts: `npm run typecheck`, `npx vitest run`, `npm run lint`, `npm run lint:design`, `npm run i18n:keys`, `npm run docs:inventory`, `npx supabase test db` (needs Docker/local Supabase), `npx playwright test`, `npm audit --omit=dev`.
2. Apply the two fixes from `docs/_audit/final-convergence-audit.md` §3 (corrupt `surface.manifest.json`, broken `if` in `scripts/check-design-system.mjs`).
3. Decide on `product-surface-freeze.patch`: apply it (`git apply --check` first) or retire the claims in `docs/product-surface.md`. Then add `docs:surface` / `docs:surface:check` scripts that really exist.
4. Confirm the archived-patch candidates with `git apply --check -R <patch>` in the real git repo before running the move script.

## B. Secrets and keys (only you can do)
5. Confirm `.env` (included in the ZIP) is not in git history and was not shared; rotate the Supabase anon key and Sentry DSN if there is any doubt. Never commit service-role keys.
6. Rotate any credential ever pasted into chats, patches or docs (run `gitleaks` with `.gitleaks.toml` over full history).
7. Store provider secrets (Stripe, Twilio, Vapi, QuickBooks, Resend, OpenAI/Anthropic) only in Supabase/Vercel/GitHub secrets. Provide `CRON_SECRET`-style values for fail-open functions once they are fixed.

## C. Deployments and dashboards (I never deploy)
8. After the migration cleanup is reviewed: rehearse on a branch/staging database, then `supabase db push` yourself. Do not push while 129 duplicate versions exist.
9. Deploy edge functions after the `config.toml` verify_jwt sync (`node scripts/sync-verify-jwt.mjs write`, review the diff first).
10. GitHub settings: enable branch protection and required reviews; set real owners in `.github/CODEOWNERS` (41 `@OWNER_*` placeholders), then enable "Require review from Code Owners"; enable secret scanning, push protection, Dependabot alerts; set Actions default token to read-only.
11. Pin GitHub Actions by SHA (or accept the Dependabot PRs after pinning once).

## D. Product and copy decisions
12. Replace "End-to-End Encryption" in `src/components/sections/SecurityPrivacy.tsx` (line ~29) with a claim the register supports.
13. Approve which of the 21 unclassified routes are Core / Secondary / Unverified, and which pages to retire. I propose only; deletion needs your approval.
14. Decide the canonical "8 criteria" for the scorecard.

## E. External proof (cannot be faked from code)
15. Penetration test by a third party.
16. SOC 2 / ISO 27001 auditor engagement and evidence collection. Do not publish certification claims before the report exists.
17. Legal documents: DPA, subprocessor list, privacy policy and cookie policy review by counsel (`CookiePolicyContent_replacement_sections_4-10.txt` is a draft sitting at the repo root).
18. Vendor applications and approvals: Twilio A2P 10DLC / toll-free verification, Vapi/telephony compliance, QuickBooks app review, Stripe account/compliance, app-store review for iOS/Android (`mobile.yml`, `play-rollout.yml` need Google Play credentials).
19. Real pilots: sign pilot customers, collect real usage, uptime and support data. No metrics, testimonials or benchmarks may be published before they exist.
20. Operations: name an owner for each runbook, schedule incident and kill-switch drills (`kill-switch-drill.yml`), set up on-call and alert routing.
