# Experiment standards

How Vireek plans, runs and decides experiments, and which code enforces each rule. The statistics live in `src/lib/stats/experimentStandards.ts`; the shared primitives it builds on are in `src/lib/stats/inference.ts`.

## What already existed, and what this adds

| Need | Before | Now |
|---|---|---|
| Sample size | `requiredPerArm` in `growthExperiments.ts` and `opsExperiments.ts` (fixed 80% power, assumes a 50/50 split) | `sampleSize()`: binary or mean metrics, any power, any split, one- or two-sided, relative or absolute effect, run length in whole weeks. `minimumDetectableEffect()` answers the reverse question. Matches the growth calculator at its settings (tested). |
| Sample ratio mismatch | `srmCheck` (two arms) | `srmCheckArms()` for any number of arms and uneven planned splits. Agrees with `srmCheck` for two arms (tested). |
| Early looks | Growth: minimum runtime. Ops: a continuous approximation (`z / sqrt(information)`) | `DecisionRule`: **fixed horizon** or **group sequential** with Lan-DeMets alpha spending (O'Brien-Fleming or Pocock). Boundaries are computed by numerical integration for the looks actually taken. |
| Guardrails | One guardrail per experiment | `evaluateGuardrail()` / `rollupGuardrails()`: any number, non-inferiority against a stated tolerance. |
| Pre-registration | None | `PreRegistration` type, `validatePreRegistration()`, and the template below. |

The existing analysis code (`analyzeExperiment`, `analyzeGrowthExperiment`) is **not rewired** yet. New experiments should declare their plan with the functions above; migrating the old analysers to them is a separate, optional change.

## The rules

1. **Register before you start.** The plan is frozen with a timestamp earlier than the start. A plan registered after the start does not count as pre-registered (`registered_after_start`).
2. **One primary metric.** Everything else is secondary and exploratory. A secondary metric never rescues a failed primary.
3. **Size it first.** The declared sample must cover what `sampleSizeForRule` computes for the declared baseline, effect, alpha, power, split and rule. Smaller declarations are rejected (`underpowered_plan`).
4. **Run whole weeks.** At least 7 days; a multiple of 7 avoids a skewed weekday mix.
5. **Check the split first.** Run `srmCheckArms` on **assigned** units, not on units with an outcome. A mismatch (p < 0.001) means the result cannot be trusted until the cause is found. Fewer than 5 expected units per arm gives `insufficient_data`, not a pass.
6. **Declare the decision rule.**
   - *Fixed horizon:* no verdict of any kind before the planned sample is reached, even if the data look decisive. At the horizon, `|z|` is compared with the plain critical value.
   - *Group sequential:* stop early for efficacy only when `|z|` crosses the spending-function boundary for the looks taken so far. O'Brien-Fleming spends very little alpha early (strong evidence needed to stop early, small sample penalty). Pocock spends evenly (easier early stops, larger sample penalty). Planned looks are a plan, not a constraint: pass the looks that actually happened and the boundaries adapt while keeping the total type-I error at alpha.
   - *Futility* is advice only (conditional power below a threshold, from 50% information). It never ends an experiment by itself.
7. **Guardrails are mandatory.** At least one, with a tolerance in the metric's own units. See below.
8. **Decide the actions in advance** for a win, no effect and a loss.

## Sample size

```ts
import { sampleSize, sampleSizeForRule, minimumDetectableEffect } from '@/lib/stats/experimentStandards';

sampleSize({ kind: 'binary', baselineRate: 0.2, mde: 0.05, unitsPerDay: 100 });
// { ok: true, control: 1091, treatment: 1091, total: 2182, days: 28, absoluteMde: 0.05 }

sampleSizeForRule(input, { kind: 'group_sequential', alpha: 0.05, spending: 'pocock', plannedLooks: [0.5, 1] });
// inflated so power at the planned effect is still met
```

`mde` is the smallest effect worth acting on, not the effect you hope for. Failures return `{ ok: false, error }` with a specific code instead of throwing. A baseline close to 1 is sized in the opposite direction, as the ops calculator does.

## Guardrails

A guardrail protects something the experiment must not damage (cancellations, completion rate, response time).

- **breached:** the worsening is, with 95% one-sided confidence, larger than the tolerance.
- **ok:** the worsening is shown to be within the tolerance.
- **watch:** neither is established yet.
- **unknown:** fewer than 30 units in a group, or invalid input.

The roll-up treats any breach as `stop_and_investigate`. Guardrails are deliberately **not** corrected for multiple comparisons: missing real harm costs more than investigating a false alarm. The roll-up reports `falseBreachProbability` (about 14% with three guardrails and no real harm) so reviewers know to look before reacting. `detectableHarm()` shows how large a worsening the current sample could actually catch; if that is much bigger than the tolerance, the guardrail is not protecting anything yet.

## Pre-registration template

Copy this into the experiment's ticket or record **before** the first user is assigned. Each field maps to a `PreRegistration` property, and `validatePreRegistration()` checks it.

```
Experiment key:
Owner:                       (accountable person)
Registered at (ISO):         Planned start (ISO):

Hypothesis:                  If we ___ for ___, then ___ will change by ___, because ___.
Intervention:                What exactly the treatment group gets.
Eligible population:         Who can enter.
Unit of randomization:       visitor | account | user | job | technician
Treatment share (%):
Exclusions:                  or "none"

Primary metric:              name, exact definition, kind (binary | mean), baseline, sd (if mean)
Smallest effect worth detecting:   value, absolute or relative
Alpha:      Power:
Planned units:               control ___, treatment ___   (from sampleSizeForRule)
Max duration (days):         (whole weeks)

Decision rule:               fixed horizon | group sequential (spending function, planned looks, optional futility threshold)
SRM check:                   declared yes; threshold (default 0.001); failure invalidates the result
Guardrails:                  name, harmful direction, tolerance (units of the metric)
Secondary metrics:           exploratory only

Analysis plan:               test used, analysed population (all assigned vs exposed), missing data, no outcome-based exclusions
If it wins:                  action
If no effect:                action
If it loses:                 action
```

Freezing: store the filled template as written and do not edit it after the start. A change after the start is a new, separately dated amendment with its reason.

## Limits and open points

- `PreRegistration` is validated in code but **not stored** in the database yet. Persisting and locking it (with an audit trail) would need a migration and an owner decision on where it lives.
- The sequential boundaries assume two-sided tests on an approximately normal z-statistic, the same assumption as the existing analysers. Tiny or very sparse samples need the existing minimum-count rules (`MIN_CELL_N`, `MIN_BINARY_EVENTS`) first.
- Sequential inflation factors are computed by the code for the declared looks; this page deliberately quotes no fixed factors.
- Interference between units (for example, technicians sharing customers) is not handled by any of these functions; choose the unit of randomisation to avoid it.

## References

Pocock (1977) and O'Brien and Fleming (1979) for the two boundary families; Lan and DeMets (1983) for alpha spending. [VERIFY] exact citations before quoting them externally.

## Tests

`src/lib/stats/experimentStandards.test.ts` (Vitest, run with `npm run test`). Covers the numerical primitives against reference values, sample-size agreement with the existing calculator, SRM agreement with `srmCheck`, total type-I error equal to alpha for planned and irregular looks, power preservation, every decision-rule branch, all guardrail states and roll-up order, and each pre-registration error.
