/*
  # Real AI Insights — richer ai_insights columns

  generate-insights used to be pure if/else template strings — no model
  ever reasoned about the data. This migration adds the columns needed to
  store a genuine LLM-authored insight (via the shared ai-core router)
  while keeping the numbers it reasoned over auditable:

  - `priority` — the AI's own 1 (low) to 5 (urgent) ranking, so the
    dashboard can sort/surface the most important insight first instead
    of just most-recent-first.
  - `recommended_action` — a single concrete next step, separate from
    `description`, so the UI can visually distinguish "what's happening"
    from "what to do about it."
  - `metric_snapshot` — the exact computed numbers (missed-call rate,
    stalled leads, etc.) that were sent to the model for this insight.
    Keeping this means every AI-generated insight stays traceable back to
    real account data instead of being a black box.

  All three are nullable/defaulted so existing rows and existing code
  (which never set them) keep working unchanged.
*/

ALTER TABLE ai_insights
  ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS recommended_action text,
  ADD COLUMN IF NOT EXISTS metric_snapshot jsonb;

CREATE INDEX IF NOT EXISTS idx_ai_insights_priority ON ai_insights(priority DESC);
