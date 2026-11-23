# Plain-language standard for customer-facing copy

Customers read our texts and emails on a phone, often in a hurry or under stress (a broken furnace, a leak). Short sentences and common words get them to the right action faster. This page defines how we measure that and what the check does.

## What is scored

`scripts/content/readability.mjs` scores the **English** copy of:

| Channel | Source read by the script |
|---|---|
| `sms`, `email` | `STARTER_TEMPLATES` in `src/lib/messageTemplates.ts` |
| `sms`, `email` | `DEFAULT_TEMPLATES` in `supabase/functions/_shared/lifecycle/lifecycleCore.ts` |
| `quote` | quote and estimate follow-up messages in `src/lib/workflowPlaybooks.ts` (string literals that mention a quote or estimate) |

Not scored (known gaps): templates that owners write themselves in the app, messages assembled from template literals at runtime (for example in `src/lib/quoteWorkspace.ts`), PDFs, and every non-English locale. The formulas are calibrated for English; applying them to other languages would give misleading numbers, so those are skipped rather than guessed. Adding a language needs a validated formula for it [VERIFY].

Before scoring, copy is normalised the way a customer would read it: `{{name|fallback}}` becomes the fallback, other variables become one short word, link variables and URLs are dropped, and the required opt-out line is excluded (it is fixed wording we do not control for style).

## Metrics

- **Reading ease** (Flesch): `206.835 − 1.015 × words/sentence − 84.6 × syllables/word`. Higher is easier.
- **Grade level** (Flesch-Kincaid): `0.39 × words/sentence + 11.8 × syllables/word − 15.59`. Roughly the US school grade needed to read it.
- **Longest sentence**, in words.

Syllables are counted with a heuristic, not a dictionary. It can be off by a syllable on unusual words, consistently across templates, so treat scores as a comparison tool, not an exact grade. Copy under 12 words is only checked for sentence length because grade and ease are unreliable on text that short.

## Thresholds

Defaults live in `config/readability.config.json`. They are editorial targets chosen by us, not a legal standard.

| Channel | Max grade | Min ease | Max sentence (words) |
|---|---|---|---|
| sms | 8 | 60 | 20 |
| email | 9 | 55 | 25 |
| quote | 8 | 60 | 22 |

To accept a specific template above the limit, add an entry under `overrides` keyed by the template id printed by the script, with the changed limits and a required `reason`. Overrides without a reason fail config validation.

Whether any plain-language statute or regulator guidance applies to our messages, and whether these targets satisfy it, is [COUNSEL]. Nothing here is a compliance claim.

## How CI behaves

`npm run lint:readability` prints the templates above threshold and, in GitHub Actions, emits a `::warning` annotation per template plus a job-summary table. **It never fails the build.** The exit code is 0 unless `--strict` is passed, which is available for turning the check into a gate later.

Other flags: `--json` prints machine-readable results.

## Writing guidance

- One idea per sentence. Put the action first: "Call us to change it", not "Should a modification be necessary, please contact us".
- Prefer everyday words: "start" over "commence", "cost" over "remuneration".
- Say who, what, when. Use the customer's words for the service.
- If a sentence runs past about 20 words, split it.

## Tests

`npm run test:scripts:readability` (Node's built-in test runner). Covers syllable counting, a hand-computed score, sentence splitting, template normalisation, thresholds and overrides, config validation, quote extraction, and the warn-only exit codes.
