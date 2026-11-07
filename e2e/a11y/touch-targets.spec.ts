// e2e/a11y/touch-targets.spec.ts
//
// Phase 0 (runtime audit) + Phase 3 (guard). 375px mobile viewport, 25 dashboard routes, Supabase mocked (no real network).
//   FAIL  : an interactive element whose effective hit area is < 24x24 CSS px and that does not meet the WCAG 2.5.8 spacing exception
//   REVIEW: effective hit area < 44 px (reported + attached, never fails)
// "Effective" = the element box, or its ::after box when the element uses `.hit-area`.
// Intentionally small targets go in e2e/a11y/touch-target-allowlist.json with a written reason.
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { PROFILE, mockSupabase, signIn } from '../helpers/mockSupabase';

const ROUTES = [
  '/dashboard', '/dashboard/today', '/dashboard/calendar', '/dashboard/jobs', '/dashboard/leads', '/dashboard/customers', '/dashboard/quotes',
  '/dashboard/calls', '/dashboard/inbox', '/dashboard/tasks', '/dashboard/voicemails', '/dashboard/marketing', '/dashboard/leaderboard',
  '/dashboard/goals', '/dashboard/reputation', '/dashboard/listings', '/dashboard/win-cards', '/dashboard/live-calls', '/dashboard/csr-desk',
  '/dashboard/getting-started', '/dashboard/support', '/dashboard/settings', '/dashboard/billing', '/dashboard/analytics', '/dashboard/team',
];
const ALLOW: { route?: string; selector: string; reason: string }[] = existsSync('e2e/a11y/touch-target-allowlist.json')
  ? JSON.parse(readFileSync('e2e/a11y/touch-target-allowlist.json', 'utf8'))
  : [];

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

interface Hit { sel: string; name: string; w: number; h: number; x: number; y: number; kind: 'fail' | 'review'; iconOnlyNoName: boolean }

async function measure(page: Page): Promise<Hit[]> {
  return page.evaluate(() => {
    const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=switch],[role=checkbox],[role=radio],[tabindex]:not([tabindex="-1"])';
    const visible = (el: Element) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"],[inert]'); };
    const box = (el: Element) => {
      let t: Element = el;
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) t = el.closest('label') ?? el; // visually hidden inputs: the label is the target
      const r = t.getBoundingClientRect();
      let w = r.width, h = r.height;
      const a = getComputedStyle(t, '::after');
      if (t.classList.contains('hit-area') && a.content !== 'none') { w = Math.max(w, parseFloat(a.width) || 0); h = Math.max(h, parseFloat(a.height) || 0); }
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w, h, r };
    };
    const inline = (el: Element) => el.tagName === 'A' && getComputedStyle(el).display === 'inline' && !!el.parentElement?.textContent && (el.parentElement.textContent.length > (el.textContent?.length ?? 0) + 8); // WCAG inline exception
    const els = Array.from(document.querySelectorAll(SEL)).filter(visible);
    const items = els.map((el) => ({ el, ...box(el) }));
    const path = (el: Element) => { const id = el.id ? `#${el.id}` : ''; const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''; return `${el.tagName.toLowerCase()}${id}${c ? '.' + c : ''}`; };
    const out: Hit[] = [];
    for (const it of items) {
      if (inline(it.el)) continue;
      const under24 = it.w < 24 - 0.5 || it.h < 24 - 0.5;
      const under44 = it.w < 44 - 0.5 || it.h < 44 - 0.5;
      if (!under44) continue;
      let kind: 'fail' | 'review' = under24 ? 'fail' : 'review';
      if (under24) { // spacing exception: a 24px circle centred on the target must not touch another target (or its circle if also undersized)
        const clash = items.some((o) => o !== it && !it.el.contains(o.el) && !o.el.contains(it.el) && (((o.w < 24 || o.h < 24) && Math.hypot(o.cx - it.cx, o.cy - it.cy) < 24) || (Math.abs(o.cx - it.cx) < 12 + o.w / 2 && Math.abs(o.cy - it.cy) < 12 + o.h / 2)));
        if (!clash) kind = 'review';
      }
      const text = (it.el.textContent ?? '').trim();
      const name = it.el.getAttribute('aria-label') ?? it.el.getAttribute('aria-labelledby') ?? it.el.getAttribute('title') ?? text;
      out.push({ sel: path(it.el), name: name || '', w: Math.round(it.w), h: Math.round(it.h), x: Math.round(it.r.left), y: Math.round(it.r.top), kind, iconOnlyNoName: !name && !!it.el.querySelector('svg') });
    }
    return out;
  });
}

async function overlay(page: Page, hits: Hit[]) {
  await page.evaluate((hs) => {
    for (const h of hs) { const d = document.createElement('div'); d.setAttribute('data-audit-overlay', ''); d.style.cssText = `position:absolute;left:${h.x + scrollX}px;top:${h.y + scrollY}px;width:${h.w}px;height:${h.h}px;outline:2px solid ${h.kind === 'fail' ? 'red' : 'orange'};pointer-events:none;z-index:99999`; document.body.appendChild(d); }
  }, hits);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await mockSupabase(page, { tables: { profiles: [PROFILE], team_members: [], calls: [], jobs: [], business_profile: [], live_calls: [] } });
});

for (const route of ROUTES) {
  test(`375px touch targets: ${route}`, async ({ page }, info) => {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const hits = (await measure(page)).filter((h) => !ALLOW.some((a) => (!a.route || a.route === route) && h.sel.includes(a.selector)));
    const fails = hits.filter((h) => h.kind === 'fail');
    const review = hits.filter((h) => h.kind === 'review');
    const nameless = hits.filter((h) => h.iconOnlyNoName);
    const dir = 'test-results/touch-targets'; mkdirSync(dir, { recursive: true });
    const slug = route.replace(/\W+/g, '_');
    writeFileSync(`${dir}/${slug}.json`, JSON.stringify({ route, fails, review, nameless }, null, 2));
    await overlay(page, hits);
    await page.screenshot({ path: `${dir}/${slug}.png`, fullPage: true });
    await info.attach('touch-targets.json', { body: JSON.stringify({ fails, review: review.length, nameless }, null, 2), contentType: 'application/json' });
    expect(fails, `Targets under 24x24 CSS px on ${route}:\n${JSON.stringify(fails, null, 2)}`).toEqual([]);
    expect(nameless, `Icon-only controls without an accessible name on ${route}`).toEqual([]);
  });

  test(`axe target-size / button-name / link-name: ${route}`, async ({ page }) => {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const r = await new AxeBuilder({ page }).withRules(['target-size', 'button-name', 'link-name']).analyze();
    expect(r.violations, JSON.stringify(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), null, 2)).toEqual([]);
  });
}
