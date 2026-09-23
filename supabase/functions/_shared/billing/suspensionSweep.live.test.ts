// supabase/functions/_shared/billing/suspensionSweep.live.test.ts
//
// این تست روی یک Supabase واقعی اجرا می‌شه (نه mock): یک کاربر تست موقت
// می‌سازه، suspend می‌کنه، و در پایان پاک می‌کنه. عمداً از اجرای پیش‌فرض
// `npm run test` جداست (پسوند .live.test.ts) و فقط با `npm run test:live`
// اجرا می‌شه چون روی یک دیتابیس واقعی می‌نویسه.
//
// **هیچ‌وقت روی پروژه‌ی production اجرا نکنید.** SUPABASE_TEST_URL و
// SUPABASE_TEST_SERVICE_ROLE_KEY باید به یک پروژه‌ی Supabase جدا و
// فقط-برای-تست اشاره کنن.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { runSuspensionSweep } from './suspensionSweep';

const URL = process.env.SUPABASE_TEST_URL;
const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

describe.skipIf(!URL || !KEY)('runSuspensionSweep (live)', () => {
  let admin: SupabaseClient;
  let testUserId: string;

  beforeAll(async () => {
    admin = createClient(URL!, KEY!, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.admin.createUser({
      email: `suspension-sweep-test-${Date.now()}@example.com`,
      email_confirm: true,
      password: crypto.randomUUID(),
    });
    if (error || !data.user) throw new Error(`Failed to create test user: ${error?.message}`);
    testUserId = data.user.id;
  });

  afterAll(async () => {
    if (testUserId) await admin.auth.admin.deleteUser(testUserId);
  });

  it('suspends a past_due account whose grace period already expired', async () => {
    const expiredGraceEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await admin
      .from('profiles')
      .update({ subscription_status: 'past_due', status: 'active', payment_grace_period_ends_at: expiredGraceEnd })
      .eq('id', testUserId);

    const result = await runSuspensionSweep(admin as unknown as import('./suspensionSweep').SuspensionQueryClient);
    expect(result.suspendedIds).toContain(testUserId);

    const { data: profile } = await admin.from('profiles').select('subscription_status, status').eq('id', testUserId).single();
    expect(profile?.subscription_status).toBe('suspended');
    expect(profile?.status).toBe('suspended');
  });

  it('does NOT suspend a past_due account whose grace period has not expired yet', async () => {
    const futureGraceEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await admin
      .from('profiles')
      .update({ subscription_status: 'past_due', status: 'active', payment_grace_period_ends_at: futureGraceEnd })
      .eq('id', testUserId);

    const result = await runSuspensionSweep(admin as unknown as import('./suspensionSweep').SuspensionQueryClient);
    expect(result.suspendedIds).not.toContain(testUserId);
  });

  it('does NOT touch an account that is not past_due, even with a stale expired grace-period timestamp', async () => {
    const expiredGraceEnd = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await admin
      .from('profiles')
      .update({ subscription_status: 'active', status: 'active', payment_grace_period_ends_at: expiredGraceEnd })
      .eq('id', testUserId);

    const result = await runSuspensionSweep(admin as unknown as import('./suspensionSweep').SuspensionQueryClient);
    expect(result.suspendedIds).not.toContain(testUserId);
  });
});
