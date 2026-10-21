import { describe, expect, it } from 'vitest';
import {
  autoMapColumns,
  buildImportItems,
  chunkItems,
  deliveryState,
  formatEta,
  groupCartByVendor,
  holdMessage,
  jobPartsHeadline,
  mergeImportResults,
  normalizeStockStatus,
  parsePriceCell,
  priceDelta,
  roundOrderQty,
  safeTrackingUrl,
  type CartLine,
  type ImportResult,
  type JobPartOrder,
} from './partsOrdering';

const NOW = new Date(2026, 9, 21); // 21 Oct 2026, local

const order = (over: Partial<JobPartOrder> = {}): JobPartOrder => ({
  job_id: 'j1', purchase_order_id: 'po1', po_number: 'PO-1', po_status: 'sent', shipment_status: 'in_transit',
  expected_at: '2026-10-25', original_expected_at: '2026-10-25', carrier: null, tracking_number: null, tracking_url: null,
  vendor_name: 'Acme', po_line_id: 'l1', part_id: 'p1', part_name: 'Capacitor', part_number: 'C1',
  job_quantity: 2, quantity_ordered: 2, quantity_received: 0, unit_cost_cents: 1000, ...over,
});

describe('parsePriceCell', () => {
  it('accepts plain, currency-prefixed and thousands-separated amounts', () => {
    expect(parsePriceCell('12.5')).toBe('12.5');
    expect(parsePriceCell(' $1,234.50 ')).toBe('1234.50');
    expect(parsePriceCell('7 USD')).toBe('7');
  });
  it('rejects negatives, text, empty and European formats instead of guessing', () => {
    for (const bad of ['-3', 'abc', '', '1.234,50', '12.5.1', null, undefined]) expect(parsePriceCell(bad as string)).toBeNull();
  });
});

describe('roundOrderQty', () => {
  it('honours minimum order quantity and pack size like the database', () => {
    expect(roundOrderQty(3, 1, 2)).toBe(4);
    expect(roundOrderQty(1, 10, 1)).toBe(10);
    expect(roundOrderQty(11, 10, 5)).toBe(15);
    expect(roundOrderQty(0, 1, 1)).toBe(1);
    expect(roundOrderQty(999999, 1, 1)).toBe(100000);
  });
});

describe('priceDelta', () => {
  it('reports direction and percent, and nothing without history', () => {
    expect(priceDelta(1100, 1000)).toEqual({ direction: 'up', percent: 10 });
    expect(priceDelta(900, 1000)).toEqual({ direction: 'down', percent: 10 });
    expect(priceDelta(900, null)).toBeNull();
  });
});

describe('autoMapColumns', () => {
  it('maps common supplier headers without reusing a column', () => {
    const m = autoMapColumns(['Item Number', 'Description', 'Your Price', 'MSRP', 'Brand', 'UOM', 'Lead Time (days)', 'Availability', 'Pack Size', 'MOQ']);
    expect(m).toMatchObject({ sku: 0, name: 1, unit_cost: 2, list_price: 3, brand: 4, uom: 5, lead_time_days: 6, stock_status: 7, pack_size: 8, min_order_qty: 9 });
    expect(new Set(Object.values(m)).size).toBe(Object.values(m).length);
  });
  it('leaves unknown columns unmapped', () => {
    expect(autoMapColumns(['foo', 'bar'])).toEqual({});
  });
});

describe('normalizeStockStatus', () => {
  it('understands supplier wording', () => {
    expect(normalizeStockStatus('In Stock')).toBe('in_stock');
    expect(normalizeStockStatus('out-of-stock')).toBe('backorder');
    expect(normalizeStockStatus('Limited')).toBe('low_stock');
    expect(normalizeStockStatus('EOL')).toBe('discontinued');
    expect(normalizeStockStatus('???')).toBeUndefined();
  });
});

describe('buildImportItems', () => {
  const mapping = { sku: 0, name: 1, unit_cost: 2, stock_status: 3, pack_size: 4 };
  it('builds API items and reports bad rows with 1-based row numbers', () => {
    const { items, issues } = buildImportItems([
      ['A1', 'Cap', '$12.50', 'in stock', '2'],
      ['', 'No sku', '1', '', ''],
      ['B2', 'Bad price', 'abc', '', ''],
      ['', '', '', '', ''],
      ['C3', 'Ok', '3', 'weird', 'x'],
    ], mapping);
    expect(items).toEqual([
      { sku: 'A1', name: 'Cap', unit_cost: '12.50', stock_status: 'in_stock', pack_size: '2' },
      { sku: 'C3', name: 'Ok', unit_cost: '3' },
    ]);
    expect(issues).toEqual([{ row: 2, message: 'Missing SKU' }, { row: 3, message: 'Invalid price "abc"' }]);
  });
  it('price-only mode ignores descriptive columns', () => {
    const { items } = buildImportItems([['A1', 'Cap', '5', 'in stock', '4']], mapping, { priceOnly: true });
    expect(items).toEqual([{ sku: 'A1', name: 'Cap', unit_cost: '5' }]);
  });
});

describe('chunking and merging', () => {
  it('splits into API-sized batches', () => {
    expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('merges batch results and keeps error row numbers global', () => {
    const r = (over: Partial<ImportResult>): ImportResult => ({ import_id: 'i', status: 'completed', dry_run: false, total: 2, inserted: 1, updated: 0, unchanged: 0, errors: 0, price_up: 0, price_down: 0, error_rows: [], ...over });
    const merged = mergeImportResults([r({}), r({ errors: 1, inserted: 0, error_rows: [{ row: 2, sku: 'X', message: 'bad' }] })]);
    expect(merged.total).toBe(4);
    expect(merged.errors).toBe(1);
    expect(merged.status).toBe('completed_with_errors');
    expect(merged.error_rows[0].row).toBe(4);
  });
});

describe('deliveryState', () => {
  it('prompts approval for drafts and pending approvals', () => {
    expect(deliveryState(order({ po_status: 'draft', shipment_status: 'not_shipped' }), NOW).action).toBe('approve_send');
    expect(deliveryState(order({ po_status: 'pending_approval' }), NOW).label).toBe('Needs approval');
  });
  it('flags late orders with the number of days', () => {
    const s = deliveryState(order({ expected_at: '2026-10-18' }), NOW);
    expect(s).toMatchObject({ tone: 'danger', isLate: true, daysLate: 3, label: 'Late · 3 days' });
  });
  it('asks the team to receive carrier-delivered parts', () => {
    expect(deliveryState(order({ shipment_status: 'delivered' }), NOW)).toMatchObject({ action: 'receive', label: 'Delivered — receive it' });
  });
  it('is done once fully received or cancelled', () => {
    expect(deliveryState(order({ quantity_received: 2 }), NOW).label).toBe('Received');
    expect(deliveryState(order({ po_status: 'cancelled' }), NOW).label).toBe('Cancelled');
  });
  it('reports a problem shipment even when not late', () => {
    expect(deliveryState(order({ shipment_status: 'exception' }), NOW)).toMatchObject({ tone: 'danger', isLate: false });
  });
});

describe('formatEta', () => {
  it('speaks in relative days', () => {
    expect(formatEta(null, NOW)).toBe('No ETA');
    expect(formatEta('2026-10-21', NOW)).toMatch(/^Today/);
    expect(formatEta('2026-10-22', NOW)).toMatch(/^Tomorrow/);
    expect(formatEta('2026-10-19', NOW)).toMatch(/2 days late$/);
  });
});

describe('safeTrackingUrl', () => {
  it('only allows http(s)', () => {
    expect(safeTrackingUrl('https://ups.com/t/1')).toBe('https://ups.com/t/1');
    expect(safeTrackingUrl('javascript:alert(1)')).toBeNull();
    expect(safeTrackingUrl('not a url')).toBeNull();
    expect(safeTrackingUrl(null)).toBeNull();
  });
});

describe('cart + job summaries', () => {
  const line = (id: string, vendor: string, qty: number, cost: number, over: Partial<NonNullable<CartLine['item']>> = {}): CartLine => ({
    id, job_id: 'j1', destination_location_id: null, catalog_item_id: id, quantity: qty,
    item: { vendor_id: vendor, sku: id, name: id, unit_cost_cents: cost, stock_status: 'in_stock', min_order_qty: 1, pack_size: 1, active: true, inventory_vendors: { name: vendor }, ...over },
  });
  it('groups by supplier and totals only orderable lines', () => {
    const groups = groupCartByVendor([line('a', 'Zed', 2, 500), line('b', 'Acme', 1, 300), line('c', 'Acme', 4, 100, { stock_status: 'discontinued' })]);
    expect(groups.map((g) => g.vendorName)).toEqual(['Acme', 'Zed']);
    expect(groups[0]).toMatchObject({ totalCents: 300, unavailable: 1 });
    expect(groups[1].totalCents).toBe(1000);
  });
  it('summarises the latest open ETA for a job', () => {
    const h = jobPartsHeadline([order({ expected_at: '2026-10-24' }), order({ expected_at: '2026-10-28' }), order({ quantity_received: 2, expected_at: '2026-11-30' })]);
    expect(h).toEqual({ open: 2, eta: '2026-10-28', allReceived: false });
    expect(jobPartsHeadline([order({ quantity_received: 2 })]).allReceived).toBe(true);
  });
  it('words the hold outcome', () => {
    expect(holdMessage({ orders: [], skipped: [], jobs: [{ job_id: 'j', hold: 'ok' }] })).toMatch(/Waiting on parts/);
    expect(holdMessage({ orders: [], skipped: [], jobs: [{ job_id: 'j', hold: 'not_requested' }] })).toBeNull();
  });
});
