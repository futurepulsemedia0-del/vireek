// e2e/mobile-web.spec.ts — mobile guardrails on the public site (phones + small tablet, LTR/RTL, light/dark).
// Run: npx playwright test e2e/mobile-web.spec.ts --project=m-iphone-se --project=m-iphone-15-pro --project=m-pixel-7 --project=m-tablet
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ROUTES = ['/', '/pricing', '/login', '/signup', '/contact'] as const;
const DIRS = ['ltr', 'rtl'] as const;
const THEMES = ['light', 'dark'] as const;

async function open(page: Page, route: string, dir: 'ltr' | 'rtl', theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('vireek-theme', t), theme);
  await page.goto(route, { waitUntil: 'networkidle' });
  await page.evaluate(({ d, t }) => {
    document.documentElement.dir = d;
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, { d: dir, t: theme });
}

for (const route of ROUTES) {
  for (const dir of DIRS) {
    for (const theme of THEMES) {
      test.describe(`${route} ${dir} ${theme}`, () => {
        test('no horizontal page scroll', async ({ page }) => {
          await open(page, route, dir, theme);
          const o = await page.evaluate(() => {
            const de = document.documentElement;
            const vw = de.clientWidth;
            const offenders = [...document.querySelectorAll<HTMLElement>('body *')]
              .filter((el) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 0 && s.position !== 'fixed' && (r.right > vw + 1 || r.left < -1) && !el.closest('[class*="overflow-x-auto"],[class*="overflow-hidden"],.logo-marquee');
              })
              .slice(0, 5)
              .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
            return { scrollW: de.scrollWidth, vw, offenders };
          });
          expect(o.scrollW, JSON.stringify(o.offenders)).toBeLessThanOrEqual(o.vw);
        });

        test('text inputs are >= 16px (no iOS focus zoom)', async ({ page }) => {
          await open(page, route, dir, theme);
          const small = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]), select, textarea')]
              .filter((el) => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16)
              .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('name') ?? el.id}]`),
          );
          expect(small).toEqual([]);
        });

        test('no visible text below 12px', async ({ page }) => {
          await open(page, route, dir, theme);
          const tiny = await page.evaluate(() => {
            const out: string[] = [];
            const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = w.nextNode(); n && out.length < 8; n = w.nextNode()) {
              const el = n.parentElement;
              if (!el || !n.textContent?.trim() || el.closest('script,style,noscript,[aria-hidden="true"]')) continue;
              const s = getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden') continue;
              if (parseFloat(s.fontSize) < 12) out.push(`${el.tagName.toLowerCase()} ${s.fontSize} "${n.textContent.trim().slice(0, 24)}"`);
            }
            return out;
          });
          expect(tiny).toEqual([]);
        });
      });
    }
  }
}

test('floating launchers do not overlap each other or the bottom nav (LTR, light)', async ({ page }) => {
  await open(page, '/', 'ltr', 'light');
  const rects = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-floating-launcher], nav[aria-label*="obile"]')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => { const r = el.getBoundingClientRect(); return { n: el.getAttribute('aria-label') ?? el.className.slice(0, 30), l: r.left, t: r.top, r: r.right, b: r.bottom }; }),
  );
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!, b = rects[j]!;
      const overlap = a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
      expect(overlap, `${a.n} overlaps ${b.n}`).toBe(false);
    }
  }
});

test('axe: WCAG 2.2 AA on the home page', async ({ page }) => {
  await open(page, '/', 'ltr', 'light');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});
