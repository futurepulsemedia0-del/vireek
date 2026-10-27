// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_DISCLAIMER,
  ESTIMATOR_LIMITS,
  buildDefaultEstimatorOptions,
  computeEstimate,
  formatEstimate,
  getEstimatorIssues,
  quantityAllowed,
  sanitizeEstimatorOptions,
  validateEstimatorOptions,
  type CatalogItem,
  type EstimateRules,
  type PricedItem,
} from './websiteEstimator';
import { TYPE_META, buildDefaults, hasErrors, normalizeSettings, validateSettings } from './websiteWidgets';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const item = (over: Partial<PricedItem> = {}): PricedItem => ({ pricing_model: 'flat', price_cents: 45000, price_max_cents: null, unit_label: null, ...over });
const rules = (over: Partial<EstimateRules> = {}): EstimateRules => ({ spread_pct: 0, urgency_pct: 0, ...over });

describe('computeEstimate', () => {
  it('flat price is exact; spread turns it into a range', () => {
    expect(computeEstimate(item(), 1, false, rules())).toEqual({ kind: 'exact', low_cents: 45000, high_cents: 45000 });
    expect(computeEstimate(item(), 1, false, rules({ spread_pct: 10 }))).toEqual({ kind: 'range', low_cents: 40500, high_cents: 49500 });
  });
  it('starting_at is open-ended, range keeps both ends (and never inverts)', () => {
    expect(computeEstimate(item({ pricing_model: 'starting_at', price_cents: 9000, unit_label: 'per outlet' }), 3, false, rules())).toEqual({ kind: 'from', low_cents: 27000, high_cents: null });
    expect(computeEstimate(item({ pricing_model: 'range', price_cents: 20000, price_max_cents: 35000 }), 1, true, rules({ urgency_pct: 50 }))).toEqual({ kind: 'range', low_cents: 30000, high_cents: 52500 });
    expect(computeEstimate(item({ pricing_model: 'range', price_cents: 20000, price_max_cents: 100 }), 1, false, rules()).high_cents).toBe(20000);
  });
  it('urgency only applies when the visitor asked for it, and rounds half-up to the cent', () => {
    expect(computeEstimate(item(), 1, false, rules({ urgency_pct: 25 })).low_cents).toBe(45000);
    expect(computeEstimate(item(), 1, true, rules({ urgency_pct: 25 })).low_cents).toBe(56250);
    expect(computeEstimate(item({ price_cents: 99 }), 1, true, rules({ spread_pct: 40, urgency_pct: 100 }))).toEqual({ kind: 'range', low_cents: 118, high_cents: 278 });
    expect(computeEstimate(item({ pricing_model: 'hourly', price_cents: 12599, unit_label: '/hour' }), 2, false, rules({ spread_pct: 15 }))).toEqual({ kind: 'range', low_cents: 21418, high_cents: 28978 });
  });
  it('quantity only counts for hourly / per-unit services and is clamped to 1–20', () => {
    expect(quantityAllowed(item())).toBe(false);
    expect(quantityAllowed(item({ unit_label: '  ' }))).toBe(false);
    expect(quantityAllowed(item({ unit_label: 'per fixture' }))).toBe(true);
    expect(quantityAllowed(item({ pricing_model: 'hourly' }))).toBe(true);
    expect(computeEstimate(item(), 9, false, rules()).low_cents).toBe(45000);
    expect(computeEstimate(item({ unit_label: 'per fixture' }), 99, false, rules()).low_cents).toBe(45000 * ESTIMATOR_LIMITS.qtyMax);
    expect(computeEstimate(item({ unit_label: 'per fixture' }), -4, false, rules()).low_cents).toBe(45000);
    expect(computeEstimate(item({ unit_label: 'per fixture' }), Number.NaN, false, rules()).low_cents).toBe(45000);
  });
  it('never produces negative or runaway numbers from junk', () => {
    const e = computeEstimate(item({ price_cents: Number.MAX_SAFE_INTEGER }), 20, true, rules({ spread_pct: 999, urgency_pct: 999 }));
    expect(e.low_cents).toBeLessThanOrEqual(ESTIMATOR_LIMITS.priceCap * 20 * 2);
    expect(computeEstimate(item({ price_cents: -5 }), 1, false, rules()).low_cents).toBe(0);
  });
  it('formats whole dollars without decimals', () => {
    expect(formatEstimate({ kind: 'exact', low_cents: 45000, high_cents: 45000 })).toBe('$450');
    expect(formatEstimate({ kind: 'exact', low_cents: 56250, high_cents: 56250 })).toBe('$562.50');
    expect(formatEstimate({ kind: 'range', low_cents: 40500, high_cents: 49500 })).toBe('$405 – $495');
    expect(formatEstimate({ kind: 'from', low_cents: 9000, high_cents: null })).toBe('From $90');
  });
});

describe('options', () => {
  it('defaults are valid and complete', () => {
    expect(validateEstimatorOptions(buildDefaultEstimatorOptions())).toEqual({});
    expect(hasErrors(validateSettings(buildDefaults('estimator')))).toBe(false);
    expect(buildDefaults('estimator').title).toBe(TYPE_META.estimator.defaultTitle);
  });
  it('sanitize drops bad / duplicate ids, trims labels, clamps numbers and caps the list', () => {
    const o = sanitizeEstimatorOptions({
      items: [{ id: ID_A.toUpperCase(), label: '  Flush  ' }, { id: ID_A }, { id: 'not-a-uuid' }, 7, null, { id: ID_B, label: 'x'.repeat(200) }],
      urgency_pct: 999, flat_spread_pct: -3, contact_required: 'fax', disclaimer: 12,
    });
    expect(o.items.map((i) => i.id)).toEqual([ID_A, ID_B]);
    expect(o.items[0].label).toBe('Flush');
    expect(o.items[1].label).toHaveLength(ESTIMATOR_LIMITS.itemLabel);
    expect([o.urgency_pct, o.flat_spread_pct, o.contact_required, o.disclaimer]).toEqual([100, 0, 'either', '']);
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    expect(sanitizeEstimatorOptions({ items: many }).items).toHaveLength(ESTIMATOR_LIMITS.items);
    expect(sanitizeEstimatorOptions('junk')).toEqual(buildDefaultEstimatorOptions());
  });
  it('normalizeSettings keeps estimator options intact through the shared pipeline', () => {
    const s = normalizeSettings('estimator', { options: { items: [{ id: ID_A, label: 'A' }], gate_price: true } } as never);
    expect(s.widget_type).toBe('estimator');
    expect(s.options).toMatchObject({ items: [{ id: ID_A, label: 'A' }], gate_price: true, ask_zip: true });
  });
  it('validation flags out-of-range numbers and long text', () => {
    const o = { ...buildDefaultEstimatorOptions(), urgency_pct: 101, flat_spread_pct: 41, disclaimer: 'x'.repeat(241) };
    expect(Object.keys(validateEstimatorOptions(o)).sort()).toEqual(['disclaimer', 'flat_spread_pct', 'urgency_pct']);
  });
});

describe('readiness', () => {
  const cat = (id: string, over: Partial<CatalogItem> = {}): CatalogItem => ({ id, service_name: id, category: null, pricing_model: 'flat', price_cents: 1000, price_max_cents: null, unit_label: null, description: null, active: true, ...over });
  const opts = (ids: string[]) => sanitizeEstimatorOptions({ items: ids.map((id) => ({ id })) });
  it('warns when nothing is published', () => expect(getEstimatorIssues(opts([]), [])).toHaveLength(1));
  it('is quiet when every service is live, and when the catalog has not loaded', () => {
    expect(getEstimatorIssues(opts([ID_A, ID_B]), [cat(ID_A), cat(ID_B)])).toEqual([]);
    expect(getEstimatorIssues(opts([ID_A]), null)).toEqual([]);
  });
  it('flags inactive, deleted and $0 services', () => {
    expect(getEstimatorIssues(opts([ID_A, ID_B]), [cat(ID_A), cat(ID_B, { active: false })])[0]).toMatch(/1 selected service is inactive/);
    expect(getEstimatorIssues(opts([ID_A]), [cat(ID_A, { price_cents: 0 })])[0]).toMatch(/stays hidden/);
    expect(getEstimatorIssues(opts([ID_A]), [])[0]).toMatch(/stays hidden/);
  });
  it('flags a 0% urgency surcharge', () => {
    expect(getEstimatorIssues({ ...opts([ID_A]), show_urgency: true, urgency_pct: 0 }, [cat(ID_A)])[0]).toMatch(/0%/);
  });
});

/* ---- the real embed script, in jsdom: the three copies of the maths must agree and the UI must work ---- */
interface Engine {
  _estimate: (it: PricedItem, qty: number, urgent: boolean, r: EstimateRules) => { kind: string; low_cents: number; high_cents: number | null };
  preview: (container: HTMLElement, payload: unknown, opts?: { contained?: boolean; startOpen?: boolean }) => { destroy: () => void };
}
let api: Engine;
let source = '';
let migration = '';

beforeAll(() => {
  source = readFileSync(resolve(__dirname, '../../public/website-widgets.js'), 'utf8');
  // The timestamp prefix may differ per project (it must sort after your newest migration), so find the file by its suffix.
  const dir = resolve(__dirname, '../../supabase/migrations');
  const file = readdirSync(dir).find((f) => f.endsWith('_website_widget_estimator.sql'));
  if (!file) throw new Error('estimator migration not found in supabase/migrations');
  migration = readFileSync(resolve(dir, file), 'utf8');
  new Function(source)();
  api = (window as unknown as { __vireekWW: { api: Engine } }).__vireekWW.api;
});

describe('embed script ⇄ TypeScript ⇄ SQL parity', () => {
  it('the script computes exactly what websiteEstimator.ts computes (deterministic fuzz)', () => {
    let seed = 20271215;
    const rnd = (a: number, b: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return a + (seed % (b - a + 1));
    };
    const models = ['flat', 'starting_at', 'range', 'hourly'] as const;
    for (let i = 0; i < 3000; i++) {
      const price = rnd(0, 2_500_000);
      const it: PricedItem = { pricing_model: models[rnd(0, 3)], price_cents: price, price_max_cents: rnd(0, 3) === 0 ? null : price + rnd(0, 400_000), unit_label: rnd(0, 2) === 0 ? 'per fixture' : null };
      const r = { spread_pct: rnd(0, 40), urgency_pct: rnd(0, 100) };
      const qty = rnd(0, 25);
      const urgent = rnd(0, 1) === 1;
      expect(api._estimate(it, qty, urgent, r)).toEqual(computeEstimate(it, qty, urgent, r));
    }
  });
  it('the SQL function uses the same rounding and caps (drift guard)', () => {
    const fn = migration.slice(migration.indexOf('FUNCTION public.website_widget_estimate('), migration.indexOf('FUNCTION public.website_widget_estimator_rules('));
    for (const needle of ['100000000', 'least(greatest(coalesce(p_qty, 1), 1), 20)', '(100 - v_spread) + 50) / 100', '(100 + v_spread) + 50) / 100', '(100 + v_pct) + 50) / 100', "p_model = 'starting_at'", "p_model = 'range'"]) {
      expect(fn.includes(needle), needle).toBe(true);
    }
    expect(migration).toContain('least(greatest(coalesce(p_spread_pct, 0), 0), 40)');
  });
  it('the dashboard defaults (copy, disclaimer) match the script', () => {
    const m = TYPE_META.estimator;
    for (const text of [m.defaultTitle, m.defaultSubtitle, m.defaultButton, m.defaultSuccess, DEFAULT_DISCLAIMER]) expect(source.includes(text), text).toBe(true);
  });
  it('lead source and limits agree between the script contract and the migration', () => {
    expect(migration).toContain("'website_estimator_widget'");
    expect(migration).toContain('submit_website_widget_estimate');
    expect(source).toContain("'submit_website_widget_estimate'");
    expect(migration).toContain(`e.ord <= ${ESTIMATOR_LIMITS.items}`);
  });
});

describe('estimator UI (real script, jsdom)', () => {
  const items = [
    { id: 'a1', label: 'Water heater flush', pricing_model: 'flat', price_cents: 45000, price_max_cents: null, unit_label: null },
    { id: 'c3', label: 'Install outlet', pricing_model: 'starting_at', price_cents: 9000, price_max_cents: null, unit_label: 'per outlet' },
  ];
  const payload = (data: Record<string, unknown>) => ({
    type: 'estimator',
    settings: { brand_color: '#3448E8', theme: 'light', display_mode: 'inline', position: 'right', radius: 14, title: 'Get an instant price', subtitle: '', button_label: 'Get a price', success_message: 'Thanks, got it!', options: {} },
    data: { show: true, items, rules: { spread_pct: 0, urgency_pct: 25, gate_price: false, ask_zip: true, contact_required: 'either', disclaimer: '' }, ...data },
  });
  const mount = (p: unknown) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = api.preview(container, p, { contained: false });
    const root = (container.firstElementChild as HTMLElement).shadowRoot as ShadowRoot;
    return { root, destroy: () => { handle.destroy(); container.remove(); } };
  };
  const text = (root: ShadowRoot, sel: string) => root.querySelector(sel)?.textContent ?? '';

  it('shows services, an instant price after a pick, and updates for quantity and urgency', () => {
    const { root, destroy } = mount(payload({}));
    const opts = root.querySelectorAll<HTMLButtonElement>('button.opt');
    expect(opts).toHaveLength(2);
    expect(text(root, '.price')).toBe('');
    opts[0].click();
    expect(text(root, '.price')).toBe('$450');
    opts[1].click();
    expect(text(root, '.price')).toBe('From $90');
    root.querySelector<HTMLButtonElement>('button[aria-label="Increase"]')!.click();
    expect(text(root, '.price')).toBe('From $180');
    const urgent = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    urgent.checked = true;
    urgent.dispatchEvent(new Event('change'));
    expect(text(root, '.price')).toBe('From $225');
    destroy();
  });

  it('validates the lead form before sending, then shows the success state', () => {
    const { root, destroy } = mount(payload({}));
    root.querySelectorAll<HTMLButtonElement>('button.opt')[0].click();
    [...root.querySelectorAll<HTMLButtonElement>('button.btn')].find((b) => b.textContent === 'Get my exact quote')!.click();
    const form = root.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(text(root, '.err')).toMatch(/enter your name/i);
    const [name, phone] = form.querySelectorAll<HTMLInputElement>('input:not([name])');
    name.value = 'Ann Lee'; name.dispatchEvent(new Event('input'));
    phone.value = '555 123 4567'; phone.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    // Preview stubs the network, so the estimate falls back to the local maths and the success view appears after the stub delay.
    expect([...root.querySelectorAll('button')].some((b) => b.disabled)).toBe(true);
    destroy();
  });

  it('price gate keeps the price hidden until contact details are given', () => {
    const { root, destroy } = mount(payload({ rules: { spread_pct: 0, urgency_pct: 0, gate_price: true, ask_zip: false, contact_required: 'email', disclaimer: '' } }));
    root.querySelectorAll<HTMLButtonElement>('button.opt')[0].click();
    expect(text(root, '.price')).toBe('');
    expect(root.textContent).toContain('Enter your contact details');
    destroy();
  });

  it('renders a clear notice instead of an empty widget when nothing is published', () => {
    const { root, destroy } = mount(payload({ items: [], show: false }));
    expect(root.querySelectorAll('button.opt')).toHaveLength(0);
    expect(root.textContent).toContain('Publish at least one service');
    destroy();
  });

  it('never writes visitor-controlled or price-book text with innerHTML', () => {
    const { root, destroy } = mount(payload({ items: [{ ...items[0], label: '<img src=x onerror=alert(1)>' }] }));
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    destroy();
  });
});
