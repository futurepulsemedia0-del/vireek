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

## Not implemented
Multi-token executor, token table, idempotency UNIQUE constraint, runtime compensation, kill switch, load tests.
