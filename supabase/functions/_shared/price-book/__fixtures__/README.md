# Contract fixtures — READ FIRST

These JSON files are **SYNTHETIC**: they were written by hand to contain exactly the fields our clients read
(servicetitan.ts, jobber.ts, housecallpro.ts). They were **NOT recorded from live provider APIs** (no sandbox access
existed when they were written), so they prove "our client still behaves as coded", NOT "the provider still behaves like this".

To turn them into real contract tests: record one real response per file from a sandbox/test tenant (strip PII and
secrets), replace the file, and keep the test unchanged. Any provider-side shape change then fails CI.
