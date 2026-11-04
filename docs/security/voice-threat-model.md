# مدل تهدید عامل صوتی Vireek

> دامنه: مسیر `vapi-webhook` (tool-calls)، پیام‌های SMS/ایمیل خروجی، خلاصه‌ها، ترنسکریپت‌ها و داده‌های ذخیره‌شده‌ای که وارد پرامپت می‌شوند.
> اصل طراحی: **فرض می‌کنیم مدل کاملاً دستکاری شده و آسیب‌زننده‌ترین tool-call ممکن را فرستاده است.** کنترل‌ها در سرور اعمال می‌شوند، نه در پرامپت.

## دارایی‌ها و مرزهای اعتماد
| مرز | اعتماد |
|---|---|
| گفتار تماس‌گیرنده، ASR | غیرقابل‌اعتماد |
| آرگومان‌های tool-call (ساختهٔ مدل) | غیرقابل‌اعتماد |
| Caller ID (`call.customer.number`) | **ادعا است، نه اثبات** (قابل جعل) |
| یادداشت‌ها، نام مشتری، داده‌های import‌شده، memory | غیرقابل‌اعتماد (تزریق غیرمستقیم) |
| نتیجهٔ ابزارها | فقط پس از `finalizeToolResult` به مدل می‌رسد |
| حالت kill-switch، state تماس، OTP، audit | فقط سرور؛ مدل نمی‌تواند بنویسد |

## ماتریس تهدید → کنترل
| # | تهدید | کنترل اصلی | آزمون harness |
|---|---|---|---|
| T1 | جعل هویت مالک/مشتری/تکنسین | caller-binding، step-up (OTP به شمارهٔ ثبت‌شده + ≥۲ مشخصهٔ معلوم)، lookup فقط با `phone` | impersonation |
| T2 | مهندسی اجتماعی برای refund/تغییر آدرس/افشا/ریست رمز و MFA | ابزارهای `voice_never` همیشه رد + audit؛ ابزار ناشناخته رد | social_engineering |
| T3 | تزریق پرامپت گفتاری / role-play | اسکنر تزریق روی آرگومان‌ها، anomaly score، محدودسازی خودکار تماس | prompt_injection |
| T4 | DTMF/IVR (توالی ارقام، `*`/`#`، کد در میانهٔ جمله) | `normalizeSpokenCode`، allowlist آرگومان، محدودیت تلاش | dtmf_ivr |
| T5 | کلون صدا | صدا اثبات هویت نیست؛ ریسک فقط با OTP به شمارهٔ ثبت‌شده کم می‌شود؛ هیچ تغییر مالی/دسترسی روی صدا نیست | voice_clone |
| T6 | نشت بین‌مشتری‌ها (خلاصه/SMS/ایمیل) | فیلتر خروجی (ایمیل/تلفن غیر از مال تماس‌گیرنده، SSN، کارت Luhn، حساب، DOB)، قفل خودکار روی canary | cross_customer_leakage |
| T7 | سوءاستفاده از ابزار (رزرو اسپم، لغو، کاوش قیمت) | rate limit برای هر تماس/شماره/روز + burst تننت، confirm-before-write | tool_abuse |
| T8 | exfiltration از ترنسکریپت/وب‌هوک | `scanOutbound`، canary پرامپت (`{{security_ref}}`) + اسکن ترنسکریپت پایان تماس | exfiltration |
| T9 | تزریق غیرمستقیم از یادداشت/داده import‌شده | `neutralizeUntrusted` (quarantine/truncate)، memory فقط دسته‌های کم‌ریسک | indirect_injection |
| T10 | SMS bombing با درخواست OTP | سقف ۳ چالش/تماس، ۵/روز برای هر مشتری، OTP فقط به شمارهٔ ثبت‌شده | impersonation |

## لایه‌های کنترل (ترتیب gate)
ابزار ناشناخته/`voice_never`/نوع تماس → kill-switch (global/tenant) و حالت تماس → allowlist آرگومان → اسکن تزریق + canary → decoy → caller-binding → سطح هویت → rate limit → confirm-before-write (hash پارامترها، حداقل ۲ ثانیه، TTL ۱۸۰ ثانیه، یک‌بار مصرف) → audit.
خروجی: فیلتر PII/canary/secret. خطای زیرساخت: **fail-closed** برای همه به‌جز ابزارهای ایمنی (`flag_emergency_call`, `request_human_transfer`).

## Audit غیرقابل‌تغییر
جدول `voice_security_audit`: فقط append، زنجیرهٔ هش، trigger علیه UPDATE/DELETE/TRUNCATE، تابع `voice_audit_verify_chain(tenant)`. ردیف‌های high/critical در `ai_security_events` هم alert می‌سازند.

## محدودیت‌های شناخته‌شده (ریسک باقی‌مانده)
- harness رفتار **مدل زنده** را نمی‌سنجد؛ فقط ثابت می‌کند حتی اگر مدل دستکاری شود کنترل‌ها می‌ایستند.
- صدای واقعی/ASR و جعل telephony (STIR/SHAKEN) آزموده نشده.
- تأیید درون‌برنامه‌ای (in-app approval) ساخته نشده؛ در حال حاضر فقط OTP.
- greeting با نام بر اساس caller ID (`buildCallerContextVariable`) هنوز اطلاعات حداقلی افشا می‌کند → تصمیم محصول/حقوقی.
