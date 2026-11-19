# Runbook — model-provider change management

Single source of truth: `supabase/functions/_shared/ai-models.ts` (`MODELS` + `MODEL_REGISTRY`).
Every model id, with provider, purpose, pinning, owner and status, lives there. Edge code reads it via `MODELS.*` / `resolveModel()`.
CI gate: `npm run check:models` fails on any model-like string literal (code or workflow `*_MODEL:` value) that is not registered.
Unit tests: `npm run test:scripts:models` (gate) and `npx vitest run supabase/functions/_shared/ai-models.test.ts` (registry).

## 0. Inventory — where a model id can still appear
- Code defaults: only `ai-models.ts`. Everything else references `MODELS.*`.
- Runtime overrides (win over the code default, **no deploy needed**): Supabase secrets `GEMINI_MODEL`, `TAKEOFF_GEMINI_MODEL`, `PROPERTY_VISION_MODEL`, `NAMEPLATE_MODEL`, `HOME_INVENTORY_MODEL`, `GEMINI_IMAGE_MODEL`, `GROQ_MODEL`, `CEREBRAS_MODEL`, `CLOUDFLARE_MODEL`, `OPENROUTER_MODEL`, `ANTHROPIC_MODEL`, `COHERE_MODEL`, `COHERE_EMBED_MODEL`, `TTS_MODEL`, `OVB_CALLER_MODEL`, plus route overrides `AI_ROUTE_OVERRIDES_JSON` (kill switch: `AI_ROUTE_OVERRIDES_DISABLED=1`) and price overrides `AI_PRICE_OVERRIDES_JSON`.
  Always list the live values first: `supabase secrets list --project-ref <ref>` (names only).
- Plain-Node / CI places that cannot import the TS registry (literals are allowed **only if registered**; update them by hand): `scripts/eval-voice-log.mjs`, `scripts/knowledge-build.mjs`, `scripts/ingest-brand-knowledge.mjs`, `.github/workflows/knowledge-embed.yml`. Find all of them with `grep -rn "<model-id>" scripts .github supabase src`.
- Registry fields: `pinning` = `snapshot` (immutable id) / `alias` (provider can move it silently) / `router` (provider picks per request, e.g. `openrouter/auto`, cannot be eval-pinned). `pinnedVersion` is `null` while only an alias is known — **[VERIFY]** the provider's snapshot id before claiming a pin. `owner` currently holds CODEOWNERS placeholders (`@OWNER_*`); replace them together with `.github/CODEOWNERS`.

## 1. Deprecation handling (provider announces end of life)
1. Open a PR editing the entry in `MODEL_REGISTRY`: `status: "deprecated"`, `sunsetDate: "YYYY-MM-DD"` (from the provider's notice), `replacedBy: <registered id>`. The registry test enforces that a deprecated/retired entry has a registered `replacedBy` and a sunset date. `resolveModel()` then logs `{"event":"ai_model_registry","reason":"deprecated_model"}` once per instance (`retired_model` at error level).
2. Check overrides: any Supabase secret from §0 that pins the deprecated id keeps it alive past the code change — update or remove it deliberately.
3. Run the full switch procedure (§2–§3) for the replacement **before** the sunset date. Target at least one nightly `AI Regression` cycle of margin.
4. After the switch has run clean in production, set `status: "retired"`. Delete the entry only after the sunset date has passed and no secret, route override, workflow or script references it (`grep` + `npm run check:models`).

## 2. Mandatory eval gate before switching (never skip, including "minor" version bumps)
The harness: workflow `.github/workflows/ai-regression.yml` → edge function `ai-eval-run` → `runEvalCase` → `askVireekAi` (full ai-core chain) → rows in `ai_eval_results` (`provider`, `model`, `passed`, `hallucination_detected`, `latency_ms`, `cost_usd`).
1. **Register the candidate** in `MODELS` + `MODEL_REGISTRY` (status `active`, owner, purpose, pinning). If it is priced, add its key to `PRICE_TABLE` in `ai-core/costTracking.ts` (`[MODELS.X]: {...}`) or set `AI_PRICE_OVERRIDES_JSON`; otherwise cost is reported with the provider default.
2. **Point a non-production project at it**: `supabase secrets set GEMINI_MODEL=<candidate-id> --project-ref <staging-ref>` (or the matching provider variable / `AI_ROUTE_OVERRIDES_JSON` for one task). Deploy the registry change to that project.
3. **Run the suites** for every task that uses the model: GitHub → Actions → *AI Regression* → *Run workflow* → `suiteId` (repeat per suite). The workflow's `SUPABASE_URL` / `AI_REGRESSION_TEST_USER_JWT` secrets must point at the project from step 2. Note: the voice suite job (`run-voice-eval-suite`) only runs on the nightly schedule, not on manual dispatch.
4. **Prove the candidate was really exercised** (ai-core falls back to the next provider on failure, which would silently test the wrong model):
   ```sql
   select provider, model, count(*) cases,
          count(*) filter (where passed) passed,
          count(*) filter (where hallucination_detected) hallucinations,
          round(avg(latency_ms)) avg_ms, round(sum(cost_usd)::numeric, 4) cost_usd
   from ai_eval_results where run_id = '<run id from the workflow log>'
   group by 1, 2;
   ```
   Every case must show the candidate id. Any other `model` value → the run does **not** count.
5. **Pass criteria**: workflow green (all cases pass, 0 hallucinations — this is what the workflow enforces), and the same query for the last green run on the current model shows no material regression in pass count, latency or cost. Paste both run ids into the PR.
6. **Embedding models** additionally: stored vectors are 1024-dim (`site_assistant_knowledge.embedding`, `COHERE_EMBED_MODEL`). A different embedding model, even with the same dimension, lives in a different vector space: re-embed the whole index (`.github/workflows/knowledge-embed.yml`) and never mix models in one index. Run retrieval checks before and after.
7. **Router / alias entries** (`openrouter/auto`, aliases without a snapshot) cannot be pinned: treat any green run as a point-in-time result and keep the nightly run as the drift detector.

## 3. Switch
1. In `ai-models.ts` change the value in `MODELS` (or, for one provider/task only, the relevant secret/route override). Keep the old entry in `MODEL_REGISTRY` as `active`/`deprecated` until rollback is no longer needed.
2. PR must contain: registry diff, eval run ids (§2.5), `npm run check:models` and `npm run test:scripts:models` green, and the owner's approval.
3. Deploy every function that imports `_shared/ai-models.ts` (all AI edge functions + `_shared/ai-core`) — `supabase functions deploy` for the changed set. A `_shared` change is not live until each function is redeployed.
4. Watch the first hours: `ai-regression` nightly, cost/latency dashboards, and edge logs for `"event":"ai_model_registry"` warnings.

## 4. Rollback (fastest first)
1. **Secret override — no deploy**: `supabase secrets set GEMINI_MODEL=<previous-id> --project-ref <prod-ref>` (overrides win over the code default). For a route override: `AI_ROUTE_OVERRIDES_DISABLED=1`. The previous id must still be registered (it is, by §3.1).
2. **Code rollback**: revert the registry PR and redeploy the functions from §3.3.
3. If an unreviewed override is the problem, `AI_MODEL_REGISTRY_STRICT=1` makes `resolveModel()` ignore any override that is not in the registry and use the code default (it still logs the ignored value).
4. Re-run *AI Regression* on the rolled-back configuration and confirm with the §2.4 query; record the incident in the PR/issue.
5. Embedding rollback = re-embed with the previous model; vectors are not interchangeable.

## 5. Adding a brand-new model or provider
Add `MODELS.<KEY>` + one `MODEL_REGISTRY` entry (the gate and `ai-models.test.ts` fail if either is missing/duplicated), then follow §2–§3. A deliberate non-model string that looks like one may carry the comment `model-registry-ignore` on the same line.

## 6. Limits of the gate
It detects whole string literals and `*_MODEL:` workflow values. It cannot see ids assembled at runtime (`"gpt-" + n`) or stored in the database/secrets, which is why §0 lists the secrets and the SQL check in §2.4 exists.
