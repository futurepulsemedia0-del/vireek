import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }));

import { supabase } from './supabase';
import {
  applyOps,
  availableQty,
  cleanScan,
  codeKey,
  describeOp,
  discardOp,
  enqueueOp,
  fetchTruckSnapshot,
  filterItems,
  findPartByCode,
  flushQueue,
  formatAgo,
  interpretResponse,
  itemFromCatalog,
  loadCachedSnapshot,
  loadQueue,
  MAX_ATTEMPTS,
  parseSnapshot,
  refillQty,
  retryOp,
  saveCachedSnapshot,
  sortItems,
  stockLevel,
  suggestedRequestQty,
  type QueuedOp,
  type TruckItem,
  type TruckSnapshot,
} from './truckStockField';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const item = (over: Partial<TruckItem> = {}): TruckItem => ({
  part_id: 'p1', name: 'Capacitor 45/5', part_number: 'CAP-455', barcode: '012345678905', category: null, unit_label: null,
  on_hand: 5, reserved: 0, min_quantity: 2, target_quantity: 6, requested_qty: 0, ...over,
});

const snap = (over: Partial<TruckSnapshot> = {}): TruckSnapshot => ({
  technician_id: 't1',
  location: { id: 'l1', name: 'Van 1' },
  items: [item()],
  jobs: [],
  vendors: [],
  catalog: [{ id: 'p9', name: 'Contactor 30A', part_number: 'CON-30', barcode: '9990001' }],
  generated_at: '2026-10-09T10:00:00.000Z',
  ...over,
});

const op = (over: Partial<QueuedOp> = {}): QueuedOp => ({
  id: 'o1', kind: 'use', part_id: 'p1', part_name: 'Capacitor 45/5', quantity: 1, job_id: null, note: null,
  return_kind: null, vendor_id: null, created_at: 1, state: 'pending', attempts: 0, last_error: null, ...over,
});

beforeEach(() => {
  window.localStorage.clear();
  rpc.mockReset();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('stock levels', () => {
  it('matches the truck_stock_status rules: empty at 0, low at/below the par minimum', () => {
    expect(stockLevel(item({ on_hand: 0 }))).toBe('empty');
    expect(stockLevel(item({ on_hand: -2 }))).toBe('empty');
    expect(stockLevel(item({ on_hand: 2 }))).toBe('low');
    expect(stockLevel(item({ on_hand: 3 }))).toBe('ok');
  });
  it('never flags "low" for a part without a par level', () => {
    expect(stockLevel(item({ on_hand: 1, min_quantity: null, target_quantity: null }))).toBe('ok');
  });
  it('subtracts reserved stock from what is available', () => {
    expect(availableQty(item({ on_hand: 4, reserved: 3 }))).toBe(1);
    expect(stockLevel(item({ on_hand: 4, reserved: 4 }))).toBe('empty');
  });
  it('suggests topping up to target, net of what is already requested', () => {
    expect(refillQty(item({ on_hand: 1 }))).toBe(5);
    expect(suggestedRequestQty(item({ on_hand: 1 }))).toBe(5);
    expect(suggestedRequestQty(item({ on_hand: 1, requested_qty: 5 }))).toBe(1);
    expect(suggestedRequestQty(item({ target_quantity: null }))).toBe(1);
  });
});

describe('sorting and filtering', () => {
  const list = [
    item({ part_id: 'a', name: 'Zip ties', on_hand: 20 }),
    item({ part_id: 'b', name: 'Fuse', on_hand: 0 }),
    item({ part_id: 'c', name: 'Belt', on_hand: 1 }),
    item({ part_id: 'd', name: 'Anchor', on_hand: 20 }),
  ];
  it('puts empty, then low, then the rest alphabetically', () => {
    expect(sortItems(list).map((i) => i.name)).toEqual(['Fuse', 'Belt', 'Anchor', 'Zip ties']);
  });
  it('does not mutate its input', () => {
    const copy = [...list];
    sortItems(list);
    expect(list).toEqual(copy);
  });
  it('filters by search text across name, part number and barcode', () => {
    expect(filterItems(list, 'fus', 'all').map((i) => i.part_id)).toEqual(['b']);
    expect(filterItems(list, '012345678905', 'all')).toHaveLength(4);
    expect(filterItems(list, 'nothing', 'all')).toHaveLength(0);
  });
  it('supports the restock and requested filters', () => {
    expect(filterItems(list, '', 'restock').map((i) => i.part_id).sort()).toEqual(['b', 'c']);
    expect(filterItems([...list, item({ part_id: 'e', requested_qty: 3 })], '', 'requested').map((i) => i.part_id)).toEqual(['e']);
  });
});

describe('barcode matching', () => {
  it('strips scanner control characters', () => {
    expect(cleanScan('  0123\r\n')).toBe('0123');
  });
  it('treats a UPC-A and its EAN-13 form as the same product', () => {
    expect(codeKey('012345678905')).toBe(codeKey('0012345678905'));
  });
  it('ignores case and separators in part numbers', () => {
    expect(codeKey('cap-45/5')).toBe(codeKey('CAP 45 5'));
  });
  it('finds a van part by barcode, even with a trailing newline', () => {
    const m = findPartByCode(snap(), '0012345678905\n');
    expect(m).toMatchObject({ kind: 'on_truck', item: { part_id: 'p1' } });
  });
  it('finds a van part by part number', () => {
    expect(findPartByCode(snap(), 'cap 455')).toMatchObject({ kind: 'on_truck' });
  });
  it('falls back to the catalog for parts the van does not list', () => {
    expect(findPartByCode(snap(), '9990001')).toMatchObject({ kind: 'catalog', part: { id: 'p9' } });
  });
  it('prefers the van row when a catalog hit is already on the van', () => {
    const s = snap({ catalog: [{ id: 'p1', name: 'Capacitor 45/5', part_number: null, barcode: '777' }] });
    expect(findPartByCode(s, '777')).toMatchObject({ kind: 'on_truck', item: { part_id: 'p1' } });
  });
  it('reports unknown and empty codes without throwing', () => {
    expect(findPartByCode(snap(), 'zzz-404')).toEqual({ kind: 'unknown', code: 'zzz-404' });
    expect(findPartByCode(snap(), ' \n')).toEqual({ kind: 'unknown', code: '' });
  });
});

describe('applyOps (optimistic view)', () => {
  it('subtracts usage, adds put-back, removes warehouse returns, leaves cores alone', () => {
    const s = snap();
    const out = applyOps(s, [
      op({ id: '1', kind: 'use', quantity: 2 }),
      op({ id: '2', kind: 'return', return_kind: 'unused', quantity: 1 }),
      op({ id: '3', kind: 'return', return_kind: 'to_warehouse', quantity: 1 }),
      op({ id: '4', kind: 'return', return_kind: 'core', quantity: 1 }),
    ]);
    expect(out.items[0].on_hand).toBe(5 - 2 + 1 - 1);
  });
  it('shows a pending request without changing stock, and never lowers an existing one', () => {
    const out = applyOps(snap({ items: [item({ requested_qty: 4 })] }), [op({ kind: 'request', quantity: 2 })]);
    expect(out.items[0].requested_qty).toBe(4);
    expect(out.items[0].on_hand).toBe(5);
  });
  it('ignores failed operations (the server rejected them)', () => {
    expect(applyOps(snap(), [op({ state: 'failed', quantity: 3 })]).items[0].on_hand).toBe(5);
  });
  it('adds a catalog part used off-list as a negative van row', () => {
    const out = applyOps(snap(), [op({ part_id: 'p9', part_name: 'Contactor 30A', quantity: 1 })]);
    const added = out.items.find((i) => i.part_id === 'p9');
    expect(added).toMatchObject({ name: 'Contactor 30A', on_hand: -1, part_number: 'CON-30' });
  });
  it('does not mutate the snapshot it was given', () => {
    const s = snap();
    applyOps(s, [op({ quantity: 4 })]);
    expect(s.items[0].on_hand).toBe(5);
  });
  it('builds a van-shaped row from a catalog part', () => {
    expect(itemFromCatalog({ id: 'x', name: 'N', part_number: null, barcode: null })).toMatchObject({ part_id: 'x', on_hand: 0, min_quantity: null });
  });
});

describe('parseSnapshot (server data is untrusted)', () => {
  it('rejects garbage and snapshots without a truck', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ items: [] })).toBeNull();
    expect(parseSnapshot({ technician_id: 't', location: {} })).toBeNull();
  });
  it('coerces numbers, drops malformed rows and defaults the rest', () => {
    const s = parseSnapshot({
      technician_id: 't1',
      location: { id: 'l1', name: null },
      items: [
        { part_id: 'p1', name: 'A', on_hand: '7', reserved: -3, min_quantity: null, target_quantity: '9', requested_qty: 'x' },
        { part_id: 'p2' },
        'junk',
      ],
      jobs: [{ id: 'j1', customer_name: 'Smith' }, { id: 'j2' }],
    });
    expect(s?.location.name).toBe('My truck');
    expect(s?.items).toHaveLength(1);
    expect(s?.items[0]).toMatchObject({ on_hand: 7, reserved: 0, min_quantity: null, target_quantity: 9, requested_qty: 0 });
    expect(s?.jobs).toEqual([{ id: 'j1', customer_name: 'Smith', service_type: null, scheduled_datetime: null, job_status: 'scheduled' }]);
    expect(s?.catalog).toEqual([]);
  });
});

describe('interpretResponse', () => {
  it('applied / rejected statuses', () => {
    expect(interpretResponse({ status: 'applied' }, null, 0).type).toBe('applied');
    expect(interpretResponse({ status: 'applied', duplicate: true }, null, 0).type).toBe('applied');
    expect(interpretResponse({ status: 'job_not_found' }, null, 0)).toMatchObject({ type: 'rejected', message: 'That job is not assigned to you.' });
  });
  it('treats network and auth problems as "try later", never as a final failure', () => {
    expect(interpretResponse(null, { message: 'TypeError: Failed to fetch' }, 4).type).toBe('offline');
    expect(interpretResponse(null, { message: 'JWT expired', code: 'PGRST301' }, 4).type).toBe('offline');
  });
  it('retries server errors a few times, then parks the operation', () => {
    expect(interpretResponse(null, { message: 'function does not exist' }, 0).type).toBe('retry');
    expect(interpretResponse(null, { message: 'function does not exist' }, MAX_ATTEMPTS - 1).type).toBe('rejected');
  });
});

describe('queue storage', () => {
  it('stores validated operations per user and keeps them in order', () => {
    const a = enqueueOp('u1', { kind: 'use', part_id: 'p1', part_name: 'A', quantity: 2 }, 100);
    const b = enqueueOp('u1', { kind: 'request', part_id: 'p1', part_name: 'A', quantity: 3, note: '  need it  ' }, 200);
    expect(loadQueue('u1').map((o) => o.id)).toEqual([a.id, b.id]);
    expect(b.note).toBe('need it');
    expect(loadQueue('someone-else')).toEqual([]);
  });
  it('rejects bad quantities and incomplete returns', () => {
    expect(() => enqueueOp('u1', { kind: 'use', part_id: 'p', part_name: 'A', quantity: 0 })).toThrow(/quantity/i);
    expect(() => enqueueOp('u1', { kind: 'use', part_id: 'p', part_name: 'A', quantity: 1000 })).toThrow(/quantity/i);
    expect(() => enqueueOp('u1', { kind: 'return', part_id: 'p', part_name: 'A', quantity: 1 })).toThrow(/return/i);
  });
  it('only keeps a vendor on core returns', () => {
    const a = enqueueOp('u1', { kind: 'return', part_id: 'p', part_name: 'A', quantity: 1, return_kind: 'unused', vendor_id: 'v1' });
    const b = enqueueOp('u1', { kind: 'return', part_id: 'p', part_name: 'A', quantity: 1, return_kind: 'core', vendor_id: 'v1' });
    expect(a.vendor_id).toBeNull();
    expect(b.vendor_id).toBe('v1');
  });
  it('survives corrupted storage', () => {
    window.localStorage.setItem('vk:truck-stock:v1:u1:queue', '{not json');
    expect(loadQueue('u1')).toEqual([]);
    window.localStorage.setItem('vk:truck-stock:v1:u1:queue', JSON.stringify([{ kind: 'nope' }, null, 5]));
    expect(loadQueue('u1')).toEqual([]);
  });
  it('discards and retries individual operations', () => {
    const a = enqueueOp('u1', { kind: 'use', part_id: 'p', part_name: 'A', quantity: 1 });
    const b = enqueueOp('u1', { kind: 'use', part_id: 'p', part_name: 'A', quantity: 1 });
    window.localStorage.setItem('vk:truck-stock:v1:u1:queue', JSON.stringify(loadQueue('u1').map((o) => (o.id === a.id ? { ...o, state: 'failed', attempts: 5, last_error: 'x' } : o))));
    retryOp('u1', a.id);
    expect(loadQueue('u1')[0]).toMatchObject({ state: 'pending', attempts: 0, last_error: null });
    discardOp('u1', b.id);
    expect(loadQueue('u1').map((o) => o.id)).toEqual([a.id]);
  });
  it('caches the snapshot per user', () => {
    expect(saveCachedSnapshot('u1', snap())).toBe(true);
    expect(loadCachedSnapshot('u1')?.location.name).toBe('Van 1');
    expect(loadCachedSnapshot('u2')).toBeNull();
  });
});

describe('flushQueue', () => {
  it('sends operations in order with the right RPC and parameters, then clears them', async () => {
    const use = enqueueOp('u1', { kind: 'use', part_id: 'p1', part_name: 'A', quantity: 2, job_id: 'j1', note: 'swap' });
    const req = enqueueOp('u1', { kind: 'request', part_id: 'p1', part_name: 'A', quantity: 4 });
    const ret = enqueueOp('u1', { kind: 'return', part_id: 'p1', part_name: 'A', quantity: 1, return_kind: 'core', vendor_id: 'v1', note: 'burnt' });
    rpc.mockResolvedValue({ data: { status: 'applied' }, error: null });

    const summary = await flushQueue('u1');

    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['tech_use_part', 'tech_request_restock', 'tech_return_part']);
    expect(rpc.mock.calls[0][1]).toEqual({ p_op_id: use.id, p_part_id: 'p1', p_quantity: 2, p_job_id: 'j1', p_note: 'swap' });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_op_id: req.id, p_quantity: 4, p_job_id: null });
    expect(rpc.mock.calls[2][1]).toEqual({ p_op_id: ret.id, p_part_id: 'p1', p_quantity: 1, p_job_id: null, p_kind: 'core', p_reason: 'burnt', p_vendor_id: 'v1' });
    expect(summary.applied).toHaveLength(3);
    expect(loadQueue('u1')).toEqual([]);
  });

  it('keeps everything and stops when there is no signal (field data is never dropped)', async () => {
    enqueueOp('u1', { kind: 'use', part_id: 'p1', part_name: 'A', quantity: 1 });
    enqueueOp('u1', { kind: 'use', part_id: 'p2', part_name: 'B', quantity: 1 });
    rpc.mockResolvedValue({ data: null, error: { message: 'TypeError: Failed to fetch' } });

    const summary = await flushQueue('u1');

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ offline: true, applied: [] });
    expect(loadQueue('u1').every((o) => o.state === 'pending')).toBe(true);
  });

  it('parks a rejected operation as failed with a readable reason and continues with the rest', async () => {
    enqueueOp('u1', { kind: 'use', part_id: 'p1', part_name: 'A', quantity: 1, job_id: 'foreign' });
    enqueueOp('u1', { kind: 'use', part_id: 'p2', part_name: 'B', quantity: 1 });
    rpc.mockResolvedValueOnce({ data: { status: 'job_not_found' }, error: null }).mockResolvedValueOnce({ data: { status: 'applied' }, error: null });

    const summary = await flushQueue('u1');

    expect(summary).toMatchObject({ failed: 1 });
    expect(summary.applied).toHaveLength(1);
    const left = loadQueue('u1');
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ state: 'failed', last_error: 'That job is not assigned to you.' });
  });

  it('does nothing while the device reports offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    enqueueOp('u1', { kind: 'use', part_id: 'p1', part_name: 'A', quantity: 1 });
    const summary = await flushQueue('u1');
    expect(rpc).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ offline: true, remaining: 1 });
  });

  it('keeps operations added while a flush is running', async () => {
    enqueueOp('u1', { kind: 'use', part_id: 'p1', part_name: 'A', quantity: 1 });
    rpc.mockImplementationOnce(async () => {
      enqueueOp('u1', { kind: 'use', part_id: 'p2', part_name: 'B', quantity: 1 }); // technician taps again mid-sync
      return { data: { status: 'applied' }, error: null };
    });
    await flushQueue('u1');
    expect(loadQueue('u1').map((o) => o.part_id)).toEqual(['p2']);
  });
});

describe('fetchTruckSnapshot', () => {
  it('parses a good response', async () => {
    rpc.mockResolvedValue({ data: snap(), error: null });
    const r = await fetchTruckSnapshot();
    expect(r.ok && r.snapshot.items).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('get_my_truck_stock');
  });
  it('maps blocked states, network failures and unreadable data', async () => {
    rpc.mockResolvedValueOnce({ data: { error: 'no_truck' }, error: null });
    expect(await fetchTruckSnapshot()).toMatchObject({ ok: false, reason: 'no_truck' });
    rpc.mockResolvedValueOnce({ data: { error: 'not_a_technician' }, error: null });
    expect(await fetchTruckSnapshot()).toMatchObject({ ok: false, reason: 'not_a_technician' });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    expect(await fetchTruckSnapshot()).toMatchObject({ ok: false, reason: 'network' });
    rpc.mockResolvedValueOnce({ data: { hello: 1 }, error: null });
    expect(await fetchTruckSnapshot()).toMatchObject({ ok: false, reason: 'error' });
    rpc.mockRejectedValueOnce(new Error('Load failed'));
    expect(await fetchTruckSnapshot()).toMatchObject({ ok: false, reason: 'network' });
  });
});

describe('display helpers', () => {
  it('describes operations in plain words', () => {
    expect(describeOp(op({ quantity: 2 }))).toBe('Used 2 × Capacitor 45/5');
    expect(describeOp(op({ kind: 'request', quantity: 3 }))).toBe('Restock request: 3 × Capacitor 45/5');
    expect(describeOp(op({ kind: 'return', return_kind: 'core' }))).toBe('Core return to vendor: 1 × Capacitor 45/5');
  });
  it('formats "synced" ages', () => {
    const now = 1_000_000_000;
    expect(formatAgo(null, now)).toBe('never');
    expect(formatAgo(now - 10_000, now)).toBe('just now');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatAgo(now - 50 * 3_600_000, now)).toBe('2 d ago');
  });
});
