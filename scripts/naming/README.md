# Naming screen (dev script)

A standalone Node script that **screens** candidate brand names for cheap warning signals and
produces a manual-verification checklist. It is not imported by the app, ships in no bundle, and
runs only when you start it by hand.

> **This tool is a screen, not clearance.** It does not search any trademark register, it never
> states that a name or domain can be obtained, and a clean result proves nothing. Every manual
> check is **NOT DONE** until a human completes it. **Final trademark clearance requires a
> qualified attorney.**

## Usage

```bash
# names.json: ["vireek", "nexora", ...]  (or CSV with a "name" column, or one name per line)
node scripts/naming/screen.mjs --input names.json
# or: npm run naming:screen -- --input names.json
```

| Option                | Default                      | Meaning                                                              |
| --------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `--input <file>`      | required                     | JSON (`[...]`, `{"names": [...]}`, `[{"name": ...}]`) or CSV         |
| `--brands <file>`     | `config/known-brands.json`   | Brand list for the lookalike check (array or `{"brands": [...]}`)    |
| `--affixes <file>`    | `config/affixes.json`        | `{"prefixes": [...], "suffixes": [...]}` for saturation flags        |
| `--out-dir <dir>`     | `scripts/naming/out/`        | Output directory (git-ignored)                                       |
| `--weights <k=v,...>` | 25/20/25/15/15               | Keys: `pronounceability,internationalFit,lookalike,domainSignal,manualCheck`; normalised to 100 |
| `--timeout-ms <n>`    | 8000                         | Per-request timeout                                                  |
| `--retries <n>`       | 2 (max 5)                    | Retries after the first attempt (backoff, honours `Retry-After`)     |
| `--min-interval-ms`   | 1000 (floor 500)             | Minimum spacing between requests to the same RDAP host               |

Names must be 4-8 letters (accents are folded, so `Café` becomes `cafe`). Invalid names and
duplicates are listed in the report, never silently dropped. Up to 200 names per run.

Output files are timestamped (`naming-screen-<UTC>.md` / `.csv`) and are written with an exclusive
flag, so a later run can never overwrite a CSV where you recorded manual results.

## What it checks

1. **Linguistic / phonetic** (`lib/linguistic.mjs`): length; a language-neutral pronounceability
   score (vowel/consonant runs, ratios, silent or irregular spellings); international fit across
   English, Spanish, French, German, Portuguese, Arabic, Mandarin, Japanese and Hindi (hard letters
   and clusters, per-language scores, weakest language); prefix/suffix saturation flags.
2. **Lookalike** (`lib/lookalike.mjs`): Levenshtein distance, a simple vowel-agnostic phonetic key
   and containment against your brand list. The shipped list is a small starter set, not a register.
3. **Domain signal** (`lib/rdap.mjs`): RDAP via the IANA bootstrap for `.com .ai .io .co`, one
   request at a time with per-host spacing, timeout, and retry with backoff. Each cell holds
   exactly one of:
   - `registered`
   - `no RDAP record found (UNVERIFIED, confirm at a registrar)`
   - `lookup error`

   A missing record can come from reserved names, registry policy, throttling or server quirks.
   Confirm at a registrar before relying on it.
4. **Manual checklist** (`lib/checklist.mjs`): WIPO Global Brand Database, USPTO Trademark Search,
   EUIPO eSearch plus and TMview, for Nice classes 9, 35, 36, 42 and 44, with spelling variants to
   search, social handle URLs, registrar confirmation, a native-speaker meaning review and the
   attorney review. URLs were correct when written; confirm they still resolve.

## Scoring sheet (CSV)

Columns: scores (0-100), the four domain cells, flags, the manual cells (all `NOT DONE`),
`manual_check_status`, `manual_check_score` and `weighted_total`.

- Lookalike enters the total as `100 - risk`.
- The manual component is 0 until cells are `DONE`, and the total is calculated when the file is
  generated. No name can reach the top score before manual verification.
- A missing domain signal counts as 0.
- The total is a sorting aid, not a verdict.

## Limits

- No trademark register is queried. Prior rights, similar goods and services, and non-Latin marks
  are out of scope.
- Phonetic and language rules are coarse heuristics, not linguistic authority.
- The brand and affix lists are starter sets; extend them for your market.
- Social handles are not automated (platform terms); check them by hand.

## Tests

```bash
npx vitest run scripts/naming
```

Tests use mocked network responses only; `globalThis.fetch` is replaced with a function that
throws, so any real request fails the test.

## Persian summary (خلاصه فارسی)

این ابزار فقط **غربالگری** است، نه ارزیابی حقوقی. هیچ پایگاه ثبت علامت تجاری را جست‌وجو نمی‌کند و
هرگز نمی‌گوید نام یا دامنه‌ای قابل ثبت است. نتیجهٔ دامنه فقط یکی از سه حالت `registered`،
`no RDAP record found (UNVERIFIED, confirm at a registrar)` یا `lookup error` است. همهٔ بررسی‌های
دستی تا انجام توسط انسان `NOT DONE` می‌مانند و **تأیید نهایی علامت تجاری باید توسط وکیل انجام شود**.
