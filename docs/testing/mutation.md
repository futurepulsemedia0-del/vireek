# Mutation testing (pilot)

Mutation testing answers a question coverage cannot: **would our tests notice if the code were wrong?**
Stryker makes small deliberate bugs ("mutants": `+` becomes `-`, `>=` becomes `>`, a branch is removed) and
re-runs the unit tests. A mutant the tests catch is *killed*; one that slips through *survived* and points at a
missing or weak assertion.

This is a **pilot**. It is run by hand, it measures only, and **no CI gate exists**.

## Scope

| Target | Source under mutation | Tests that must kill the mutants |
|---|---|---|
| `money` | `src/lib/regionConfig/money.ts` | `src/lib/regionConfig/money.test.ts` |
| `compliance` | `supabase/functions/_shared/compliance-rules/{engine,jurisdiction,fmSubmission}.ts` | `engine.test.ts`, `fmSubmission.test.ts` (same folder) |
| `scoring` | `src/lib/fragilityScore.ts` (Business Fragility Score) | `src/lib/fragilityScore.test.ts` |

Why these three: all are pure (no network, no database, no DOM), so a run is deterministic and fast, and all
are places where a silent wrong answer costs real money or creates compliance exposure.

Left out on purpose: `src/lib/pricing.ts` (mostly plan data and links, so mutants would mostly be noise),
`src/lib/regionalPacks/packMoney.ts` (a dependency of `money.ts` with no dedicated test file yet),
seed-rule data files, `types.ts`, and `load.ts` (Supabase I/O).

## How to run

One-time setup (adds the two dev dependencies and updates the lockfile):

```bash
npm install -D @stryker-mutator/core @stryker-mutator/vitest-runner
```

Locally:

```bash
npm run mutation:money
npm run mutation:compliance
npm run mutation:scoring
```

In GitHub: **Actions → "Mutation testing (pilot)" → Run workflow**, pick `all` or one target. Each target runs in
its own job, publishes the score table to the job summary, and uploads `reports/mutation/<target>/` (HTML report +
`mutation.json`) as an artifact for 30 days.

Print a score table from any report:

```bash
npm run mutation:summary -- reports/mutation/money/mutation.json --markdown --title "money"
```

## Reading the result

- **Score** = Killed + Timeout, divided by (Killed + Timeout + Survived + No coverage). Compile errors, runtime
  errors, ignored and pending mutants are not counted (same formula as Stryker).
- **Survived** mutants are the work list. Open `reports/mutation/<target>/index.html`, find the red lines, and for
  each one decide: add an assertion, or accept it as an *equivalent mutant* (a change that cannot alter behaviour).
- **No coverage** means no test executes that code at all.
- The 80 / 60 thresholds in `stryker/base.mjs` only colour the HTML report. `break` is `null`: a low score never fails a run.

## Baseline

**Status: NOT RUN.** The pilot files were added in an environment with no `node_modules` and no network access,
so Stryker could not be installed or executed there. No score has been measured, and none is recorded here
on purpose. The first person to run the workflow fills in the table below.

| Target | Date | Commit | Score | Killed | Timeout | Survived | No coverage | Notes |
|---|---|---|---|---|---|---|---|---|
| money | NOT RUN | | | | | | | |
| compliance | NOT RUN | | | | | | | |
| scoring | NOT RUN | | | | | | | |

To record it: run the workflow on `main`, copy the "Total" row from each job summary into the table, and add the
commit SHA. Do not edit scores by hand afterwards; add a new dated row when the baseline is re-measured.

## Known limitations

- **No TypeScript checker.** Mutants that would not compile are counted by the test runner as runtime errors
  instead of being filtered out up front. They are excluded from the score, but runs are slower than they could be.
  Adding `@stryker-mutator/typescript-checker` needs a tsconfig that covers `supabase/functions/_shared`, which
  `tsconfig.app.json` (`include: ["src"]`) does not.
- **Sandbox copy.** Stryker runs in a copy of the repo with heavy folders skipped (`ignorePatterns` in
  `stryker/base.mjs`). If a module later imports something from a skipped folder, remove that entry.
- **Own vitest config.** `vitest.mutation.config.ts` runs in a plain Node environment and lists the relevant tests
  explicitly. When you add a module to a Stryker config, add its test file there too.
- **Runtime unknown.** The first run time is unmeasured; the workflow allows 120 minutes per job.
- **Versions** of `@stryker-mutator/*` are whatever `npm install -D` resolves; confirm they support the repo's
  Vitest 2.x. [VERIFY]

## Before turning this into a gate

1. Record the baseline above for all three targets.
2. Triage survivors; fix or document equivalent mutants.
3. Only then consider a ratchet (`break` slightly under the baseline) and an incremental run on changed files.
