// stryker/base.mjs — shared Stryker options for the mutation-testing pilot (see docs/testing/mutation.md).
// Each stryker/<name>.conf.mjs calls makeConfig() with its own `name` and `mutate` list.
//
// No `break` threshold: this pilot only MEASURES. Do not add a CI gate before a baseline is recorded.

export function makeConfig({ name, mutate }) {
  const concurrency = Number(process.env.STRYKER_CONCURRENCY)
  return {
    $schema: 'https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/core/schema/stryker-core.schema.json',
    testRunner: 'vitest',
    vitest: { configFile: 'vitest.mutation.config.ts' },
    mutate,
    // Only run the tests that actually touch a mutant (needs the vitest runner's per-test coverage).
    coverageAnalysis: 'perTest',
    reporters: ['clear-text', 'progress', 'html', 'json'],
    htmlReporter: { fileName: `reports/mutation/${name}/index.html` },
    jsonReporter: { fileName: `reports/mutation/${name}/mutation.json` },
    tempDirName: `.stryker-tmp/${name}`,
    cleanTempDir: true,
    // Reporting bands only (colours in the HTML report). `break: null` = never fails the run.
    thresholds: { high: 80, low: 60, break: null },
    timeoutMS: 10_000,
    timeoutFactor: 2,
    ...(Number.isInteger(concurrency) && concurrency > 0 ? { concurrency } : {}),
    // The sandbox copy only needs sources + configs. Skipping the heavy folders keeps it small and fast.
    // (node_modules is linked into the sandbox by Stryker.)
    ignorePatterns: [
      'android', 'ios', 'public', 'docs', 'e2e', 'evidence', 'chrome-extension', 'load', 'ops', 'content',
      'knowledge', 'eval', 'worker', 'api', 'services', 'packages', 'patches', 'supabase/migrations',
      '.github', 'dist', 'dist-ssr', 'coverage', 'reports', '.stryker-tmp',
    ],
  }
}
