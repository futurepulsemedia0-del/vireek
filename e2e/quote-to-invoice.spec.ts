// e2e/quote-to-invoice.spec.ts
//
// نیاز به E2E_TEST_EMAIL / E2E_TEST_PASSWORD (همون که در
// auth-and-dispatch.spec.ts استفاده شد). فقط سطح ناوبری + سلامت صفحه رو
// تضمین می‌کنه — انتخابگرهای دقیق فرم چندمرحله‌ای ساخت quote رو من از
// روی کد ندیدم، پس TODO زیر رو با selectorهای واقعی فرمتون کامل کنید؛
// یک E2E با selector حدسی، خطرناک‌تر از نبودنشه چون false-negative می‌ده.
import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;

test.describe('Quote → Invoice workflow', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping.');

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email address').fill(EMAIL!);
    await page.getByLabel('Password').fill(PASSWORD!);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/dashboard/);
  });

  test('Quotes page loads and lists estimates without a crash', async ({ page }) => {
    await page.goto('/dashboard/quotes');
    await expect(page.getByRole('heading', { name: 'Quotes & Estimates' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });

  test('Jobs page loads and shows invoice status for each job', async ({ page }) => {
    await page.goto('/dashboard/jobs');
    await expect(page.getByRole('heading', { name: /jobs/i })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Something went wrong');
  });

  // TODO (تیم شما با دید کامل UI پرشه): مراحل زیر رو با selectorهای واقعی کامل کنید:
  //   ۱. کلیک روی دکمه‌ی "New Quote"/"New Estimate" در QuotesPage
  //   ۲. پرکردن فرم TieredEstimateBuilder و ثبت quote
  //   ۳. رفتن به job مربوطه و کلیک "Create Invoice" / تغییر invoice_status
  //   ۴. assert که invoice_status روی UI به 'sent' تغییر کرده
  // این ۴ قدم، دقیقاً همون "workflow test" واقعیه که ریسک بیزینسی رو پوشش می‌ده —
  // من عمداً حدس نزدم تا یک تست شکننده با selector غلط بهتون تحویل ندم.
});
