-- Time-to-first-token and trace correlation for AI Core usage logs.
-- Additive and nullable: existing writers keep working; old rows stay NULL.
-- Rollback: ALTER TABLE public.ai_usage_logs DROP COLUMN ttft_ms, DROP COLUMN trace_id;  (and drop the index)
ALTER TABLE public.ai_usage_logs ADD COLUMN IF NOT EXISTS ttft_ms integer CHECK (ttft_ms IS NULL OR ttft_ms >= 0);
ALTER TABLE public.ai_usage_logs ADD COLUMN IF NOT EXISTS trace_id text CHECK (trace_id IS NULL OR trace_id ~ '^[0-9a-f]{32}$');
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_trace ON public.ai_usage_logs (trace_id) WHERE trace_id IS NOT NULL;
