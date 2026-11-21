# Runbook — package.json script references

`npm run check:script-refs` (CI: `.github/workflows/package-script-refs.yml`) fails when a `package.json`
script points at something that does not exist, or when `package.json` has a duplicate key.

## What it checks

| Check | Example it catches |
|---|---|
| A file the script runs must exist | `"sbom": "node scripts/supply-chain/sbom.mjs"` with no such file |
| Entry file, `node --test` files, `-c`/`--config` and `tsc -p` values, `playwright test <spec>`, direct `./x.sh` | `"test:built": "vitest run -c vitest.built.config.ts"` |
| `npm run <name>` must name a defined script | `"docs:all": "npm run docs:inventory && ..."` |
| No duplicate keys (`JSON.parse` silently keeps the last one) | two `"build"` entries |

Not evaluated: `$VAR`, `$(...)`, globs and braces (skipped, never reported); arguments after a script's
entry file (they may be output paths). Zero dependencies, offline.

## Baseline (ratchet)

Known broken references that existed before the check are listed in
`scripts/package-script-refs.baseline.json`, each with a note. They print as warnings and do not fail CI.

- A **new** broken reference fails CI.
- A baselined reference that is now **fixed** also fails CI ("delete it from the baseline"), so the list can only shrink.
- `node scripts/check-package-script-refs.mjs --strict` ignores the baseline. Use it on release branches.

## When the check fails

1. Read the `::error` line: it names the script and the missing target.
2. Fix it in one of two ways: create the missing file, or delete/repair the script. Do not add a new baseline entry to get a PR green.
3. If you fixed a baselined entry, delete it from the baseline JSON.
4. `node --test scripts/check-package-script-refs.test.mjs` runs the checker's own tests.

`--write-baseline` regenerates the file from the current state and keeps existing notes. Review the diff:
the baseline should never grow in a normal PR.
