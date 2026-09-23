// supabase/functions/_shared/stripe/dunningLogic.ts
//
// منطق خالص state-machine دانینگ — بدون Stripe SDK و بدون Deno globals،
// پس دقیقاً همین فایل هم زیر Deno edge function اجرا می‌شه هم زیر
// Vitest/Node تست می‌شه. stripe-webhook/index.ts این توابع رو صدا می‌زنه
// به‌جای این‌که تاریخ/stage رو inline حساب کنه — یعنی این منطق فقط یک‌جا
// می‌تونه خراب بشه، و همون یک‌جا تحت تسته.

export interface DunningState {
  dunning_stage: number;
  payment_failed_at: string | null; // ISO
}

export interface ComputedDunningUpdate {
  subscription_status: 'past_due';
  dunning_stage: number;
  payment_failed_at: string;
  payment_grace_period_ends_at: string;
  last_payment_error: string | null;
  daysLeft: number;
}

export const GRACE_PERIOD_DAYS = 7;

/**
 * با گرفتن وضعیت فعلی دانینگ یک پروفایل و یک شکست پرداخت جدید، دقیقاً
 * همون patch ای که باید روی DB اعمال بشه رو برمی‌گردونه، به‌علاوه‌ی
 * تعداد روز باقی‌مانده (برای ایمیل تشدید). ساعت streak از اولین شکست
 * شروع می‌شه، نه هر retry — یک retry بعدی فقط daysLeft رو کم می‌کنه،
 * هیچ‌وقت grace period رو ریست نمی‌کنه.
 */
export function computeDunningUpdate(
  current: DunningState,
  declineReason: string | null,
  now: Date = new Date(),
): ComputedDunningUpdate {
  const isFirstFailureInStreak = !current.payment_failed_at;
  const failedAt = isFirstFailureInStreak ? now : new Date(current.payment_failed_at as string);
  const graceEndsAt = new Date(failedAt.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const nextStage = (current.dunning_stage ?? 0) + 1;
  const daysLeft = Math.max(1, Math.ceil((graceEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));

  return {
    subscription_status: 'past_due',
    dunning_stage: nextStage,
    payment_failed_at: failedAt.toISOString(),
    payment_grace_period_ends_at: graceEndsAt.toISOString(),
    last_payment_error: declineReason,
    daysLeft,
  };
}

/** یک پرداخت موفق، فارغ از این‌که در چه stage ای بوده، کامل ریست می‌کنه. */
export function computeRecoveryUpdate() {
  return {
    subscription_status: 'active' as const,
    status: 'active' as const,
    dunning_stage: 0,
    payment_failed_at: null,
    payment_grace_period_ends_at: null,
    last_payment_error: null,
  };
}
