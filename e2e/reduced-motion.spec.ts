// e2e/reduced-motion.spec.ts
//
// Motion policy guard (docs/design/MOTION_POLICY.md). With reduced motion emulated, no decorative animation may be
// RUNNING on the 25 public routes (asserted through document.getAnimations()). Also covers the Accessibility Center
// path, Stop Animations, the WCAG 2.2.2 pause control, hidden-tab pausing, and axe on the changed section.
// Limits: framer-motion's JS-driven (non-WAAPI) tweens and third-party iframes are invisible to getAnimations().
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Animations that may keep running when motion is reduced: opacity-only, documented in motionPolicy.ts. */
const ALLOWED_ANIMATIONS = ['vk-essential-fade', 'vrk-soft'];

export const ROUTES = [
  '/', '/pricing', '/features', '/integrations', '/industries', '/compare', '/security', '/blog', '/contact', '/demo',
  '/about', '/faq', '/help', '/manifesto', '/leadership', '/academy', '/community', '/ambassador', '/login', '/signup',
  '/accessibility-statement', '/privacy', '/terms', '/open-voice-benchmark', '/responsible-ai',
] as const;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  // Scroll the whole page once so every whileInView / reveal-on-scroll animation starts, then return to top.
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 14; y += step, i++) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(450); // > the 120ms reduced-motion transition
}

async function runningOffenders(page: Page): Promise<string[]> {
  return page.evaluate((allowed: string[]) => {
    const out: string[] = [];
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running') continue;
      const eff = a.effect as KeyframeEffect | null;
      const t = eff?.target as Element | null;
      const first = t && typeof t.className === 'string' ? t.className.split(/\s+/)[0] : '';
      const label = t ? `${t.tagName.toLowerCase()}${first ? '.' + first : ''}` : 'unknown';
      if ('animationName' in a) {
        const name = (a as CSSAnimation).animationName;
        if (!allowed.includes(name)) out.push(`CSSAnimation ${name} on ${label}`);
        continue;
      }
      if ('transitionProperty' in a) {
        const prop = (a as CSSTransition).transitionProperty;
        if (!/^opacity$|(^|-)color$|^fill$|^stroke$/.test(prop)) out.push(`CSSTransition ${prop} on ${label}`);
        continue;
      }
      const props = new Set<string>();
      for (const kf of eff?.getKeyframes() ?? []) {
        for (const k of Object.keys(kf)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(k)) props.add(k);
      }
      if (![...props].every((p) => p === 'opacity' || /color/i.test(p))) out.push(`WAAPI [${[...props].join(',')}] on ${label}`);
    }
    return out;
  }, ALLOWED_ANIMATIONS);
}

test.describe('OS prefers-reduced-motion: reduce', () => {
  test.use({ reducedMotion: 'reduce' });
  for (const route of ROUTES) {
    test(`${route}: no running decorative animation`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
      await settle(page);
      expect(await runningOffenders(page)).toEqual([]);
    });
  }

  test('marquee strip is replaced by visible static text, no pause button needed', async ({ page }) => {
    await page.goto('/');
    const section = page.locator('#live-activity');
    await section.scrollIntoViewIfNeeded();
    await expect(section.locator('[data-motion-region="marquee"]')).toBeHidden();
    await expect(section.locator('[data-motion-summary]')).toBeVisible();
    await expect(section.getByRole('button', { name: /moving content/i })).toHaveCount(0);
  });

  test('live activity section has no axe violations', async ({ page }) => {
    await page.goto('/');
    await page.locator('#live-activity').scrollIntoViewIfNeeded();
    const r = await new AxeBuilder({ page }).include('#live-activity').withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(r.violations, JSON.stringify(r.violations, null, 2)).toEqual([]);
  });
});

test.describe('Accessibility Center path (OS says no-preference)', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('"Reduce Motion" setting gives the same result as the OS preference', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vireek-a11y-settings', JSON.stringify({ reduceMotion: true })));
    for (const route of ['/', '/pricing', '/features']) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
      await settle(page);
      expect(await runningOffenders(page), route).toEqual([]);
    }
  });

  test('"Stop Animations" leaves no running CSS animation at all', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vireek-a11y-settings', JSON.stringify({ stopAnimations: true })));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'stop');
    await settle(page);
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && 'animationName' in a).length);
    expect(running).toBe(0);
  });
});

test.describe('Moving content controls (WCAG 2.2.2) with full motion', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('Pause / Play button freezes and resumes the live activity marquee', async ({ page }) => {
    await page.goto('/');
    const section = page.locator('#live-activity');
    await section.scrollIntoViewIfNeeded();
    const track = section.locator('.animate-marquee');
    await expect(track).toHaveCSS('animation-play-state', 'running');
    await section.getByRole('button', { name: 'Pause moving content' }).click();
    await expect(track).toHaveCSS('animation-play-state', 'paused');
    await section.getByRole('button', { name: 'Play moving content' }).click();
    await expect(track).toHaveCSS('animation-play-state', 'running');
  });

  test('hidden tab freezes running animations', async ({ page }) => {
    await page.goto('/');
    await page.locator('#live-activity').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('html')).toHaveAttribute('data-tab-hidden', '');
    await expect(page.locator('#live-activity .animate-marquee')).toHaveCSS('animation-play-state', 'paused');
  });

  test('pause button has no axe violations and a >= 24px target', async ({ page }) => {
    await page.goto('/');
    const btn = page.locator('#live-activity').getByRole('button', { name: 'Pause moving content' });
    await btn.scrollIntoViewIfNeeded();
    const box = await btn.boundingBox();
    expect(box && box.height >= 24 && box.width >= 24).toBe(true);
    const r = await new AxeBuilder({ page }).include('#live-activity').withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(r.violations, JSON.stringify(r.violations, null, 2)).toEqual([]);
  });
});

const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
test.describe('Authenticated routes, reduced motion', () => {
  test.skip(!EMAIL || !PASSWORD, 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set — skipping authenticated routes.');
  test.use({ reducedMotion: 'reduce' });
  test('dashboard routes have no running decorative animation', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email address').fill(EMAIL!);
    await page.getByLabel('Password').fill(PASSWORD!);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/\/dashboard/);
    for (const route of ['/dashboard', '/dashboard/calls', '/dashboard/jobs']) {
      await page.goto(route);
      await settle(page);
      expect(await runningOffenders(page), route).toEqual([]);
    }
  });
});
