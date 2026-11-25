# Trade vocabulary library

Versioned glossary per trade and regional dialect. Feeds the live voice prompt and, once verified, STT biasing.

## What exists
| Piece | Where |
|---|---|
| Tables, RLS, staff RPCs | `supabase/migrations/20290312000000_trade_vocabulary.sql` |
| Pure logic (sanitise, merge, compile) | `supabase/functions/_shared/trade-vocab/vocab.ts` |
| Loader (cache, fail-open, flag) | `supabase/functions/_shared/trade-vocab/loader.ts` |
| Prompt wiring | `vapi-webhook`: variable `{{trade_vocabulary}}` |
| Staff editor | `/staff/trade-vocabulary` |
| Evaluation | `scripts/voice/trade-vocab-eval.mjs` |

## Rules
- Platform content only: no tenant or personal data, no per-account scoping by design. Staff-only read and write.
- Edits are drafts. **Publish** freezes the active entries as an immutable version; the runtime reads only published versions.
- Layers, lowest to highest priority: `general/en` → `general/en-US` → `<trade>/en` → `<trade>/en-US`. A higher layer replaces the same term wholesale.
- A term is a word or short phrase (max 6 words, 80 chars). No line breaks, quotes, braces, angle brackets.
- Retire entries instead of deleting them.

## Turn it on
1. Apply the migration. 2. Add `{{trade_vocabulary}}` to the Vapi assistant prompt (dashboard). 3. Publish at least one version. 4. Set `TRADE_VOCAB_ENABLED=true` on the `vapi-webhook` function.
Optional: `TRADE_VOCAB_MAX_PROMPT_CHARS` (default 1200), `TRADE_VOCAB_MAX_KEYTERMS` (default 50, TODO(owner): confirm provider limit).

## STT biasing: NOT wired
`compileVocabulary().keyterms` is ready and tested, but nothing sends it to the transcriber. The repo does not show which transcriber provider the live assistant uses, and the field name and limits differ per provider.
TODO(owner): tell me the transcriber provider/model configured on the Vapi assistant, then verify its keyword/keyterm option against the current Vapi docs before wiring.

## Evaluation (real numbers only)
No labeled calls exist in the repo, so no before/after numbers have been produced.
TODO(owner): provide labeled calls (reference transcript, baseline transcript without vocabulary, biased transcript with it) as JSONL, and the legal basis for using them (TODO(counsel)).
Run: `node scripts/voice/trade-vocab-eval.mjs --calls calls.jsonl --vocab vocab.json --out result.json`, then record the JSON on the staff page.

## Starter content
TODO(owner): the glossary ships empty. Trade terms, brand/model names and pronunciation hints need review by someone who works in the trade.
