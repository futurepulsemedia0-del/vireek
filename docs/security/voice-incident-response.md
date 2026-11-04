# مسیر پاسخ به حادثه — عامل صوتی

## ۱. تشخیص
منابع: ردیف‌های high/critical در `ai_security_events` (AI Security Center)، `voice_security_audit` با کدهای `canary_hit`, `prompt_canary_in_transcript`, `cross_customer`, `secret_in_tool_result`، امتیاز anomaly ≥ ۶۰ (تماس محدود) یا ≥ ۹۰ (قفل)، گزارش خارجی از طریق VDP: https://vireek.com/vulnerability-disclosure و `security.txt`.
شدت: **Critical** = افشای PII یا تغییر نوشتنی غیرمجاز یا نشت prompt/canary؛ **High** = تلاش موفق برای عبور از step-up؛ **Medium/Low** = حملهٔ مسدودشده.

## ۲. مهار (kill switch)
- یک تننت (مالک/مدیر امنیت AI، از کلاینت): `select public.voice_set_my_mode('lockdown', 'incident <id>');` (حالت‌ها: `normal` / `restricted` = ایمنی+عمومی / `lockdown` = فقط ابزار ایمنی).
- سراسری یا تننت دیگر (فقط service role): `select public.voice_set_mode('global', null, 'lockdown', 'incident <id>', null);`
- اثر: از tool-call بعدی، بدون deploy. برگشت: همان تابع با `'normal'`.
- سیاست: سیستم **فقط پیشنهاد** تغییر حالت می‌دهد (برای جلوگیری از DoS با تماس مهاجم)؛ تصمیم با انسان است.
- هم‌زمان: اگر لازم است رمز/کلید را بچرخانید (`VOICE_OTP_HMAC_SECRET` → canaryهای پرامپت هم می‌چرخند)، و در Vapi تماس‌های فعال را قطع کنید.

## ۳. بررسی
`select public.voice_audit_verify_chain('<tenant>');` برای اطمینان از دست‌نخوردن شواهد؛ سپس خواندن ردیف‌های audit همان call_id. audit فقط کد/شناسه/شمارش دارد، نه PII.

## ۴. اطلاع‌رسانی به مشتری
اگر داده‌ٔ شخصی افشا شده: به مالک تننت و در صورت لزوم مشتریان آسیب‌دیده ظرف مهلت قانونی اطلاع دهید. **مهلت و محتوا تصمیم حقوقی است** (قوانین ایالتی ایالات متحده، CCPA و غیره) — پیش از ارسال با مشاور حقوقی تأیید شود. به گزارش‌دهندهٔ VDP پاسخ دهید.

## ۵. رفع و رگرسیون
1. علت ریشه‌ای را اصلاح کنید (کنترل/اسکنر/policy).
2. سناریوی بازتولید را به `eval/voice-redteam/scenarios.ts` اضافه کنید (id جدید) — باید پیش از اصلاح fail و پس از آن pass شود.
3. `npm run test:redteam` و تست‌های واحد را اجرا کنید؛ ASR critical باید ۰ بماند.
4. حالت تننت را به `normal` برگردانید و ۲۴ ساعت پایش کنید.
5. بررسی پس‌از‌حادثه (۵ روز کاری): خط زمانی، کنترل‌هایی که کار کردند/نکردند، اقدام‌ها.
