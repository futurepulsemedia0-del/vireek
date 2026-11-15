// stryker/compliance.conf.mjs — pilot target 2/3: compliance rules engine (pure, no I/O).
// Modules: rule evaluation / effective-version selection / draft validation, jurisdiction resolution,
// and the FM submission-window rules. Tests: engine.test.ts + fmSubmission.test.ts in the same folder.
// Out of scope: seedRules.ts / fmSeedRules.ts (data), types.ts, load.ts (Supabase I/O).
import { makeConfig } from './base.mjs'

export default makeConfig({
  name: 'compliance',
  mutate: [
    'supabase/functions/_shared/compliance-rules/engine.ts',
    'supabase/functions/_shared/compliance-rules/jurisdiction.ts',
    'supabase/functions/_shared/compliance-rules/fmSubmission.ts',
  ],
})
