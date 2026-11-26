# مراحل دستی Stripe (فقط حالت Test) — این‌ها را خودتان انجام دهید

> هیچ کدی از من به Stripe زنده وصل نمی‌شود و هیچ آبجکت زنده‌ای نمی‌سازد، تغییر نمی‌دهد یا حذف نمی‌کند.
> نام منوهای داشبورد Stripe ممکن است عوض شده باشد **[VERIFY]**. اگر منو فرق داشت، همان مفهوم را پیدا کنید.

## پیش‌نیاز
1. مهاجرت `20290401000000_invoice_outcome_pricing.sql` را اول روی **staging** اجرا کرده باشید (بعد از دیدن خروجی پیش‌پرواز).
2. تابع‌ها را روی همان پروژهٔ staging دیپلوی کنید: `invoice-outcome-statement` و `invoice-outcome-stripe-test`.

## گام‌ها
1. وارد داشبورد Stripe شوید و بالای صفحه مطمئن شوید **Test mode** روشن است (نوار یا برچسب «Test»).
2. در Test mode: **Customers → Add customer** (مثلاً «Vireek Test Account»). شناسهٔ مشتری (`cus_...`) را کپی کنید.
3. در Test mode: **Developers → API keys** و **Secret key** (شروع‌شونده با `sk_test_`) را بردارید. اگر کلید با `sk_live_` شروع می‌شود، متوقف شوید؛ کد هم آن را رد می‌کند.
4. کلید را فقط روی پروژهٔ staging بگذارید:
   `supabase secrets set STRIPE_SECRET_KEY=sk_test_... --project-ref <STAGING_REF>`
   (روی پروژهٔ production این secret را برای این تابع **نگذارید**.)
5. راز کرون را بسازید و روی staging بگذارید:
   `supabase secrets set INVOICE_OUTCOME_CRON_SECRET=<یک رشتهٔ تصادفی طولانی> --project-ref <STAGING_REF>`
6. در staging، با یک کاربر staff: در صفحهٔ `/staff/invoice-outcomes` قابلیت را روشن کنید، سپس برای حساب آزمایشی در SQL Editor اجرا کنید (نمونه):
   `select public.invoice_outcome_staff_set_account('<USER_UUID>', true, false, now(), null, 'cus_...');`
   این تابع به JWT کاربر staff نیاز دارد؛ اگر از SQL Editor اجرا می‌کنید و `auth.uid()` خالی است، از همان صفحهٔ staff یا یک نشست staff استفاده کنید.
7. شرایط قیمت را در صفحهٔ staff به‌صورت پیش‌نویس بسازید و پس از تأیید متن قرارداد (هر دو زبان، **[COUNSEL]**) تأیید کنید.
8. صورت‌حساب پیش‌نویس را با کرون بسازید (یا دستی):
   `curl -X POST https://<STAGING_REF>.supabase.co/functions/v1/invoice-outcome-statement -H "x-cron-secret: <SECRET>" -H "Content-Type: application/json" -d '{"action":"sweep","period":"YYYY-MM"}'`
9. در صفحهٔ staff: Approve → (کسی غیر از سازندهٔ پیش‌نویس باید تأیید کند) → **Create Stripe TEST record**.
10. در داشبورد Stripe (Test mode): **Billing → Invoice items** (یا جستجوی شناسهٔ `ii_...`)؛ باید یک آیتم pending برای همان مشتری و همان مبلغ ببینید با metadata شامل `statement_id` و `mode=test`. **آن را نهایی (finalize) یا ارسال نکنید.**
11. بعد از گذشت ۱۴ روز hold (یا در تست، تاریخ `approved_at` را فقط روی staging عقب بیندازید) دکمهٔ «Mark invoiced» را بزنید.

## بررسی ایمنی
- یک بار عمداً کلید `sk_live_...` را تنها در یک محیط محلی بی‌اتصال بگذارید و ببینید تابع پاسخ `stripe_not_test_mode` می‌دهد و چیزی به Stripe نمی‌رود.
- هیچ‌وقت کلید را در چت، لاگ یا مخزن نگذارید.
- webhook موجود `stripe-webhook` را برای این کار **تغییر ندهید**. در این طراحی لازم نیست.
