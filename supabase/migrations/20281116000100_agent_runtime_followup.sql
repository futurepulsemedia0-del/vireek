/*
  # Agent runtime — follow-up agent wiring (additive)

  1. outbound_sms / outbound_calls.run_key  — کلید idempotency گام (قبل از ارسال ثبت می‌شود تا
     کراش بین «ارسال» و «ثبت لاگ» قابل تشخیص باشد).
     UNIQUE(user_id, run_key) غیرجزئی است (NULLهای قدیمی با هم تداخل ندارند) تا
     PostgREST upsert(onConflict) کار کند.
  2. agent_runtime_flags — فعال‌سازی per-tenant و per-agent. پیش‌فرض: غیرفعال (رفتار فعلی).
     فقط service_role می‌نویسد؛ مالک می‌خواند.

  ## فعال‌سازی برای یک tenant (SQL Editor):
    INSERT INTO agent_runtime_flags (user_id, agent_source, enabled)
    VALUES ('<tenant-uuid>', 'followup-agent-dispatcher', true)
    ON CONFLICT (user_id, agent_source) DO UPDATE SET enabled = true, updated_at = now();
  ## خاموش کردن فوری: enabled=false، یا secret محیطی AGENT_RUNTIME_DISABLED=1 (کل سیستم).

  ## Rollback:
    ALTER TABLE outbound_sms DROP COLUMN IF EXISTS run_key;
    ALTER TABLE outbound_calls DROP COLUMN IF EXISTS run_key;
    DROP TABLE IF EXISTS agent_runtime_flags;
*/

ALTER TABLE public.outbound_sms ADD COLUMN IF NOT EXISTS run_key text;
ALTER TABLE public.outbound_calls ADD COLUMN IF NOT EXISTS run_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_sms_run_key ON public.outbound_sms (user_id, run_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_calls_run_key ON public.outbound_calls (user_id, run_key);

CREATE TABLE IF NOT EXISTS public.agent_runtime_flags (
  user_id uuid NOT NULL,
  agent_source text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_source)
);

ALTER TABLE public.agent_runtime_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_agent_runtime_flags" ON public.agent_runtime_flags;
CREATE POLICY "select_own_agent_runtime_flags" ON public.agent_runtime_flags FOR SELECT TO authenticated
  USING (user_id = public.get_account_owner_id());
-- بدون policy نوشتن: فقط service_role (rollout توسط ما، نه توسط کاربر)
