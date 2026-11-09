# Agent Action Framework

Flag `agent_action_framework` (OFF by default) AND per-account entitlement (`staff_set_agent_action_entitlement`) must both be on.
While OFF: engine returns `module_disabled`, writes nothing, audits nothing; owner RPCs refuse; nav entry hidden.

## Request pipeline (supabase/functions/_shared/agent-actions/engine.ts)
module on -> idempotency -> kill switch (global/org, fails closed) -> allow-list -> strict schema -> tenant ownership of target
-> read-only preview (diff) -> policy (pause, tool enabled, scopes, injection/taint, caps, time window, autonomy = MIN of tool max,
account policy, agent grant) -> rate limit -> persist (hash-chained audit via DB trigger) -> auto-execute or wait for a human.
Approval re-runs the policy against the stored, hash-verified input (TOCTOU), then executes once (compare-and-set).

## Plug a module in (dispatch / remote resolution / supply)
1. Define tools with `ToolDefinition` (see testFixtures.ts for four worked examples). Rules enforced at registration:
   non-empty `area:verb` scopes, money tools never `auto_notify`, undo needs `undoWindowMs`.
2. `preview()` MUST be read-only. `execute()` MUST pass `ctx.executionKey` to downstream providers as their idempotency key.
   `undo()` MUST be idempotent and self-contained.
3. Add the tools to `registry.default.ts` (`defaultTools`) and the tables they touch to `resourceTables` (table + owner column; unknown kinds are denied).
4. In the agent runtime: wrap every external text with `wrapUntrusted()`, create `assessSource()` entries (pass the production
   `scanPromptInjection` as scanner), and ALWAYS pass them as `sources` to `engine.propose()`. Identity (owner/agent/model/promptVersion) is server-derived.
5. Grant scopes per agent in the UI (Dashboard -> Agent actions -> Controls). No grant = every call blocked.

## Env / ops
`AGENT_ACTIONS_ALLOWED_ORIGINS` (CORS allow-list). No other secrets. Schedule `agent_action_expire_stale()` (e.g. every 10 min) and
`agent_action_prune()` (daily) with service role - NOT scheduled by the migration. A request stuck in `executing` (crash mid-run) is
never auto-retried (to avoid double side effects): inspect the provider by executionKey (= request id) and resolve manually.

## Tests
`npx vitest run supabase/functions/_shared/agent-actions src/lib/agentActions.test.ts` and `npm run test:redteam`.

## REQUIRES COUNSEL
Customer-facing messaging (consent/TCPA-type rules), automated pricing/discounts, and retention periods for audit/preview data.
This framework does not assert regulatory compliance.
