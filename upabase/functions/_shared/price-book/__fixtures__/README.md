# Jobber fixtures

Files here are **hand-authored from the response shapes documented by Jobber** (and the shapes this repo already parses).
They are NOT yet recordings of a real sandbox account. **[VERIFY]** every shape against the live API.

To replace them with real, redacted recordings from a Jobber developer test account:

    JOBBER_SANDBOX_TOKEN=<access token of a TEST account> node scripts/jobber/record-fixtures.mjs --i-am-on-a-test-account

The sandbox contract suite (`jobberSandbox.live.test.ts`, run with `npx vitest run -c vitest.live.config.ts`) skips itself unless
`JOBBER_SANDBOX_TOKEN` is set, so CI never touches a real account.
