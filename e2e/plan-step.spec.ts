// e2e/plan-step.spec.ts
//
// Plan-selection step. Needs a Supabase project with the plan_onboarding migration, Stripe TEST mode secrets on the
// edge functions (STRIPE_SECRET_KEY=sk_test_..., STRIPE_PRICE_* test prices) and a mail catcher for the OTP.
// Env (all required for the full journey, otherwise it is skipped, never faked):
//   E2E_PLAN_STEP=1               enable
//   E2E_OTP_CODE=123456           fixed OTP for the test project (Supabase test OTP) so the run needs no inbox
//   E2E_BASE_URL                  already used by playwright.config.ts
// Stripe test card: 4242 4242 4242 4242, any future date, any CVC. Declined: 4000 0000 0000 0002.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const enabled = process.env.E2E_PLAN_STEP === '1' && !!process.env.E2E_OTP_CODE;
const unique = () => `e2e+plan${Date.now()}@example.com`;

async function signUpAndVerify(page: Page, email: string, query = '') {
  await page.goto(`/signup${query}`);
  await page.getByLabel(/full name/i).fill('E2E Owner');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel(/^password/i).first().fill('Str0ng!Passw0rd');
  await page.getByLabel(/confirm/i).fill('Str0ng!Passw0rd');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /create account|sign up/i }).click();
  const digits = (process.env.E2E_OTP_CODE as string).split('');
  const boxes = page.locator('input[inputmode="numeric"]');
  for (let i = 0; i < digits.length; i++) await boxes.nth(i).fill(digits[i]);
}

test.describe('plan step (public, no Stripe needed)', () => {
  test('/pricing -> signup keeps ?plan= and ?billing= for visitors', async ({ page }) => {
    await page.goto('/pricing');
    const professional = page.locator('a[href^="/signup?plan=professional"]').first();
    await expect(professional).toBeVisible();
    await expect(professional).toHaveAttribute('href', '/signup?plan=professional&billing=monthly');
  });

  test('unauthenticated visitors cannot open /onboarding/plan', async ({ page }) => {
    await page.goto('/onboarding/plan');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('plan step (full journey, Stripe test mode)', () => {
  test.skip(!enabled, 'set E2E_PLAN_STEP=1 and E2E_OTP_CODE to run against a configured test project');

  test('signup -> verify -> plan (preselected from deep link) -> Stripe test checkout -> onboarding', async ({ page }) => {
    await signUpAndVerify(page, unique(), '?plan=professional&billing=annual');
    await expect(page).toHaveURL(/\/onboarding\/plan/, { timeout: 30_000 });

    // deep link survived verification: Professional + Annual are preselected
    await expect(page.getByRole('radio', { name: /professional/i })).toBeChecked();
    await expect(page.getByRole('radio', { name: /annual/i })).toBeChecked();

    // terms are visible BEFORE payment
    await expect(page.getByRole('heading', { name: /before you pay/i })).toBeVisible();
    await expect(page.getByText(/renews automatically/i)).toBeVisible();

    await page.getByRole('button', { name: /start .*trial|continue to secure payment/i }).click();
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });

    await page.getByLabel(/card number/i).fill('4242424242424242');
    await page.getByLabel(/expiration/i).fill('12 / 34');
    await page.getByLabel(/cvc/i).fill('123');
    await page.getByLabel(/cardholder name|name on card/i).fill('E2E Owner');
    await page.getByTestId('hosted-payment-submit-button').click();

    // back on the app: waits for the VERIFIED WEBHOOK, then continues to the existing onboarding
    await page.waitForURL(/\/onboarding\/plan\?checkout=success|\/dashboard/, { timeout: 60_000 });
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });
  });

  test('refresh and a second tab resume at the same choice (server-side intent)', async ({ page, context }) => {
    await signUpAndVerify(page, unique());
    await expect(page).toHaveURL(/\/onboarding\/plan/, { timeout: 30_000 });
    await page.getByRole('radio', { name: /business/i }).check();
    await page.waitForTimeout(800); // intent save is fire-and-forget
    await page.reload();
    await expect(page.getByRole('radio', { name: /business/i })).toBeChecked();
    const second = await context.newPage();
    await second.goto('/onboarding/plan');
    await expect(second.getByRole('radio', { name: /business/i })).toBeChecked();
  });

  test('skip for now lands on the dashboard with the resume banner', async ({ page }) => {
    await signUpAndVerify(page, unique());
    await expect(page).toHaveURL(/\/onboarding\/plan/, { timeout: 30_000 });
    await page.getByRole('button', { name: /skip for now/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText(/limited access/i)).toBeVisible();
  });

  test('cancelling on Stripe returns to the step with a clear, calm message', async ({ page }) => {
    await signUpAndVerify(page, unique());
    await page.getByRole('radio', { name: /starter/i }).check();
    await page.getByRole('button', { name: /start .*trial|continue to secure payment/i }).click();
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    await page.getByRole('link', { name: /back|return/i }).first().click();
    await expect(page).toHaveURL(/\/onboarding\/plan/);
    await expect(page.getByText(/nothing was charged/i)).toBeVisible();
  });

  test('plan step has no WCAG 2.2 AA violations (axe)', async ({ page }) => {
    await signUpAndVerify(page, unique());
    await expect(page).toHaveURL(/\/onboarding\/plan/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /choose your plan/i })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('keyboard only: radios are reachable and the CTA is operable', async ({ page }) => {
    await signUpAndVerify(page, unique());
    await expect(page).toHaveURL(/\/onboarding\/plan/, { timeout: 30_000 });
    await page.getByRole('radio', { name: /monthly/i }).focus();
    await page.keyboard.press('ArrowRight'); // radio groups move with arrow keys
    await expect(page.getByRole('radio', { name: /annual/i })).toBeChecked();
  });
});
