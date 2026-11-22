# Workflow engine — execution semantics (Phase 1)

Status: compile-time support exists behind `allowParallel`; the runtime (`workflow-graph-executor`) is still single-token.
Nothing in this document is live until the executor supports it. The live `workflow-compiler` function calls `compileIr(raw)` without the option, so these nodes are rejected there.

## Nodes
- `parallel` — edges `b0..bN-1` (2..8 branches). Closed by exactly one `join` (`params.parallel` = the parallel id).
- `join` — `params.mode`: `all` | `any` | `n_of_m` (+`n`) | `timeout` (+`timeout_minutes`, `on_timeout`, `min_success`).
  Arrival through a non-fail edge = branch succeeded; through `fail` = failed. A branch node without a `fail` edge routes it to the join.
- `foreach` — `params.collection_path`, `max_items` (1..200), `concurrency` (1..10), `body` (side node). `item.*` readable only in the body.
- `compensator` (field on an action) — side node that undoes the action if the run later fails.

Side nodes have no edges, are not entries, and are gated by their owner's approval.

## Run state machine
active → waiting_approval | waiting_timer → active; active → compensating → failed | cancelled; active → completed | failed | cancelled. Terminal states absorb nothing.

## Invariants (tested in semantics.test.ts)
I1 a node finishes only after it started, once per scope. I2 a join releases at most once. I3 a terminal run never changes.
I4 compensation runs in reverse completion order, once per step. I5 fan-out starts each item once and never exceeds `concurrency`.

## Safety rules kept
Commitment actions (including inside branches, bodies and as compensators) need a human approval that dominates their owner.
Branches cannot contain approvals, nested parallels, joins or foreach. A join that cancels siblings does not undo commitments that already ran (compile warning).

## Status of the former "Not implemented" list
| Item | Status |
|---|---|
| Kill switch | Existed (`WORKFLOW_PARALLEL_ENABLED`); kept. The two flags below only narrow it. |
| Idempotency constraint | Existed: `compiled_workflow_step_keys` PRIMARY KEY (key). Added: key must start with its own run id (CHECK), token `UNIQUE (run_id, scope_key)`, compensation `UNIQUE (run_id, node_id)`. |
| Token table + multi-token executor | Added behind `WORKFLOW_TOKENS_ENABLED` (default off): `compiled_workflow_tokens`, `_shared/workflow-compiler/tokens.ts`. Branches run concurrently inside a tick on isolated state; leases make a slow tick unable to double-run a node. |
| Runtime compensation state | Added behind `WORKFLOW_DURABLE_COMPENSATION` (default off): run status `compensating`, `compiled_workflow_compensations`, `_shared/workflow-compiler/compensation.ts`. |
| Load tests | Added: `load/workflow/engine-sim.mjs` (engine invariants, executed), `load/k6/workflow-executor.load.js` + `load/workflow/seed.sql` / `verify.sql` (staging, NOT yet run). |

Still out of scope / unverified: nesting, approvals inside branches, cross-run fan-in, token-level pre-emption of an already-running branch, and everything that needs a deployed database (see "Runtime (unverified until deployed)").
Known residual: tokens protect node side effects, not run advancement. If a tick outlives its run lease, two ticks can both release the same join (duplicate audit / advance); `engine-sim.mjs --overlap=1` measures it. Keep the executor tick budget below the run lease.

## Runtime (unverified until deployed)
- Orchestration logic: `_shared/workflow-compiler/orchestrate.ts` (parallel, fan-out, compensation). The executor persists its state in `run.state` under `__par_<node>` / `__fe_<node>` and completed actions under `__done`.
- At-most-once side effects: `compiled_workflow_step_keys` (`cwf_claim_step`), key = `runId:nodeId:purpose:branch:item`.
- Kill switch: `WORKFLOW_PARALLEL_ENABLED=true` (secret). Off = runs reaching these nodes fail safely and compensate; the compiler also rejects such graphs.
- Rollback and constrained edits always create a new draft through the same validator (`workflow-compiler` modes `rollback_of`, `edit_of`, `diff`).
- `compensating`: with `WORKFLOW_DURABLE_COMPENSATION=true` it is a real run status (undo plan persisted, one undo at a time in reverse order, resumable, a crash mid-undo is marked failed and never repeated). With the flag off the legacy in-tick undo (audited as `compensation_done` / `compensation_failed`) is used. A block that started on one engine always finishes on it; turning `WORKFLOW_TOKENS_ENABLED` off mid-block fails that run safely (`tokens_disabled`) and compensates.
- Bug fixed on the way: the executor used `joinConfigFromParams` without importing it, so any parallel block would have thrown at runtime once the kill switch was turned on.

## UI
Outline (keyboard/screen-reader list view), run overlay, version history/diff/rollback/edit, Insights tab, run debugger with redacted replay and a test-mode what-if.
