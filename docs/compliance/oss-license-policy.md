# Open-source licence policy

> **DRAFT engineering policy — [COUNSEL] must approve the allow / review / deny lists before this is relied on.**
> Nothing here is legal advice. Enforcement code: `scripts/supply-chain/license-check.mjs`. Policy data: `config/license-policy.json`.
> Generated inventory: `THIRD_PARTY_NOTICES.md`. CI: `.github/workflows/license-compliance.yml`.

## 1. What is checked

| Source | Included | How the licence is obtained |
|---|---|---|
| npm packages in `package-lock.json` | everything not `dev: true` (optional, peer and devOptional are **included**) | lockfile `license`; if empty, `node_modules/<pkg>/package.json` when installed |
| Edge-function imports (`npm:`, `jsr:`, `https://`) in `supabase/functions` (non-test files) | all | lockfile if the same package is installed there, else `externalImports` in the policy |
| Dev-only npm packages | no (use `--include-dev` for an audit; it currently flags `axe-core` / `@axe-core/playwright` MPL-2.0 and `caniuse-lite` CC-BY-4.0) | — |

**Not covered (no offline source of truth) — [VERIFY]:** Gradle and CocoaPods dependencies of the Capacitor apps, fonts, images, vendored code, and Deno remote imports beyond the ones listed in the notices.

## 2. Rules

* **allow** — permissive licences used as-is: MIT, MIT-0, ISC, BSD-2/3-Clause, 0BSD, Apache-2.0, BlueOak-1.0.0, Unlicense, Zlib, CC0-1.0, Python-2.0.
* **review** — fails unless a time-boxed waiver exists: MPL-2.0 and similar file-level copyleft, EPL/CDDL, LGPL, CC-BY, OFL. **[COUNSEL]**
* **deny** — always fails and **cannot be waived**: GPL, AGPL, SSPL, BUSL, Elastic, CC-BY-NC / -SA, `UNLICENSED`.
* **unknown** — anything not in a list, an unparseable expression, a bare `SEE LICENSE IN …`, or no licence declared: fails.
* **SPDX expressions:** `A OR B` passes if any alternative passes (the best is "elected"); `A AND B` takes the worst; `WITH` never improves a status.
* **Aliases** map legacy strings (e.g. `MIT/X11` → `MIT`) and are reviewed like any other entry. **[VERIFY]**

## 3. Waivers

A waiver is `{ name, version | "*", reason, approvedBy, expires }`, all required. It is honoured only until `expires` (end of that day, UTC);
afterwards the build fails again. A waiver **asserts no licence**; it only records that a named person accepted the risk until a date.
`approvedBy` values beginning `PENDING-` are placeholders created with this change and must be replaced by a real approver or removed.
The weekly scheduled run exists to catch expiry.

## 4. Current state (verified by running the checker on this snapshot, lockfile only)

* 433 production npm packages + 13 edge-function imports: **PASSED with 5 waivers**, 9 unverified entries (`node --test` and CLI results are in the delivery report).
* Waivers: `buffers@0.1.1` (no licence in the lockfile), `@capgo/background-geolocation` and `@capgo/capacitor-nfc` (MPL-2.0), `npm:web-push` and `npm:@resvg/resvg-wasm` (MPL-2.0, from unverified entries).
* `externalImports` entries with `verified: false` were written from general knowledge, **not** confirmed in this environment (no network, no `node_modules`). Confirm each, then set `verified: true`. `--strict-verify` turns remaining ones into failures.
* `node-forge` is recorded as `(BSD-3-Clause OR GPL-2.0)`: the gate elects BSD-3-Clause; keep the election documented. **[VERIFY]**

## 5. Operating the gate

```
npm run licenses:check      # policy + notices freshness (what CI runs)
npm run licenses:notices    # regenerate THIRD_PARTY_NOTICES.md after any lockfile / policy / import change
node scripts/supply-chain/license-check.mjs --json            # report
node scripts/supply-chain/license-check.mjs --include-dev     # audit including build tooling
node scripts/supply-chain/license-check.mjs --strict-verify   # fail on unverified manual entries
npm run test:scripts:licenses
```

Adding a dependency with a new licence: (1) check the package's own LICENSE, (2) add to `allow`/`review`/`deny` only through a reviewed PR, (3) run `licenses:notices`, commit both files.

## 6. Open items

1. **[COUNSEL]** Approve the lists; decide MPL-2.0 handling for the Capacitor plugins and server-side use; decide whether CC-BY-4.0 data (`caniuse-lite`, dev only) matters.
2. **[COUNSEL]** Attribution: the notices file is an inventory. Confirm whether the shipped web bundle and mobile apps must also carry licence **texts** (MIT/BSD/Apache require the notice to travel with redistributed copies) and add a text-bundling step if so (needs `node_modules`).
3. Resolve `buffers` and the `verified: false` entries; replace placeholder approvers.
4. Inventory native (Gradle/CocoaPods) dependencies.
5. Pre-existing CI defects noticed while adding the workflow (not touched): `migrations.yml`, `mobile.yml`, `quality-gates.yml` are not valid YAML, and `ci.yml` has a duplicate `run:` key in one step.
