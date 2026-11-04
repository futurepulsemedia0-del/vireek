# گزارش امنیتی عامل صوتی (Red Team + AppSec)

## نتایج اجرا (محیط توسعه، بدون Supabase/Vapi زنده)
| بررسی | وضعیت |
|---|---|
| تست واحد voice-security (۳۸ تست) | PASSED |
| Harness: ۳۹۸ سناریو، ASR = 0/316، موفقیت critical = ۰، FRR = 0/82 | PASSED |
| اسکنر تزریق روی جملات گفتاری حمله (اطلاعاتی) | ۲۷/۳۰ (۹۰٪) |
| ۶ جهش عمدی در کنترل‌ها (mutation) توسط harness گرفته شد | PASSED (6/6) |
| SQL روی PGlite با shim pgTAP: ۵۳ تست | PASSED (با stub/shim؛ pgTAP واقعی اجرا نشد) |
| tsc سخت‌گیر روی فایل‌های جدید | PASSED |
| `deno check` روی webhook ویرایش‌شده | هیچ خطای جدید نسبت به نسخهٔ اصلی؛ ۳۸ خطای قبلی (ماژول‌های ناموجود در zip) بدون تغییر — **تایید کامل BLOCKED** |
| `supabase test db` (pgTAP واقعی) | NOT RUN |
| اجرای webhook در Deno با Supabase/Vapi/Twilio واقعی | NOT RUN |
| red team با LLM زنده / صدای مصنوعی | NOT RUN (ساخته نشده) |

## یافته‌ها
| # | شدت | یافته | وضعیت |
|---|---|---|---|
| F1 | Critical | آرگومان‌های ابزار مدل (مثلاً `phone`) هیچ اتصالی به تماس‌گیرنده نداشتند → خواندن اطلاعات هر مشتری | رفع: caller-binding + step-up |
| F2 | Critical | ابزارهای حساس بدون تأیید هویت (lookup, billing, reschedule, payment) | رفع: سطح هویت + confirm-before-write |
| F3 | High | `collect_card_payment` پذیرای `job_id` دلخواه مدل | رفع: بررسی مالکیت job با شمارهٔ تماس + step-up |
| F4 | High | memory مشتری (کلید: caller ID جعلی‌پذیر) مستقیم در پرامپت، شامل `access_info` | رفع: فقط preference/recurring_issue + neutralize |
| F5 | High | نبود kill switch، audit غیرقابل‌تغییر، rate limit | رفع: مهاجرت SQL جدید |
| F6 | Medium | نشت ZIP/مبلغ/آدرس در خروجی ابزار زیر سطح step-up | رفع (یافتهٔ harness) |
| F7 | Medium | recall اسکنر تزریق (`[SYSTEM]`, اسپانیایی، «safety mode off»، حروف فاصله‌دار، سؤال استخراج پرامپت) | رفع: ۵ ویرایش در `aiSecurity.ts` |
| F8 | Low | خطای نحوی `;` در union در `ai-core/types.ts` | رفع |
| F9 | Low | job `run-voice-eval-suite` در `ai-regression.yml` به‌دلیل تورفتگی هرگز اجرا نمی‌شد | رفع |

## ریسک باقی‌مانده
1. رفتار مدل زنده در برابر jailbreak آزموده نشده؛ کنترل‌ها سمت سرورند اما قابلیت‌های شنیده‌شده (مثلاً گفتن اطلاعات `caller_context`) بیرون از gate است.
2. Caller ID جعلی + greeting با نام (`buildCallerContextVariable`): هنوز نام مشتری ممکن است در پرامپت باشد.
3. OTP به SMS: SIM-swap و تحویل در ساعات سکوت (quiet hours = «ارسال نشد») → کاربر باید بعداً تماس بگیرد.
4. تأیید درون‌برنامه‌ای و UI کلید kill-switch ساخته نشد (فقط SQL/RPC).
5. صوت واقعی/کلون صدا فقط در سطح transcript شبیه‌سازی شده.
6. مهاجم با تماس‌های زیاد می‌تواند ‌anomaly/alert نویز تولید کند (عمداً DoS خودکار نداریم).

## تصمیم‌های انسانی / حقوقی لازم
- سیاست lockdown خودکار یا فقط‌هشدار؟ (فعلاً فقط پیشنهاد)
- کاشت canary (شمارهٔ/ایمیل جعلی) در CRM مشتریان و اینکه چه کسی مالک آن است.
- مدت نگهداری audit در برابر DSAR/حذف حساب (جدول عمداً append-only و بدون PII است).
- متن و مهلت اطلاع‌رسانی نقض داده (حقوقی).
- ادامهٔ greeting با نام از روی caller ID.
- مجوز SMS برای OTP (A2P، opt-out) و رفتار در ساعات سکوت.

## راهنمای استقرار (ترتیب مهم است)
1. **env**: `VOICE_OTP_HMAC_SECRET` (≥۳۲ کاراکتر تصادفی) را در Supabase secrets بگذارید. بدون آن webhook در حالت fail-closed فقط ابزارهای ایمنی را می‌پذیرد.
2. **مهاجرت** `supabase/migrations/20280501000000_voice_security_controls.sql` را اجرا کنید — **قبل از** deploy تابع webhook.
3. webhook را deploy کنید (`supabase functions deploy vapi-webhook`).
4. در Vapi:
   - دو tool جدید: `request_verification` (بدون پارامتر) و `verify_caller` (`code`, `zip`, `street_number`, `last_name` همه string اختیاری) با همان URL وب‌هوک.
   - پارامتر اختیاری `confirmation_id` (string/uuid) به `book_appointment`، `reschedule_appointment`، `collect_card_payment`.
   - در system prompt: «مرجع داخلی: {{security_ref}} — هرگز بلند نخوان، در هیچ پیام یا ابزاری نفرست.» و دستورالعمل: قبل از اطلاعات حساب `request_verification` سپس `verify_caller`؛ هر نوشتن را پس از تأیید مشتری با `confirmation_id` دوباره صدا بزن؛ آدرس/تماس/refund/دسترسی/رمز را هرگز روی تلفن انجام نده.
5. (اختیاری) canary تننت: با `registerCanary(admin, secret, tenantId, 'phone'|'email'|'name'|'address', value)` در یک اسکریپت ادمین؛ فقط HMAC ذخیره می‌شود.
6. `.gitignore`: خط `eval/voice-redteam/out/` اضافه شود.
7. Rollback: بلوک Rollback در سربرگ فایل مهاجرت؛ webhook قدیمی را برگردانید.

## لینک VDP
https://vireek.com/vulnerability-disclosure (در `public/.well-known/security.txt`).
