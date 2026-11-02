/** DOM helpers: page map (headings/links), jumping, readable text, accessible-name lookup. */
const UI = '#a11y-portal,[data-a11y-ui]';
export const isInsideA11yUi = (el: Element): boolean => el.closest(UI) !== null;
const isVisible = (el: Element): boolean => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

export function accessibleName(el: Element): string {
  const h = el as HTMLElement;
  return clean(el.getAttribute('aria-label')) || clean(h.innerText || el.textContent) || clean(el.getAttribute('title')) || clean((el as HTMLInputElement).value);
}

export interface PageItem { id: number; level: number; text: string; el: HTMLElement }

export function collectHeadings(doc: Document = document): PageItem[] {
  const out: PageItem[] = [];
  doc.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,[role="heading"]').forEach((el) => {
    if (isInsideA11yUi(el) || !isVisible(el)) return;
    const text = accessibleName(el);
    if (!text) return;
    const level = el.tagName.length === 2 && el.tagName.startsWith('H') ? Number(el.tagName[1]) : Number(el.getAttribute('aria-level')) || 2;
    out.push({ id: out.length, level, text: text.slice(0, 160), el });
  });
  return out;
}

export function collectLinks(doc: Document = document): PageItem[] {
  const out: PageItem[] = [];
  doc.querySelectorAll<HTMLElement>('a[href],[role="link"]').forEach((el) => {
    if (isInsideA11yUi(el) || !isVisible(el)) return;
    const text = accessibleName(el);
    if (!text) return;
    out.push({ id: out.length, level: 0, text: text.slice(0, 160), el });
  });
  return out;
}

export function jumpTo(el: HTMLElement): void {
  if (!el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) el.setAttribute('tabindex', '-1');
  const reduce = document.documentElement.classList.contains('a11y-reduce-motion') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
}

/** Next/previous visible heading relative to the viewport middle. */
export function jumpToAdjacentHeading(dir: 'next' | 'prev'): string | null {
  const heads = collectHeadings();
  if (heads.length === 0) return null;
  const mid = window.innerHeight / 2;
  const target =
    dir === 'next'
      ? heads.find((h) => h.el.getBoundingClientRect().top > mid + 8)
      : [...heads].reverse().find((h) => h.el.getBoundingClientRect().top < mid - 8);
  if (!target) return null;
  jumpTo(target.el);
  return target.text;
}

/** Selection if any, otherwise the main landmark (never the accessibility UI). */
export function getReadableText(): string {
  const sel = window.getSelection()?.toString().trim();
  if (sel) return sel.slice(0, 30000);
  const main = document.querySelector<HTMLElement>('main,[role="main"]') ?? document.body;
  return clean(main.innerText).slice(0, 30000);
}

const DESTRUCTIVE = /delete|remove|pay\b|payment|purchase|buy\b|checkout|unsubscribe|sign out|log ?out|cancel (plan|subscription)|حذف|پرداخت|خرید|خروج|لغو اشتراک|حذف|دفع|شراء|الغاء الاشتراك|تسجيل الخروج|مسح/i;

export interface ClickMatch { el: HTMLElement; name: string; blocked: boolean }
export function findClickable(label: string, norm: (s: string) => string): ClickMatch | null {
  const q = norm(label);
  if (!q) return null;
  const cands: { el: HTMLElement; name: string; n: string }[] = [];
  document.querySelectorAll<HTMLElement>('a[href],button,[role="button"],[role="link"],summary,input[type="submit"],input[type="button"]').forEach((el) => {
    if (isInsideA11yUi(el) || !isVisible(el) || (el as HTMLButtonElement).disabled) return;
    const name = accessibleName(el);
    if (name) cands.push({ el, name, n: norm(name) });
  });
  const hit = cands.find((c) => c.n === q) ?? cands.find((c) => c.n.startsWith(q)) ?? cands.find((c) => c.n.includes(q));
  if (!hit) return null;
  const blocked = DESTRUCTIVE.test(hit.name) || hit.el.hasAttribute('data-destructive') || (hit.el as HTMLButtonElement).type === 'submit';
  return { el: hit.el, name: hit.name, blocked };
}
