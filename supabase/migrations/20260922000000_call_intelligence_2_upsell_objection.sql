/*
  # Call Intelligence 2.0 — Objection & Upsell Detection

  Extends the existing Call Intelligence columns (call_score, lead_score,
  objections_raised, ...) added in 20260917000000_call_intelligence.sql.

  Populated by the same place: _shared/ai-core/callIntelligence.ts, right
  after vapi-webhook's end-of-call-report handler runs analyzeCallIntelligence().

  New columns:
  - upsell_opportunities: specific cross-sell/upsell items the AI detected
    as a good fit from the conversation (e.g. "maintenance plan",
    "duct cleaning") that were NOT offered/booked on this call.
  - objections_resolved: whether the objections in `objections_raised` were
    successfully overcome by the end of the call. NULL when no objections
    were raised (there's nothing to resolve), true/false otherwise.
  - coaching_tip: one short, concrete tactical suggestion for handling the
    next similar call better — distinct from `recommended_follow_up`,
    which is about following up on THIS specific caller.
*/

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS upsell_opportunities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS objections_resolved boolean,
  ADD COLUMN IF NOT EXISTS coaching_tip text;
