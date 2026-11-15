// stryker/scoring.conf.mjs — pilot target 3/3: Business Fragility Score engine (pure, deterministic).
// Module: riskOf ramp, bandOf thresholds, deriveInputs, scoreFragility (weights + coverage renormalisation).
// Tests: src/lib/fragilityScore.test.ts.
import { makeConfig } from './base.mjs'

export default makeConfig({ name: 'scoring', mutate: ['src/lib/fragilityScore.ts'] })
