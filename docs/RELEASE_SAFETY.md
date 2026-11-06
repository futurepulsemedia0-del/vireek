# Release safety runbook

Goal: a bad release must be stoppable in one click and reversible without a deploy. Source of truth: staff console `/staff/release-safety`.

## 1. Kill switches (on-call)
Eight capabilities: `outbound_dialer`, `voice_cloning`, `agent_auto_actions`, `price_auto_apply`, `auto_replies`, `ai_model_prompt_versions`, `marketplace_ingestion`, `sms_campaigns`.
- **Stop** (global or one account): console buttons, or `select staff_set_kill_switch('outbound_dialer', null, true, 'reason');` (as a staff user). One person, instant, audited (`kill_switch_audit`).
- **Resume**: `medium` switches resume alone. `high` / `critical` need a second staff member: *Request resume* then the other person *Approve* in the console.
- Edge functions read `kill_switch_snapshot()` through `_shared/flags/killSwitch.ts` (cache 15 s). Unknown state (database unreachable for more than 10 minutes) **fails closed**: the capability pauses.
- Wiring a capability: `const guard = getKillSwitchGuard(admin); if (await guard.isStopped('<capability>', tenantId)) return …;` Leave stopped work queued (do not mark it failed). See `outbound-dialer` for the pattern.
- **Monthly drill** (calendar reminder + `kill-switch-drill.yml` fails when overdue): stop one test account for each switch, confirm the capability halts within ~15 s, resume, press *Record drill*.

## 2. Feature flags
- Registry: `config/flags.registry.json` (key, kind, owner, created, expires, cleanup). `npm run lint:flags` fails CI on stale, unowned or unregistered flags. Release/experiment flags live at most 180 days.
- Server-side evaluation in edge functions: `createFlagEvaluator` (`_shared/flags/flagEval.ts`, RPC `flag_evaluate`). Failure => **OFF** (the stable path).
- Targeting today: percentage, per-account overrides, **plan** (`targeting = {"plans": ["professional"]}`; an ON override bypasses targeting). Role and region targeting are not implemented (no verified source column yet).
- `risk = high | critical` flags: raising exposure needs a second approver (console section *Request a flag change*). Lowering exposure is always one click. Flag changes are audited in `feature_flag_audit`.

## 3. Staged rollouts (canary)
1. Create a flag (`risk` as appropriate) and register it. ON = new code path, OFF = stable path.
2. In the edge function: `const canary = await flags.isOn('<flag>', tenantId);` run v2 or v1, and report outcomes with `createHealthReporter` (`recordRequest`, and `recordCall(answered)` for call flows) flushing to `release_record_health`.
3. Start: `staff_start_rollout('<flag>', 'edge_function', 'label', '{"minRequests":300}')` (1 %). Stages 1 → 5 → 25 → 50 → 100.
4. `release-guard-tick` (every 5 min via `release-guard.yml`) evaluates the stage: canary vs baseline error rate, p95 latency, call-answer rate. **Rollback is automatic** (flag OFF) after 2 consecutive breaches, or immediately on a confident call-answer drop. Missing data never promotes and never rolls back.
5. Advancing a stage needs a fresh `promote` decision (< 15 min, minimum soak 10 min, enough samples). High-risk flags also need approval.
6. SLO keys (all optional): `minRequests 200, maxErrorRate 0.02, maxErrorDelta 0.01, maxP95Ms, maxP95Ratio 1.5, minAnswerRate 0.9, maxAnswerDrop 0.05, minOffered 30, breachesToRollback 2, minSoakMinutes 10`.
7. Web: Vercel cannot split by account. Use the same flag for UI behaviour, and `vercel rollback` (instant) for the deployment itself.
8. At 100 %: *Mark complete*, then delete the flag, the old path and the registry entry.

## 4. Database safety (expand / contract)
- **Expand** (additive, backward compatible) ships first; **contract** (drop/rename/NOT NULL) ships only after no deployed code uses the old shape, in a later release. Deploy order: migrate → edge functions → web → mobile minimum version.
- `scripts/lint-migrations.mjs` (new migrations only) enforces: a `-- rollback:` note, `CREATE INDEX CONCURRENTLY` alone in its own file for existing tables, no `ADD COLUMN … NOT NULL` without `DEFAULT`, no `SET NOT NULL` or unvalidated `CHECK`/`FOREIGN KEY` (use `NOT VALID` then `VALIDATE`). Opt out only with `-- lint:allow-blocking <reason>` and a reviewer.
- Rehearse on a production-like snapshot: `migration-rehearsal.yml` (needs secret `REHEARSAL_DB_URL`). `migrations.yml` already replays everything on an empty database and runs `supabase test db`.
- Rollback plan: the `-- rollback:` line in each migration; for data changes take a table backup first and state the restore step.

## 5. AI prompt / route versions
- Create a draft (console → *AI prompt and route versions*): prompt = `{"system_suffix": "…"}` (appended to the system prompt), route = `{"route": [{"provider": "gemini", "model": "…"}]}`.
- *Start shadow* (1–25 % of traffic): the candidate runs after the production answer exists; its output is discarded; only success, latency and a similarity score are stored.
- **Promote** only when: ≥ 200 shadow samples, success within 0.5 pt of baseline, p95 ≤ 1.25× baseline, mean similarity ≥ 0.80, eval score ≥ 0.90 (record it with `ai_record_eval` from the eval harness). The server enforces this.
- **Roll back** is instant (previous version, or code defaults). Stopping the `ai_model_prompt_versions` kill switch also returns everything to the code defaults. A failing versioned call falls back to the baseline automatically.
- Callers adopt it with `createVersionedRouter` (`_shared/release/versionedRouting.ts`) in place of `routeChat`. Streaming (`routeChatStream`) is not versioned yet.

## 6. Mobile
- Store staged rollout is a console action (Play Console: staged rollout 1 → 5 → 20 → 50 → 100 %; App Store Connect: phased release). Halt from the console if crash-free users drops.
- In-app: `app_release_policy.rollout_pct` stages only the *soft* "update available" prompt by a stable per-install bucket. A **forced** update (below `min_version`) is never staged. Raising `min_version` needs a second approver (`staff_set_app_release_policy` → approval).
- Friendly prompts and fail-open behaviour live in `UpdateGate`; the policy is cached so a forced update holds offline and an unreachable server never blocks field work.
- OTA: `canApplyOta()` encodes the compatibility rule (a bundle that needs a newer native binary must not be applied). **No OTA plugin is installed in this repo**, so nothing applies bundles yet; adding one must call `canApplyOta` and honour `ota_min_native_version`.

## Secrets / configuration
`SUPABASE_URL`, `RELEASE_GUARD_CRON_SECRET` (must equal the function secret `CRON_SECRET`), optional `REHEARSAL_DB_URL`. Deploy `release-guard-tick` (`verify_jwt = false`, secret required).
