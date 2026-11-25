# Causal Dispatch Network — statistical model

Advisory only. Nothing here assigns, ranks, pays, disciplines or excludes anyone. All code is pure TypeScript in
`src/lib/causal/*`; I/O stays in `src/lib/causalDispatchApi.ts`. Nothing changes when the exploration flag is off.

## Data and estimand
Row *i*: indifference set `S_i` (k_i ≥ 2), logged probabilities `p_ij`, chosen `A_i`, job type `τ_i`, outcome `Y_i`
(ftf, callback14, callback30, duration residual; immature ⇒ excluded).
Estimand for technician *t*, type *τ*:  θ_tτ = E[ Y(t) − mean_{j∈S} Y(j) | t∈S, τ ].
It is **relative to the peers t was interchangeable with**, not an absolute skill score.

## Estimators (`estimators.ts`)
With `p̃ = max(p, pClip)` (default pClip = 0.01, configurable):
- IPW  ψ_ij = 1{A=j} Y / p̃
- AIPW ψ_ij = m̂_ij + 1{A=j}(Y − m̂_ij)/p̃   (doubly robust)
- φ_ij = ψ_ij − mean_l ψ_il ;  θ̂_tτ = mean φ over rows with t∈S, τ.
m̂: global → job-type → technician → technician×job-type means with pseudo-count 5, **cross-fitted** (5 folds by cluster hash).
Reported per cell: n in sets, n chosen, Kish effective sample size `(Σw)²/Σw²`, clipped share.

## Uncertainty
- Cluster-robust (CR1) SE of the mean of φ, clusters = chosen-technician × week (`attachClusters`). Thin-cell variance is
  blended toward the median per-decision variance (weight 2).
- Optional seeded percentile cluster bootstrap (`bootstrapB > 0`).

## Shrinkage (`shrinkCells`)
θ̂_tj ~ N(θ_tj, s²); θ_tj = a_t + b_j + c_tj, a~N(0,σa²), b~N(0,σb²), c~N(0,σc²); **μ fixed at 0** (peer-relative effects
average to exactly 0 within each set; estimating μ with inverse-variance weights injected a measured +0.013 bias).
Variance components by method of moments (fixed point, 6 iterations) using design-based variances ū/n. Posterior:
`B = v0/(v0+s²)`, `θ̃ = Bθ̂ + (1−B)(a_t+b_j)`, `Var = B s²`, then **SE × 1.25** (`POSTERIOR_SE_INFLATION`, calibrated on
simulation only; plug-in EB undercovers). A cell with no usable SE collapses to its prior.

## Reporting rule (`evidence.ts`)
A cell is *reportable* (may be shown as above/below peers) only if **all** hold: n ≥ 30; effective n ≥ 20; shrunk 95%
interval excludes 0; unshrunk 95% interval excludes 0 in the same direction; BH q ≤ 0.10 across cells.
Grade A additionally needs n ≥ 60, ESS ≥ 40, half-width ≤ 15 pp (30 min) and q ≤ 0.05. Everything else is grade C /
"inconclusive". UI wording: "above/below peers", never best/worst.

## Off-policy evaluation (`ope.ts`)
SNIPS and doubly robust value of a candidate policy (`topRankedPolicy`, `weightChangePolicy(ratios from
suggestWeightChanges)`, or any function) over randomizable decisions, plus paired DR uplift vs the logged policy with
cluster SE. **Refuses** (no number) when: < 50 rows; ESS < 30 or < 5% of rows; one row > 20% of weight; > 10% of matched
rows clipped; or no overlap. Scope: decisions with ≥ 2 near-equal technicians only.

## Power (`power.ts`)
`MDE = (z_{1−α/2}+z_{power}) √( DEFF·f(1−f)(1−1/k̄) / (e·cellShare·W) )`, `e = jobs/wk × qualifyingShare × q / T`.
Verdicts: go ≤ 26 weeks to a 10-point MDE, marginal ≤ 52, else "Not enough volume to learn this — leave it off".
Thresholds need human sign-off. Feasibility input is an upper bound.

## Cross-tenant pooling (`pooling.ts`, migration `20290312000000`)
Pooled: per job type, between-technician variance τ² and baseline rate. Never technician ids/PII. Gate: existing
`cross_tenant_flows` flow `causal_cohorts` via `xtl_contributors()` — **unmapped (fail-closed) until counsel maps it**.
Minimums (sign-off required): ≥ 5 tenants, ≥ 30 rows & ≥ 3 technicians per tenant, ≥ 300 pooled rows, counts floored to 10,
equal tenant weights, label allow-list. Pooled τ² only floors σc² for job types with < 10 local cells; shadow only.

## Known limitations
Peer-relative and set-dependent; selection from gate fallbacks/reassignments (W1) not analyzed; shrunk intervals are
approximate; all calibration is from synthetic worlds.
