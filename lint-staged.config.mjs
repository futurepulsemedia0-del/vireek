// lint-staged.config.mjs
//
// Runs from .husky/pre-commit on the STAGED files only (lint-staged stashes unstaged changes first, so what is
// checked is exactly what is committed). Three gates, per the local quality-gate task:
//   1. secret scan   every staged file            node scripts/secret-scan.mjs
//   2. lint          staged .ts/.tsx/.js/.mjs      eslint --max-warnings=0
//   3. typecheck     any staged .ts/.tsx           tsc over the app project (type errors are cross-file, so the
//                                                  command is project-wide and runs ONCE, not per file)
//
// Skipping the hook (`git commit --no-verify`) is possible for emergencies; CI re-runs the same checks, so a
// skipped hook can never reach main unreviewed.

const quote = (f) => `"${f.replace(/"/g, '\\"')}"`;

export default {
  '*': (files) => `node scripts/secret-scan.mjs ${files.map(quote).join(' ')}`,
  '*.{ts,tsx,js,jsx,mjs,cjs}': (files) => `eslint --no-warn-ignored --max-warnings=0 ${files.map(quote).join(' ')}`,
  '*.{ts,tsx}': () => 'npm run typecheck',
};
