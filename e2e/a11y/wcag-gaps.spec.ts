// e2e/a11y/wcag-gaps.spec.ts
//
// Closes ACR evidence gaps listed by `npm run a11y:acr` (docs/accessibility/acr-draft.md).
// Public routes only, no auth and no mocked backend (same approach as e2e/accessibility.spec.ts).
//   4.1.3  global live region is mounted           2.4.1  skip link reaches #main-content
//   2.4.7  focus changes the element's appearance   2.4.11 focused element is not covered by other content
//   1.4.10 no horizontal scroll at 320 CSS px       1.4.12 no clipped text under the WCAG text-spacing overrides
//   3.1.1  <html lang> is a valid language tag      3.3.8  password field does not block paste
// NOT RUN when authored (no browser or app server available). Heuristics: a failure is a lead to triage, not proof.
import { test, expect, type Page } from '@playwright/test';

const ROUTES = ['/', '/pricing', '/login', '/accessibility-statement'] as const;
const MAX_TABS = 20;

test.describe('4.1.3 status messages', () => {
  test('the global polite and assertive live regions are mounted exactly once', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('div[role="status"][aria-live="polite"][aria-atomic="true"]')).toHaveCount(1);
    await expect(page.locator('div[role="alert"][aria-live="assertive"][aria-atomic="true"]')).toHaveCount(1);
  });
});

test.describe('2.4.1 bypass blocks', () => {
  test('the first Tab reveals a skip link and activating it moves keyboard focus into main content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.locator('a[href="#main-content"]').first();
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main-content$/);
    await page.keyboard.press('Tab');
    const inMain = await page.evaluate(() => !!document.activeElement?.closest('#main-content'));
    expect(inMain, 'the first focusable element after the skip link should be inside #main-content').toBe(true);
  });
});

async function tabThrough(page: Page, visit: () => Promise<void>) {
  await page.keyboard.press('Tab'); // skip link
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    await visit();
  }
}

test.describe('2.4.7 focus visible', () => {
  for (const route of ROUTES) {
    test(`${route}: every focused control looks different from its unfocused state`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const invisible: string[] = [];
      await tabThrough(page, async () => {
        const r = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;
          const sig = () => { const s = getComputedStyle(el); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.textDecorationLine, s.color].join('|'); };
          const focused = sig();
          el.blur();
          const plain = sig();
          el.focus({ preventScroll: true });
          const id = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
          return { id, same: focused === plain };
        });
        if (r?.same) invisible.push(r.id);
      });
      expect(invisible, `No visible focus indicator on:\n${invisible.join('\n')}`).toEqual([]);
    });
  }
});

test.describe('2.4.11 focus not obscured (minimum)', () => {
  for (const route of ROUTES) {
    test(`${route}: the centre of a focused control is not covered by unrelated content`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const covered: string[] = [];
      await tabThrough(page, async () => {
        const r = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const b = el.getBoundingClientRect();
          const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
          if (b.width === 0 || b.height === 0 || cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return null;
          const top = document.elementFromPoint(cx, cy);
          const ok = !top || el === top || el.contains(top) || top.contains(el);
          return ok ? null : `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} covered by ${top.tagName.toLowerCase()}${top.id ? '#' + top.id : ''}`;
        });
        if (r) covered.push(r);
      });
      expect(covered, covered.join('\n')).toEqual([]);
    });
  }
});

test.describe('1.4.10 reflow', () => {
  test.use({ viewport: { width: 320, height: 256 } });
  for (const route of ROUTES) {
    test(`${route}: no horizontal scrolling at 320 CSS px`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      expect(scrollWidth, `document is ${scrollWidth}px wide in a ${innerWidth}px viewport`).toBeLessThanOrEqual(innerWidth + 1);
    });
  }
});

test.describe('1.4.12 text spacing', () => {
  const SPACING = '*{line-height:1.5 !important;letter-spacing:.12em !important;word-spacing:.16em !important}p{margin-bottom:2em !important}';
  for (const route of ROUTES) {
    test(`${route}: no text is clipped after applying the WCAG text-spacing overrides`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      await page.addStyleTag({ content: SPACING });
      const clipped = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,a,button,label,summary,td,th'))) {
          const s = getComputedStyle(el);
          if (!el.textContent?.trim() || s.display === 'none' || s.visibility === 'hidden') continue;
          if (s.display.includes('-webkit-box') || s.webkitLineClamp !== 'none' && s.webkitLineClamp !== '') continue; // intentional line-clamp
          const clips = ['hidden', 'clip'].includes(s.overflowY) || ['hidden', 'clip'].includes(s.overflowX);
          if (clips && (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}: "${el.textContent.trim().slice(0, 40)}"`);
        }
        return out;
      });
      expect(clipped, `Clipped text:\n${clipped.join('\n')}`).toEqual([]);
    });
  }
});

test.describe('3.1.1 language of page', () => {
  for (const route of ROUTES) {
    test(`${route}: <html lang> is a valid BCP 47 tag`, async ({ page }) => {
      await page.goto(route);
      const lang = await page.evaluate(() => document.documentElement.getAttribute('lang') ?? '');
      expect(lang).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
    });
  }
});

test.describe('3.3.8 accessible authentication (minimum)', () => {
  test('/login: the password field does not cancel paste', async ({ page }) => {
    await page.goto('/login');
    const pw = page.locator('input[autocomplete="current-password"]');
    test.skip((await pw.count()) === 0, 'password field is not rendered in the default sign-in mode');
    const prevented = await pw.first().evaluate((el) => {
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });
});
