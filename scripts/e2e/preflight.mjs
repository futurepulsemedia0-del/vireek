#!/usr/bin/env node
// scripts/e2e/preflight.mjs — fail CI early (and loudly) when the authenticated E2E credentials are not configured,
// instead of letting ~all authenticated specs silently skip and the job go green.
//
// Secrets are read by NAME from the environment; values are never printed.
// E2E_REQUIRE_AUTH=0 (fork PRs, where GitHub withholds secrets) downgrades the failure to a warning.
const required = ['E2E_TEST_EMAIL', 'E2E_TEST_PASSWORD'];
const missing = required.filter((n) => !(process.env[n] ?? '').trim());
const requireAuth = (process.env.E2E_REQUIRE_AUTH ?? '1') !== '0';

if (missing.length === 0) {
  console.log('✔ Authenticated E2E credentials are configured (E2E_TEST_EMAIL, E2E_TEST_PASSWORD).');
  process.exit(0);
}
const msg = `Missing E2E credential secret(s): ${missing.join(', ')}. Authenticated specs would be skipped. See docs/TESTING.md → "Authenticated E2E in CI".`;
if (requireAuth) {
  console.error(`::error title=E2E credentials missing::${msg}`);
  process.exit(1);
}
console.log(`::warning title=E2E credentials missing (fork PR)::${msg} Authenticated specs will be skipped on this run.`);
