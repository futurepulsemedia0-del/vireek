/*
  # Vapi webhook: tenant mapping + call tracking columns

  ## چرا این migration لازم است
  برای اینکه `supabase/functions/vapi-webhook/index.ts` بتواند تشخیص بدهد
  یک تماس ورودی از Vapi متعلق به کدام business (کدام profiles.id) است،
  به یک راه قابل اعتماد برای map کردن Vapi assistant/phone number به
  business_profile نیاز است. این mapping در schema فعلی به هیچ شکلی وجود
  نداشت (`profiles.external_id` فقط برای Airtable/Zapier است و ربطی به
  Vapi ندارد). بدون این ستون‌ها، webhook مجبور می‌شد به user_id ارسالی در
  body اعتماد کند که دقیقاً همان چیزی است که spec امنیتی پروژه (تفکیک
  tenant) آن را ممنوع کرده است.

  همچنین `escalated_at` و `escalated_to` در حال حاضر توسط
  `supabase/functions/escalate-emergency/index.ts` و `src/pages/CallsPage.tsx`
  استفاده می‌شوند اما هیچ migration ای قبلی آن‌ها را روی جدول `calls`
  نساخته بود — این یک باگ از قبل موجود در repo است که این migration آن را
  هم برطرف می‌کند (بدون تغییر رفتار موجود، چون قبلاً این update ساکت fail
  می‌شد چون ستون‌ها اصلاً وجود نداشتند).

  ## چه چیزی اضافه می‌شود

  ### business_profile
  - `vapi_assistant_id` (text, nullable, UNIQUE) — Vapi assistant.id مربوط
    به دستیار صوتی همین business.
  - `vapi_phone_number_id` (text, nullable, UNIQUE) — Vapi phoneNumber.id
    مربوط به شماره ورودی همین business (به عنوان fallback وقتی
    assistantId در payload نیست).

  ### calls
  - `vapi_call_id` (text, nullable, UNIQUE) — Vapi call.id، برای اینکه
    چند event مربوط به یک تماس (tool-calls، end-of-call-report) روی
    دقیقاً یک ردیف upsert شوند نه چند ردیف تکراری.
  - `escalated_at` (timestamptz, nullable)
  - `escalated_to` (text, nullable)

  ## نکات مهم
  1. کاملاً additive است؛ هیچ ردیف موجودی تغییر نمی‌کند و هیچ policy یا
     trigger موجودی حذف/rewrite نمی‌شود.
  2. RLS تغییر نمی‌کند — این ستون‌ها روی جداول موجود (`business_profile`,
     `calls`) هستند که policy های فعلی‌شان (`get_account_owner_id()`)
     از قبل پوشش‌شان می‌دهد.
  3. بعد از اجرای این migration، برای هر business باید مقدار
     `vapi_assistant_id` (و/یا `vapi_phone_number_id`) دستی در dashboard
     Vapi یا مستقیم در دیتابیس ثبت شود — این خودش تولید نمی‌شود.
*/

ALTER TABLE business_profile
  ADD COLUMN IF NOT EXISTS vapi_assistant_id text,
  ADD COLUMN IF NOT EXISTS vapi_phone_number_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_profile_vapi_assistant_id
  ON business_profile(vapi_assistant_id)
  WHERE vapi_assistant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_profile_vapi_phone_number_id
  ON business_profile(vapi_phone_number_id)
  WHERE vapi_phone_number_id IS NOT NULL;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS vapi_call_id text,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_to text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_vapi_call_id
  ON calls(vapi_call_id)
  WHERE vapi_call_id IS NOT NULL;
