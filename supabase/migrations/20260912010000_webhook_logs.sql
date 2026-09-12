/*
  # Webhook Logs (incoming from Vapi + outgoing to customer integrations)

  ## چرا این migration لازم است
  دو مسیر webhook توی پروژه هست که هیچ‌کدوم لاگ قابل‌مشاهده توی داشبورد
  Vireek ندارن:

  1. **Incoming (Vapi -> ما):** `supabase/functions/vapi-webhook/index.ts`
     فقط با `console.log`/`console.error` لاگ می‌کنه — فقط توی پنل خود
     Supabase قابل دیدنه، نه توی داشبورد مشتری.

  2. **Outgoing (ما -> URL مشتری):** صفحه‌ی `/dashboard/integrations`
     از قبل UI برای ذخیره‌ی یک webhook URL داره ("We'll POST event data —
     new calls, leads, jobs — to this URL") ولی هیچ کدی توی پروژه واقعاً
     چیزی به اون URL ارسال نمی‌کرد. این migration هم جدول لاگ رو می‌سازه
     و هم dispatch واقعی رو (با همون الگوی pg_net که برای push notification
     در 20260912000000_push_notifications.sql استفاده شده) فعال می‌کنه.

  ## جدول جدید: webhook_logs
  - `id` (uuid, PK)
  - `user_id` (uuid, nullable — برای رویدادهای incoming که هنوز tenant
    شناسایی نشده، مثل payload بدشکل یا auth ناموفق، می‌تونه null باشه)
  - `direction` ('incoming' | 'outgoing')
  - `event_type` (text — مثلاً 'lead.created', 'webhook_received', 'unauthorized_request')
  - `status` ('success' | 'error')
  - `status_code` (int, nullable — کد HTTP برگشتی، فقط برای outgoing معنی داره)
  - `target_url` (text, nullable — فقط برای outgoing، URL مشتری)
  - `error_message` (text, nullable)
  - `request_id` (text, nullable)
  - `created_at` (timestamptz, default now)

  ## RLS
  فقط صاحب اکانت (`get_account_owner_id()`) می‌تونه لاگ‌های خودش رو ببینه.
  هیچ INSERT policy ای برای کاربر عادی تعریف نشده — فقط service role
  (که Edge Functionها باهاش کار می‌کنن) می‌تونه insert کنه، پس کاربر
  نمی‌تونه لاگ جعلی بسازه.

  ⚠️ نکته: ردیف‌هایی که user_id=null دارن (auth ناموفق/payload بدشکل قبل
  از شناسایی tenant) با RLS فعلی توسط هیچ کاربری قابل دیدن نیستن — این
  عمدیه (این رویدادها امنیتی هستن، نه مخصوص یک مشتری خاص) و فقط توی لاگ
  خود Supabase Functions قابل بررسی می‌مونن.

  ## Dispatch خروجی (outgoing)
  سه trigger روی INSERT جداول `calls`، `leads`، `jobs` که هرکدوم Edge
  Function جدید `dispatch-webhook` رو (از طریق pg_net، دقیقاً مثل الگوی
  push notification) صدا می‌زنن. اون Edge Function خودش integrations
  مربوط به همون user_id رو چک می‌کنه، اگه webhook فعال با URL تنظیم‌شده
  داشت، POST واقعی رو می‌فرسته و نتیجه رو (موفق/ناموفق + status code) توی
  همین جدول لاگ می‌کنه.

  از همون تنظیمات موجود استفاده می‌شه (چیز جدیدی لازم نیست ست کنی اگه
  قبلاً push notification رو راه‌انداختی):
    app.settings.edge_function_base_url
    app.settings.push_dispatch_secret

  اگه این‌ها ست نشده باشن، trigger ها بی‌صدا no-op می‌کنن (دقیقاً مثل
  dispatch_push_notification موجود).

  بعد از این migration باید Edge Function جدید رو دیپلوی کنی:
    supabase functions deploy dispatch-webhook --no-verify-jwt
*/

-- =============================================================
-- WEBHOOK_LOGS TABLE
-- =============================================================

CREATE TABLE IF NOT EXISTS webhook_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  direction text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  event_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'error')),
  status_code integer,
  target_url text,
  error_message text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_user_created
  ON webhook_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_direction
  ON webhook_logs(direction);

ALTER TABLE webhook_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_webhook_logs" ON webhook_logs;
CREATE POLICY "select_own_webhook_logs"
ON webhook_logs FOR SELECT
TO authenticated
USING (user_id = public.get_account_owner_id());

-- No INSERT/UPDATE/DELETE policy for `authenticated` on purpose — only the
-- service role (used by Edge Functions) writes to this table.

-- =============================================================
-- OUTGOING DISPATCH: calls / leads / jobs INSERT -> dispatch-webhook
-- =============================================================

CREATE OR REPLACE FUNCTION public.dispatch_customer_webhook()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_url text;
  v_secret text;
  v_event_type text;
BEGIN
  v_base_url := current_setting('app.settings.edge_function_base_url', true);
  v_secret := current_setting('app.settings.push_dispatch_secret', true);

  IF v_base_url IS NULL OR v_base_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN NEW;
  END IF;

  v_event_type := TG_ARGV[0];

  PERFORM net.http_post(
    url := v_base_url || '/dispatch-webhook',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-dispatch-secret', v_secret
    ),
    body := jsonb_build_object(
      'user_id', NEW.user_id,
      'event_type', v_event_type,
      'record', to_jsonb(NEW)
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_webhook_new_call ON calls;
CREATE TRIGGER trigger_webhook_new_call
  AFTER INSERT ON calls
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_customer_webhook('call.created');

DROP TRIGGER IF EXISTS trigger_webhook_new_lead ON leads;
CREATE TRIGGER trigger_webhook_new_lead
  AFTER INSERT ON leads
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_customer_webhook('lead.created');

DROP TRIGGER IF EXISTS trigger_webhook_new_job ON jobs;
CREATE TRIGGER trigger_webhook_new_job
  AFTER INSERT ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.dispatch_customer_webhook('job.created');
