// crawl/probes.mjs — DOM probes executed inside the page. `pageProbe` is serialized by Playwright, so it must
// stay self-contained (no closures over module scope). Pure helpers below mirror its rules for unit tests.

/** A rendered string that looks like an i18n key, e.g. `format.showMore` or `dashboard:nav.items.jobs`. */
export const RAW_KEY_SOURCE = '^(?:[a-z][A-Za-z0-9]*:)?[a-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9_]+){1,5}$';
/** Things that look like keys but are not: domains, files, versions, numbers. */
export const NOT_KEY_SOURCE = '\\.(?:com|ai|io|net|org|co|dev|app|us|js|ts|css|json|png|jpg|svg|pdf|csv|html|md|xml)$|^v?\\d|^www\\.|@';
export const LEAK_SOURCE = '(?:^|\\s)(?:undefined|NaN|null|\\[object Object\\])(?:\\s|$)|\\{\\{[^}]*\\}\\}|\\$\\{[^}]*\\}';

export const isRawKey = (s) => {
  const t = String(s).trim();
  return t.length < 80 && new RegExp(RAW_KEY_SOURCE).test(t) && !new RegExp(NOT_KEY_SOURCE, 'i').test(t);
};
export const hasLeak = (s) => new RegExp(LEAK_SOURCE).test(String(s));
export const firstFamily = (ff) => String(ff).split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();

/* eslint-disable */
export function pageProbe(opts) {
  const { allowedFonts, rawKeySrc, notKeySrc, leakSrc, maxEls } = opts;
  const rawKeyRe = new RegExp(rawKeySrc);
  const notKeyRe = new RegExp(notKeySrc, 'i');
  const leakRe = new RegExp(leakSrc);
  const q = (s) => document.querySelector(s);
  const attr = (s, a) => q(s)?.getAttribute(a) ?? null;
  const meta = {
    title: document.title || '',
    description: attr('meta[name="description"]', 'content'),
    canonical: attr('link[rel="canonical"]', 'href'),
    robots: attr('meta[name="robots"]', 'content'),
    ogTitle: attr('meta[property="og:title"]', 'content'),
    ogDescription: attr('meta[property="og:description"]', 'content'),
    ogImage: attr('meta[property="og:image"]', 'content'),
    ogUrl: attr('meta[property="og:url"]', 'content'),
    twitterCard: attr('meta[name="twitter:card"]', 'content'),
    h1Count: document.querySelectorAll('h1').length,
    lang: document.documentElement.getAttribute('lang'),
    dir: document.documentElement.getAttribute('dir') || getComputedStyle(document.documentElement).direction,
    viewport: attr('meta[name="viewport"]', 'content'),
    jsonLdInvalid: [...document.querySelectorAll('script[type="application/ld+json"]')].filter((s) => { try { JSON.parse(s.textContent || ''); return false; } catch { return true; } }).length,
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };
  const els = [...document.querySelectorAll('body *')].slice(0, maxEls);
  // layout
  const interactiveSel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[tabindex]:not([tabindex="-1"])';
  let interactive = 0; const smallSamples = []; let small = 0;
  for (const el of document.querySelectorAll(interactiveSel)) {
    if (!visible(el)) continue;
    interactive++;
    const r = el.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24) continue;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.closest('p,li,span,td,dd')) continue; // WCAG 2.5.8 inline exception
    small++;
    if (smallSamples.length < 5) smallSamples.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} ${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}`);
  }
  const de = document.documentElement;
  const layout = { scrollW: de.scrollWidth, innerW: window.innerWidth, overflow: de.scrollWidth > window.innerWidth + 1, interactive, smallTargets: small, smallSamples };
  // text: raw keys, leaks, fonts
  const rawKeys = []; const leaks = []; const fonts = {}; let textEls = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.nodeValue || '').trim();
    const p = n.parentElement;
    if (!t || !p || /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|KBD|SAMP)$/.test(p.tagName) || p.closest('code,pre,kbd,samp')) continue;
    if (!visible(p)) continue;
    textEls++;
    const fam = getComputedStyle(p).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
    fonts[fam] = (fonts[fam] || 0) + 1;
    if (seen.has(t)) continue; seen.add(t);
    if (t.length < 80 && rawKeyRe.test(t) && !notKeyRe.test(t)) rawKeys.push(t);
    else if (leakRe.test(t)) leaks.push(t.slice(0, 80));
  }
  for (const el of document.querySelectorAll('[placeholder],[aria-label],[title],img[alt]')) {
    for (const a of ['placeholder', 'aria-label', 'title', 'alt']) {
      const v = (el.getAttribute(a) || '').trim();
      if (v && v.length < 80 && rawKeyRe.test(v) && !notKeyRe.test(v)) rawKeys.push(`[${a}] ${v}`);
    }
  }
  const offBrand = Object.entries(fonts).filter(([f]) => !allowedFonts.includes(f));
  const fontInfo = { total: textEls, offBrandCount: offBrand.reduce((a, [, c]) => a + c, 0), top: Object.entries(fonts).sort((a, b) => b[1] - a[1]).slice(0, 4), offBrand: offBrand.slice(0, 5).map(([f, c]) => `${f} ×${c}`) };
  // states
  const states = {
    busy: document.querySelectorAll('[aria-busy="true"]').length,
    skeletons: document.querySelectorAll('[class*="skeleton" i],[class*="animate-pulse"]').length,
    alerts: [...document.querySelectorAll('[role="alert"]')].filter(visible).map((e) => (e.textContent || '').trim().slice(0, 100)).slice(0, 3),
    boundary: /Something went wrong/i.test((q('h1')?.textContent || '')),
    bodyTextLength: (document.body.innerText || '').trim().length,
  };
  const links = [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')))].slice(0, 400);
  const vrk = window.__vrk || {};
  const nav = performance.getEntriesByType('navigation')[0];
  const jsBytes = performance.getEntriesByType('resource').filter((r) => /\.js(\?|$)/.test(r.name)).reduce((a, r) => a + (r.transferSize || 0), 0);
  const perf = { lcp: vrk.lcp ?? null, cls: vrk.cls ?? null, longTaskMs: vrk.longTask ?? 0, fcp: vrk.fcp ?? null, ttfb: nav ? Math.round(nav.responseStart) : null, jsKb: Math.round(jsBytes / 1024) };
  const rendered = { htmlDark: document.documentElement.classList.contains('dark'), bodyBg: getComputedStyle(document.body).backgroundColor };
  return { meta, rendered, layout, i18n: { rawKeys: rawKeys.slice(0, 10), leaks: leaks.slice(0, 10) }, fonts: fontInfo, states, links, perf };
}

/** Installed before any page script runs to record Core Web Vitals-style metrics. */
export const perfInit = () => {
  window.__vrk = { cls: 0, longTask: 0 };
  try {
    new PerformanceObserver((l) => { const e = l.getEntries(); const last = e[e.length - 1]; if (last) window.__vrk.lcp = Math.round(last.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__vrk.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__vrk.longTask += Math.max(0, e.duration - 50); }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__vrk.fcp = Math.round(e.startTime); }).observe({ type: 'paint', buffered: true });
  } catch { /* unsupported entry type */ }
};

/** After pressing Tab once: is something focused and does it have a visible indicator? */
export const focusProbe = () => {
  const a = document.activeElement;
  if (!a || a === document.body) return { focused: false, visible: false, tag: null };
  const cs = getComputedStyle(a);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const shadow = cs.boxShadow && cs.boxShadow !== 'none';
  const ring = outline || shadow || cs.borderColor !== cs.getPropertyValue('border-color');
  return { focused: true, visible: Boolean(outline || shadow), tag: a.tagName.toLowerCase(), ring: Boolean(ring) };
};
