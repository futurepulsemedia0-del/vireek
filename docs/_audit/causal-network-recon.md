# Causal Dispatch Network — Phase 0 recon (read-only, static)

Reference: the uploaded `vireek-main__8_.zip` (declared the source of truth by the owner). Nothing below was executed
against a database; claims are from reading the files. No `node_modules`, so project `tsc`/`eslint`/`vitest` could not run.

## What exists
| Piece | File | What it computes |
|---|---|---|
| Indifference set | `_shared/dispatch/indifferenceSet.ts` | Eligible technicians within `delta` score points of the top; capped size; feasibility RPC counts sets by size (`score_only_upper_bound`: ignores hard exclusions). |
| Seeded draw | `_shared/dispatch/exploration.ts` | `u_enroll = hash(seed:enroll)`; enrolled iff `u < q`; pick `members[floor(u2·k)]`, `u2 = hash(seed:pick)`; seed = `accountId:jobId`. |
| Logged propensity | same | non-top member `q/k`; top `1 − q + q/k`; every exclusion path logs `propensity = 1`, arm `exploit`, with a `reason`. |
| Guardrail | `explorationPolicy.ts` | Compares mature FTF of `explored` vs `not_enrolled` rows (Wald); auto-disables on a drop beyond tolerance. |
| Estimator (old) | `src/lib/causalDispatch.ts` | Leave-one-out DR cell effects vs set mean; SE = sample SD of per-row scores (no clustering); two-level shrinkage to 0; grade from raw SE + n. |
| Factor provenance | same | `β̂ = Σ x_i(Y_i−Ȳ)/p_i / Σ d_i`, sandwich-style SE. Algebra checked: unbiased slope of Y on factor points inside a set. |
| UI | `CausalDispatchCard.tsx` | Showed any cell with grade ≠ C sorted by `|est|`, i.e. B-grade cells whose interval could include zero. |

## Verified by reading
1. **Propensity correctness.** `q/k` and `1−q+q/k` sum to 1 and equal the true selection probability given the set.
   `gate_fallback` rows are logged with propensity 1 + reason `gate_fallback`; `parseSet` rejects any reason outside
   `{explored, not_enrolled}`, so they are excluded. OK.
2. **Seeded determinism.** hash → [0,1) is exact (2^53 denominator); same inputs ⇒ same draw. Draw depends on the
   *order* of `members`, which is score-then-id sorted ⇒ stable. OK.
3. **Maturity.** FTF/callback use `observe()`: not completed or younger than the window ⇒ `null` (never a success). OK.
   Cancelled/never-completed jobs drop out (post-treatment selection if technicians affect completion).
4. **Set composition.** Old estimator contrasts inside each row's own set with that row's logged `p`, so it conditions on
   the set at decision time. The estimand is peer-relative and therefore depends on who the technician was grouped with.

## Bugs / weaknesses found
- **B1 (blocking, verified on a minimal repro + by reading):** `rulesAssign.ts` calls the imported `attemptOrder(...)`
  and, in the same loop block, declares `const attemptOrder = ...`. TS2448 + runtime
  `ReferenceError: Cannot access 'attemptOrder' before initialization` for every job when rules are enabled — flag on
  or off. Also `plan`/`attempts`/`rz` are computed and never used: near-tie randomization is disconnected (looks like a
  merge of two features). Fix: rename the local to `tryOrder`.
- **W1** Post-randomization exclusions: `gate_fallback` and "job reassigned by a dispatcher" rows are dropped. If the
  gate/dispatcher intervenes more for some technicians or harder jobs, the analyzed sample is a selected subset
  (the logged `p` is no longer the probability of "assigned AND retained"). Mitigation shipped: log `drawn_id` on
  `gate_fallback` rows so an intent-to-treat analysis becomes possible. Not yet analyzed.
- **W2** Old SE ignores dependence (same technician-week) and uses leave-one-out m̂ rather than cross-fitting. Replaced.
- **W3** Old grade used raw SE and `n`, not the interval shown; cells whose interval contained zero could be listed.
- **W4** No propensity clipping, no effective sample size; `1/p` can reach `k/q` (e.g. 80 at q=2.5%, k=2); heavy tails.
- **W5** API reads the newest 3000 decisions only (silent truncation) and requires `set_size >= 2`.
- **W6** `technician_id` is `ON DELETE SET NULL` ⇒ rows of removed technicians vanish from analysis (survivorship).
- **W7** Budget/exposure caps depend on earlier coin flips. Valid conditional on history (propensity logged *given* the
  state), but rows are not independent draws from one fixed design.
- **W8** Guardrail "explore" arm includes the 1/k chance the draw equals the top pick, diluting the contrast.
- **W9** Feasibility RPC is an *upper bound* (no hard exclusions). The new power panel says so.

## Not read / not verified
Edge function `dispatch-auto-assign/index.ts` body, `ftf_predictions` semantics, real tenant data, any live schema.
