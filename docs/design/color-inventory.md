# Colour inventory (generated — `node scripts/color/inventory.mjs`)

Measured on the current working tree with the same patterns as `scripts/color/check-colors.mjs`.

| Metric | Count |
|---|---|
| lines with a raw Tailwind palette class | 0 |
| lines with a palette-scale class on a UI utility | 0 |
| `dark:` class occurrences (remaining) | 19 |
| lines with a hex / rgb() / hsl() literal | 258 in 47 files |

## Remaining literals by purpose

| Allowlist category | Files | Lines |
|---|---|---|
| persisted-data-palette | 9 | 73 |
| tenant-brand-data | 20 | 53 |
| token-docs | 1 | 53 |
| document-output | 8 | 39 |
| brand-asset | 4 | 22 |
| third-party-surface | 3 | 14 |
| forced-print-bw | 2 | 4 |

Each category's reason is stored in `scripts/color/color-allowlist.json` (`categories`). Anything under "NOT ON ALLOWLIST" fails `npm run lint:colors`.
