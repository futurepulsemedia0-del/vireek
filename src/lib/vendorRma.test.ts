import { describe, expect, it } from 'vitest';
import {
  EMPTY_LINE,
  EMPTY_RMA_FORM,
  allowedActions,
  applyStockDeltas,
  availableQty,
  awaitingCredit,
  centsToInput,
  closeNeedsShortfallAccept,
  creditAgeDays,
  expectedCreditCents,
  filterRmas,
  findStockShortages,
  grossCreditCents,
  lineCreditCents,
  netRecoveryCents,
  openReplacementUnits,
  parseMoneyToCents,
  parseRmaForm,
  previewExpectedCredit,
  receivedCreditCents,
  remainingReturnable,
  requiredStock,
  returnCostValueCents,
  rmaToForm,
  stockDeltas,
  summarizeCredit,
  summarizeRmas,
  type Rma,
  type RmaFormValues,
  type RmaLine,
  type StockLevel,
} from './vendorRma';

const NOW = new Date('2027-01-31T12:00:00Z');

function line(over: Partial<RmaLine> = {}): RmaLine {
  return {
    id: 'l1', rma_id: 'r1', line_no: 1, part_id: 'p1', source: 'stock', location_id: 'loc1', quantity: 2,
    unit_credit_cents: 1000, unit_cost_cents: 900, purchase_order_line_id: null, usage_transaction_id: null, job_id: null,
    serial_number: null, note: null, ship_transaction_id: null, inbound_transaction_id: null, quantity_replaced: 0,
    part: { name: 'Capacitor 45/5', part_number: 'CAP-455' }, location: { name: 'Main warehouse' },
    ...over,
  };
}

function rma(over: Partial<Rma> = {}): Rma {
  return {
    id: 'r1', rma_number: 'RMA-00001', vendor_rma_number: null, vendor_id: 'v1', purchase_order_id: null, status: 'draft',
    reason_code: 'defective', reason_notes: null, resolution: 'credit', ship_status: 'not_shipped', carrier: null,
    tracking_number: null, tracking_url: null, restocking_fee_cents: 0, return_freight_cents: 0, credit_expected_cents: 2000,
    credit_received_cents: 0, authorized_at: null, shipped_at: null, delivered_at: null, closed_at: null,
    created_at: '2027-01-02T00:00:00Z', updated_at: '2027-01-02T00:00:00Z', vendor: { name: 'Acme Supply' },
    purchase_order: null, lines: [line()],
    ...over,
  };
}

describe('money parsing', () => {
  it('parses whole, decimal and formatted amounts to cents', () => {
    expect(parseMoneyToCents('12')).toBe(1200);
    expect(parseMoneyToCents('12.5')).toBe(1250);
    expect(parseMoneyToCents('$1,234.50')).toBe(123450);
    expect(parseMoneyToCents('0.07')).toBe(7);
  });

  it('rejects negatives, extra decimals and text', () => {
    expect(parseMoneyToCents('-5')).toBeNull();
    expect(parseMoneyToCents('1.234')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('')).toBeNull();
  });

  it('formats cents for inputs', () => {
    expect(centsToInput(1250)).toBe('12.50');
    expect(centsToInput(-5)).toBe('0.00');
  });
});

describe('credit math', () => {
  it('multiplies quantity by credit per unit', () => {
    expect(lineCreditCents({ quantity: 3, unit_credit_cents: 1250 })).toBe(3750);
    expect(grossCreditCents([{ quantity: 2, unit_credit_cents: 1000 }, { quantity: 1, unit_credit_cents: 550 }])).toBe(2550);
  });

  it('subtracts the restocking fee and never goes below zero', () => {
    const lines = [{ quantity: 2, unit_credit_cents: 1000 }];
    expect(expectedCreditCents(lines, 500, 'credit')).toBe(1500);
    expect(expectedCreditCents(lines, 500, 'refund')).toBe(1500);
    expect(expectedCreditCents(lines, 9999, 'credit')).toBe(0);
  });

  it('expects no money for a replacement', () => {
    expect(expectedCreditCents([{ quantity: 2, unit_credit_cents: 1000 }], 0, 'replacement')).toBe(0);
  });

  it('ignores voided credits when summing what was received', () => {
    const credits = [
      { amount_cents: 1000, voided_at: null },
      { amount_cents: 700, voided_at: '2027-01-10T00:00:00Z' },
      { amount_cents: 250, voided_at: null },
    ];
    expect(receivedCreditCents(credits)).toBe(1250);
  });

  it('classifies credit as none, partial, full or over', () => {
    expect(summarizeCredit(2000, 0, 'credit').state).toBe('none');

    const partial = summarizeCredit(2000, 500, 'credit');
    expect(partial.state).toBe('partial');
    expect(partial.outstanding).toBe(1500);
    expect(partial.percent).toBe(25);

    const full = summarizeCredit(2000, 2000, 'credit');
    expect(full.state).toBe('full');
    expect(full.outstanding).toBe(0);

    const over = summarizeCredit(2000, 2300, 'credit');
    expect(over.state).toBe('over');
    expect(over.overpaid).toBe(300);
    expect(over.percent).toBe(100);
  });

  it('treats replacements and zero-expected returns as not applicable', () => {
    expect(summarizeCredit(0, 0, 'replacement').state).toBe('not_applicable');
    expect(summarizeCredit(0, 0, 'credit').state).toBe('not_applicable');
    expect(summarizeCredit(0, 400, 'credit').state).toBe('over');
  });

  it('computes net recovery after return freight and the cost value of the return', () => {
    expect(netRecoveryCents(2000, 450)).toBe(1550);
    expect(netRecoveryCents(100, 450)).toBe(-350);
    expect(returnCostValueCents([{ quantity: 2, unit_cost_cents: 900 }, { quantity: 1, unit_cost_cents: 100 }])).toBe(1900);
  });

  it('works out what can still be returned', () => {
    expect(remainingReturnable(10, 4)).toBe(6);
    expect(remainingReturnable(10, 12)).toBe(0);
  });
});

describe('stock math', () => {
  const levels: StockLevel[] = [
    { part_id: 'p1', location_id: 'loc1', quantity_on_hand: 5, quantity_reserved: 2 },
    { part_id: 'p2', location_id: 'loc1', quantity_on_hand: 10, quantity_reserved: 0 },
  ];

  it('available stock is on hand minus reserved, never negative', () => {
    expect(availableQty(5, 2)).toBe(3);
    expect(availableQty(1, 4)).toBe(0);
  });

  it('groups stock lines per part and location and skips installed parts', () => {
    const lines = [
      line({ id: 'a', quantity: 2 }),
      line({ id: 'b', line_no: 2, quantity: 1 }),
      line({ id: 'c', line_no: 3, part_id: 'p2', quantity: 4 }),
      line({ id: 'd', line_no: 4, part_id: 'p3', source: 'installed', location_id: null, quantity: 9 }),
    ];
    expect(requiredStock(lines)).toEqual([
      { part_id: 'p1', location_id: 'loc1', needed: 3 },
      { part_id: 'p2', location_id: 'loc1', needed: 4 },
    ]);
  });

  it('flags a shortage against available (not on-hand) stock', () => {
    // p1 has 5 on hand but 2 reserved -> only 3 available.
    expect(findStockShortages([line({ quantity: 3 })], levels)).toEqual([]);
    expect(findStockShortages([line({ quantity: 4 })], levels)).toEqual([
      { part_id: 'p1', location_id: 'loc1', needed: 4, available: 3 },
    ]);
  });

  it('counts two lines of the same part together and treats a missing stock row as zero', () => {
    const lines = [line({ id: 'a', quantity: 2 }), line({ id: 'b', line_no: 2, quantity: 2 })];
    expect(findStockShortages(lines, levels)).toHaveLength(1);
    expect(findStockShortages([line({ part_id: 'p9', quantity: 1 })], levels)).toEqual([
      { part_id: 'p9', location_id: 'loc1', needed: 1, available: 0 },
    ]);
  });

  it('shipping removes stock lines only, and only once', () => {
    const lines = [
      line({ id: 'a', quantity: 2 }),
      line({ id: 'b', line_no: 2, part_id: 'p3', source: 'installed', location_id: null, quantity: 5 }),
      line({ id: 'c', line_no: 3, part_id: 'p2', quantity: 1, ship_transaction_id: 'tx-already' }),
    ];
    expect(stockDeltas(lines, 'ship')).toEqual([{ part_id: 'p1', location_id: 'loc1', delta: -2 }]);
  });

  it('a rejected return puts shipped stock back, but not twice', () => {
    const lines = [
      line({ id: 'a', quantity: 2, ship_transaction_id: 'tx1' }),
      line({ id: 'b', line_no: 2, part_id: 'p2', quantity: 3, ship_transaction_id: 'tx2', inbound_transaction_id: 'tx3' }),
      line({ id: 'c', line_no: 3, part_id: 'p4', quantity: 1 }),
    ];
    expect(stockDeltas(lines, 'restock_on_reject')).toEqual([{ part_id: 'p1', location_id: 'loc1', delta: 2 }]);
  });

  it('receiving a replacement adds only the units still open', () => {
    const lines = [
      line({ id: 'a', quantity: 4, quantity_replaced: 1 }),
      line({ id: 'b', line_no: 2, part_id: 'p2', quantity: 2, quantity_replaced: 2 }),
    ];
    expect(stockDeltas(lines, 'receive_replacement')).toEqual([{ part_id: 'p1', location_id: 'loc1', delta: 3 }]);
    expect(openReplacementUnits(lines)).toBe(3);
  });

  it('ship then restock returns stock to where it started, without mutating the input', () => {
    const lines = [line({ quantity: 2 })];
    const after = applyStockDeltas(levels, stockDeltas(lines, 'ship'));
    expect(after.find((s) => s.part_id === 'p1')?.quantity_on_hand).toBe(3);
    expect(levels[0].quantity_on_hand).toBe(5);

    const shippedLines = [line({ quantity: 2, ship_transaction_id: 'tx1' })];
    const back = applyStockDeltas(after, stockDeltas(shippedLines, 'restock_on_reject'));
    expect(back.find((s) => s.part_id === 'p1')?.quantity_on_hand).toBe(5);
  });

  it('creates a row for a location that had no stock yet', () => {
    const next = applyStockDeltas([], [{ part_id: 'p1', location_id: 'loc9', delta: 3 }]);
    expect(next).toEqual([{ part_id: 'p1', location_id: 'loc9', quantity_on_hand: 3, quantity_reserved: 0 }]);
  });
});

describe('workflow', () => {
  it('a draft can be edited, authorized, shipped, cancelled or rejected', () => {
    const a = allowedActions(rma({ status: 'draft' }));
    expect(a).toContain('edit');
    expect(a).toContain('authorize');
    expect(a).toContain('ship');
    expect(a).toContain('cancel');
    expect(a).toContain('reject');
    expect(a).not.toContain('record_credit');
  });

  it('an authorized return cannot be authorized again', () => {
    const a = allowedActions(rma({ status: 'authorized' }));
    expect(a).not.toContain('authorize');
    expect(a).toContain('ship');
  });

  it('a shipped return takes shipment updates and credit but cannot be edited or cancelled', () => {
    const a = allowedActions(rma({ status: 'shipped' }));
    expect(a).toContain('update_shipment');
    expect(a).toContain('record_credit');
    expect(a).toContain('reject');
    expect(a).not.toContain('edit');
    expect(a).not.toContain('cancel');
  });

  it('credit already received blocks rejecting and allows voiding', () => {
    const a = allowedActions(rma({ status: 'received_by_vendor', credit_received_cents: 500 }));
    expect(a).not.toContain('reject');
    expect(a).toContain('void_credit');
    expect(a).toContain('close');
  });

  it('only a replacement return with open units can receive a replacement', () => {
    expect(allowedActions(rma({ status: 'shipped', resolution: 'replacement' }))).toContain('receive_replacement');
    expect(allowedActions(rma({ status: 'shipped', resolution: 'credit' }))).not.toContain('receive_replacement');
    const done = rma({ status: 'shipped', resolution: 'replacement', lines: [line({ quantity: 2, quantity_replaced: 2 })] });
    expect(allowedActions(done)).not.toContain('receive_replacement');
  });

  it('closed and cancelled returns allow nothing', () => {
    expect(allowedActions(rma({ status: 'closed' }))).toEqual([]);
    expect(allowedActions(rma({ status: 'cancelled' }))).toEqual([]);
  });

  it('closing a vendor-received return needs an explicit shortfall decision', () => {
    expect(closeNeedsShortfallAccept('received_by_vendor')).toBe(true);
    expect(closeNeedsShortfallAccept('resolved')).toBe(false);
  });
});

describe('aging and summary', () => {
  it('ages credit from delivery, falling back to shipping', () => {
    expect(creditAgeDays({ delivered_at: '2027-01-21T12:00:00Z', shipped_at: '2027-01-10T12:00:00Z' }, NOW)).toBe(10);
    expect(creditAgeDays({ delivered_at: null, shipped_at: '2027-01-10T12:00:00Z' }, NOW)).toBe(21);
    expect(creditAgeDays({ delivered_at: null, shipped_at: null }, NOW)).toBeNull();
  });

  it('is awaiting credit only after shipping, for non-replacements with money outstanding', () => {
    expect(awaitingCredit(rma({ status: 'shipped' }))).toBe(true);
    expect(awaitingCredit(rma({ status: 'draft' }))).toBe(false);
    expect(awaitingCredit(rma({ status: 'shipped', resolution: 'replacement' }))).toBe(false);
    expect(awaitingCredit(rma({ status: 'shipped', credit_received_cents: 2000 }))).toBe(false);
  });

  it('summarizes the portfolio', () => {
    const rows = [
      rma({ id: 'a', status: 'draft' }),
      rma({ id: 'b', status: 'shipped', shipped_at: '2027-01-25T00:00:00Z', credit_received_cents: 500 }),
      rma({ id: 'c', status: 'received_by_vendor', delivered_at: '2026-12-01T00:00:00Z' }),
      rma({ id: 'd', status: 'resolved', credit_received_cents: 2000 }),
      rma({ id: 'e', status: 'cancelled', credit_received_cents: 999 }),
    ];
    const s = summarizeRmas(rows, NOW, 30);
    expect(s.active).toBe(3);
    expect(s.drafts).toBe(1);
    expect(s.inTransit).toBe(1);
    expect(s.awaitingCredit).toBe(2);
    expect(s.outstandingCents).toBe(1500 + 2000);
    expect(s.receivedCents).toBe(500 + 2000);
    expect(s.overdue).toBe(1);
  });

  it('filters by status, vendor and search text', () => {
    const rows = [
      rma({ id: 'a', rma_number: 'RMA-00001' }),
      rma({ id: 'b', rma_number: 'RMA-00002', status: 'shipped', vendor_id: 'v2', vendor: { name: 'Delta Parts' }, tracking_number: '1Z999' }),
      rma({ id: 'c', rma_number: 'RMA-00003', status: 'closed' }),
    ];
    const base = { status: 'all' as const, vendorId: '', query: '' };
    expect(filterRmas(rows, base)).toHaveLength(3);
    expect(filterRmas(rows, { ...base, status: 'active' }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterRmas(rows, { ...base, vendorId: 'v2' }).map((r) => r.id)).toEqual(['b']);
    expect(filterRmas(rows, { ...base, query: '1z999' }).map((r) => r.id)).toEqual(['b']);
    expect(filterRmas(rows, { ...base, query: 'cap-455' })).toHaveLength(3);
    expect(filterRmas(rows, { ...base, query: 'nothing matches' })).toHaveLength(0);
  });
});

describe('form validation', () => {
  const validLine = {
    ...EMPTY_LINE('k1'),
    part_id: 'p1',
    location_id: 'loc1',
    quantity: '2',
    unit_credit: '10.00',
  };
  const valid: RmaFormValues = { ...EMPTY_RMA_FORM, vendor_id: 'v1', lines: [validLine] };

  it('builds the payload in cents', () => {
    const r = parseRmaForm({ ...valid, restocking_fee: '5', vendor_rma_number: '  AUTH-77 ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.restocking_fee_cents).toBe(500);
      expect(r.value.vendor_rma_number).toBe('AUTH-77');
      expect(r.value.lines[0].unit_credit_cents).toBe(1000);
      expect(r.value.lines[0].quantity).toBe(2);
      expect(r.value.lines[0].purchase_order_line_id).toBeNull();
    }
  });

  it('leaves an empty credit per unit as null so the server defaults it to cost', () => {
    const r = parseRmaForm({ ...valid, lines: [{ ...validLine, unit_credit: '' }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.lines[0].unit_credit_cents).toBeNull();
  });

  it('requires a vendor and at least one line', () => {
    const r = parseRmaForm({ ...EMPTY_RMA_FORM });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.vendor_id).toBeTruthy();
      expect(r.errors.lines).toBeTruthy();
    }
  });

  it('rejects a bad quantity, a missing stock location and an over-return', () => {
    const bad = parseRmaForm({
      ...valid,
      lines: [{ ...validLine, quantity: '0', location_id: '' }, { ...validLine, key: 'k2', quantity: '5', max_quantity: 3 }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors['line.0.quantity']).toBeTruthy();
      expect(bad.errors['line.0.location_id']).toBeTruthy();
      expect(bad.errors['line.1.quantity']).toBe('Only 3 can still be returned.');
    }
  });

  it('needs a receiving location for every line of a replacement, even installed parts', () => {
    const r = parseRmaForm({
      ...valid,
      resolution: 'replacement',
      lines: [{ ...validLine, source: 'installed', location_id: '' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors['line.0.location_id']).toBeTruthy();
  });

  it('does not need a location for an installed part on a credit return', () => {
    const r = parseRmaForm({ ...valid, lines: [{ ...validLine, source: 'installed', location_id: '' }] });
    expect(r.ok).toBe(true);
  });

  it('treats a part used on a job as installed only', () => {
    const r = parseRmaForm({ ...valid, lines: [{ ...validLine, usage_transaction_id: 'u1', source: 'stock' }] });
    expect(r.ok).toBe(false);
  });

  it('previews the expected credit, using the cost hint when no credit is typed', () => {
    const form: RmaFormValues = {
      ...valid,
      restocking_fee: '5',
      lines: [validLine, { ...EMPTY_LINE('k2'), part_id: 'p2', location_id: 'loc1', quantity: '3', unit_credit: '', cost_hint_cents: 400 }],
    };
    // 2 x 10.00 + 3 x 4.00 - 5.00 fee
    expect(previewExpectedCredit(form)).toBe(2000 + 1200 - 500);
    expect(previewExpectedCredit({ ...form, resolution: 'replacement' })).toBe(0);
  });

  it('round-trips a saved return back into the form', () => {
    const saved = rma({ restocking_fee_cents: 250, vendor_rma_number: 'AUTH-1', lines: [line({ unit_credit_cents: 1250 })] });
    const form = rmaToForm(saved);
    expect(form.restocking_fee).toBe('2.50');
    expect(form.lines[0].unit_credit).toBe('12.50');
    const parsed = parseRmaForm(form);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.restocking_fee_cents).toBe(250);
      expect(parsed.value.lines[0].unit_credit_cents).toBe(1250);
    }
  });
});
