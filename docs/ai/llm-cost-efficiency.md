# LLM cost efficiency

Three cost features, **all default OFF**, one environment variable each:

| Feature | Flag | What it does | Where |
| --- | --- | --- | --- |
| Prompt caching | `AI_PROMPT_CACHE=1` | Anthropic: marks the stable system prefix with `cache_control`. Gemini 2.5 caches prefixes implicitly; only the cached-token count is read. | `ai-core/promptCache.ts`, `providers/anthropic.ts` |
| Response cache | `AI_RESPONSE_CACHE=1` | Identical deterministic request from the same account is served from `ai_response_cache` with no provider call. | `ai-core/responseCache*.ts`, `askVireekAi` |
| Batch mode | `AI_BATCH_MODE=1` | Non-realtime jobs are queued in `ai_batch_jobs` and sent through Anthropic Message Batches by the `ai-batch-runner` cron function. | `ai-core/batch*.ts`, `ai-batch-runner` |

Kill switch: unset the variable. Cached rows and queued jobs are inert when the flag is off.

Cost multipliers are the providers' published structure, **[VERIFY]** against the vendor pricing pages before trusting dollar figures:
cache read 0.1x and write 1.25x (Anthropic), cached input 0.25x (Gemini 2.5), batch 0.5x. Override without a redeploy with `AI_COST_MULTIPLIERS_JSON`.

## Safety rules (each one is tested)

* **Response cache is opt-in per call site**: pass `cache: { ttlSeconds }` **and** `temperature: 0` **and** an `accountId`. Nothing is cached implicitly.
* Cache key = SHA-256 of account, task, final system prompt, messages, max tokens, temperature, JSON mode and the provider/model chain. Any change is a new key. The table is service-role only (RLS on, no policy, privileges revoked), so no tenant can read another's rows.
* Requests that use the AI Security vault (`security`), streaming requests and requests without an account are never cached. Output guardrails run again on every hit.
* Cache and batch failures never fail the call: reads fall through to the provider.
* Batch is restricted to an allow-list of reporting tasks (`BATCH_ELIGIBLE_TASKS`). Live calls, dispatch, emergency and customer-facing tasks are rejected at enqueue.
* Batch jobs are idempotent per `(account_id, idempotency_key)`; completion is exactly-once (status-guarded update before the usage log is written).

## Existing cost tracking (before this change)

* Every `askVireekAi` / `askVireekAiStream` call writes one `ai_usage_logs` row and one `cost_ledger` event (`costTracking.logUsage`); budget caps are enforced in `checkBudget`.
* No provider adapter passed its reported token usage back, so **every cost figure was a `chars / 4` estimate** (which under-counts Persian). Now Gemini, OpenAI-compatible (Groq/Cerebras/OpenRouter) and Anthropic non-streaming calls report real usage; streaming calls are still estimated.
* `logUsage` wrote **two** ledger events per call (different `ref`), double-counting LLM cost in `cost_ledger`. Now one.
* `costTracking.ts` in the uploaded snapshot had an orphaned `cohere`/`openrouter` fragment and no `cohere` price row (does not compile). Fixed.
* New `ai_usage_logs` columns: `cache_read_tokens`, `cache_write_tokens`, `cache_hit`, `batched`, `saved_usd`.

## Call-site inventory

* **Through ai-core** (`askVireekAi`, 58 files, 33 functions/modules). Task chains are in `ai-core/registry.ts`; default chain is Gemini → Groq → Cerebras → Cloudflare → OpenRouter. **Anthropic is in no default chain**, so Anthropic prompt caching and batching only apply where a route override (`AI_ROUTE_OVERRIDES_JSON`) selects it.
* **Direct provider calls outside ai-core** (28 files, frozen by `check:direct-llm`; they bypass budget, cache and cost log): `home-inventory/handler`, `interpreter/{gemini,runtime}`, `knowledge/search`, `property-vision/nameplate-handler`, and the functions `analyze-job-compliance`, `contract-intelligence-extract`, `conversation-intel-analyze`, `diagnosis-copilot`, `expense-receipt-ocr`, `field-estimate`, `generate-mission-brief`, `interpreter`, `kce-extract`, `live-copilot`, `marketing-creative-generate`, `permit-transaction-agent`, `property-vision-analyze`, `remote-resolution`, `supplier-statement-parse`, `takeoff-analyze`, `technician-simulator`, `tribal-knowledge-manual-ingest`, `tribal-knowledge-voice-capture`, `verify-job-evidence`, `visual-estimate`, `voice-log-extract`. Moving these behind ai-core is the largest remaining cost-visibility gap.

## Measured on fixtures (not production)

`npm run llm-cost:bench` (prefix sizes are measured from `ai-core/index.ts`; everything else is a labelled assumption in `scripts/llm-cost/fixtures.json`):

| Scenario | Before | After | Saved |
| --- | --- | --- | --- |
| Prompt cache, chat with static brief (2,451-token prefix, 2,000 calls) | $18.4860 | $5.2591 | 71.55% |
| Prompt cache, `call_intelligence` as built today (832-token prefix) | $24.4920 | $24.4920 | 0% (below the 1,024-token minimum, marker correctly not sent) |
| Response cache, bank re-categorisation (35% assumed duplicates) | $2.9600 | $1.9580 | 33.85% |
| Batch, weekly executive commentary (500 jobs) | $10.2000 | $5.1000 | 50% |

Reading this honestly: with today's prompt layout the stable prefix (identity + task rules) is at most ~906 tokens, **below Anthropic's cacheable minimum**, so prompt caching helps only when a large stable block (the static knowledge brief) is part of the prefix. Replace the fixture assumptions with real numbers from `ai_usage_logs` before forecasting savings.

## Operating it

1. Apply `20290306000000_llm_cost_efficiency.sql`.
2. Deploy `ai-batch-runner` (`--no-verify-jwt`; fail-closed `CRON_SECRET`) and schedule it every ~10 minutes. Schedule `select public.ai_response_cache_sweep()` daily.
3. Turn flags on one at a time in staging; watch `cache_hit`, `saved_usd`, `batched` on `ai_usage_logs`.

Dashboard: `ai_usage_logs.saved_usd` is the list-price cost avoided per row (for a cache hit, the full call cost). No UI page was changed; the new columns are additive and the existing account-scoped SELECT policy covers them.

## Not done / next

* No existing call site opts into the response cache or batch yet. `ai-assistant-query` (`intent_classify`) is the natural first response-cache candidate but needs `accountId` plumbed in and `temperature: 0`; batch candidates need a result consumer because answers arrive up to 24 h later.
* Streaming calls are still estimated; static-brief prefix extension in `buildSystemPrompt` is not implemented.
