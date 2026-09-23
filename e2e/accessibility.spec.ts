// e2e/accessibility.spec.ts
//
// نگهبانِ خودکار regression برای WCAG 2.2 AA — روی هر CI run، axe-core
// رو روی صفحات کلیدی اجرا می‌کنه. لیبل گم‌شده، افت کنتراست، و ساختار
// landmark خراب رو قبل از deploy می‌گیره — جایگزین تست دستی کیبورد/
// screen-reader نیست (axe نمی‌تونه ترتیب منطقی Tab یا focus trap رو بسنجه).
//
// نیاز به نصب: npm install -D @axe-core/playwright
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = ['/', '/pricing', '/login', '/accessibility-statement'];

for (const path of PAGES) {
  test(`${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();

    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
