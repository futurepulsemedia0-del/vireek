// supabase/functions/_shared/billing/suspensionSweep.ts
//
// نیمه‌ی واقعیِ «قطع سرویس» توی dunning. عمداً import مستقیم از
// npm:@supabase/supabase-js نداره — فقط یک shape حداقلی از client که لازم
// داره رو تایپ می‌کنه، پس این فایل هم زیر Deno (edge function واقعی) هم
// زیر Node/Vitest (تست‌ها) بدون هیچ تغییری اجرا می‌شه.

interface SuspensionQueryResult {
  data: Array<{ id: string; email: string }> | null;
  error: { message: string } | null;
}

export interface SuspensionQueryClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): {
        lt(column: string, value: unknown): {
          select(columns: string): Promise<SuspensionQueryResult>;
        };
      };
    };
  };
}

export interface SuspensionResult {
  suspendedCount: number;
  suspendedIds: string[];
}

/**
 * هر اکانتی که هنوز past_due هست و grace period ش گذشته رو suspend می‌کنه.
 * `status` کنار `subscription_status` ست می‌شه تا هر کد access-gating ای
 * که `profiles.status` رو چک می‌کنه (الان یا بعداً) هم این اکانت‌ها رو
 * درست ببینه، بدون سیم‌کشی اضافه.
 */
export async function runSuspensionSweep(admin: SuspensionQueryClient, now: Date = new Date()): Promise<SuspensionResult> {
  const { data: suspended, error } = await admin
    .from('profiles')
    .update({ subscription_status: 'suspended', status: 'suspended' })
    .eq('subscription_status', 'past_due')
    .lt('payment_grace_period_ends_at', now.toISOString())
    .select('id, email');

  if (error) throw new Error(error.message);

  return { suspendedCount: suspended?.length ?? 0, suspendedIds: (suspended ?? []).map((p) => p.id) };
}
