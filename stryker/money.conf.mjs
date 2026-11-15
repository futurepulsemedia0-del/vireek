// stryker/money.conf.mjs — pilot target 1/3: integer-minor-unit money arithmetic.
// Module: rounding modes, decimal parsing, add/subtract/compare, percentage and ratio multiplication,
// allocation, legacy-cents and Stripe-minor conversion. Tests: src/lib/regionConfig/money.test.ts.
// Out of scope: src/lib/regionalPacks/packMoney.ts (dependency; has no dedicated test file yet).
import { makeConfig } from './base.mjs'

export default makeConfig({ name: 'money', mutate: ['src/lib/regionConfig/money.ts'] })
