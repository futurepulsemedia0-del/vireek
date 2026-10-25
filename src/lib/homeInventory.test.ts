import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const invoke = vi.fn();
const uploadToSignedUrl = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
    storage: { from: () => ({ uploadToSignedUrl: (...args: unknown[]) => uploadToSignedUrl(...args) }) },
  },
}));

import {
  EMPTY_FORM, InventoryError, addInventoryReminder, applySuggestion, buildFields, buildIcs, centsToInput, checkUpload,
  daysBetween, dayNumber, deleteInventoryFile, deleteInventoryItem, equipmentLabel, fetchPortalInventory, filterItems,
  formFromItem, formatBytes, formatDay, formatMoney, friendlyRpcError, getInventoryFileUrl, priceToCents, reminderAction,
  reminderStatus, saveInventoryItem, todayIso, uploadInventoryFile, validateForm, warrantyStatus,
  type InventoryItem, type InventoryReminder, type ItemSuggestion,
} from './homeInventory';

const TOKEN = '3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f';
const TODAY = '2026-10-23';

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
  uploadToSignedUrl.mockReset();
});

// ---------------------------------------------------------------- dates

describe('dates', () => {
  it('formats the local calendar day', () => {
    expect(todayIso(new Date(2026, 9, 3, 23, 59))).toBe('2026-10-03');
  });
  it('rejects impossible dates instead of letting them roll over', () => {
    expect(dayNumber('2024-02-29')).not.toBeNull();
    expect(dayNumber('2023-02-29')).toBeNull();
    expect(dayNumber('2024-02-31')).toBeNull();
    expect(dayNumber('2024-13-01')).toBeNull();
    expect(dayNumber('24-01-01')).toBeNull();
    expect(dayNumber(null)).toBeNull();
  });
  it('counts whole days, across month, year and leap boundaries', () => {
    expect(daysBetween('2026-10-23', '2026-10-24')).toBe(1);
    expect(daysBetween('2026-10-23', '2026-10-22')).toBe(-1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2026-10-23', 'junk')).toBeNull();
  });
  it('formats a date-only value without a timezone shift', () => {
    expect(formatDay('2026-03-01', 'en-US')).toBe('Mar 1, 2026');
    expect(formatDay(null)).toBe('—');
  });
});

describe('warranty and reminder status', () => {
  it('classifies warranties', () => {
    expect(warrantyStatus(null, TODAY)).toEqual({ state: 'none', daysLeft: null });
    expect(warrantyStatus('2026-10-22', TODAY)).toEqual({ state: 'expired', daysLeft: -1 });
    expect(warrantyStatus('2026-10-23', TODAY)).toEqual({ state: 'expiring', daysLeft: 0 });
    expect(warrantyStatus('2026-12-22', TODAY)).toEqual({ state: 'expiring', daysLeft: 60 });
    expect(warrantyStatus('2026-12-23', TODAY)).toEqual({ state: 'active', daysLeft: 61 });
    expect(warrantyStatus('garbage', TODAY).state).toBe('none');
  });
  it('classifies reminders', () => {
    expect(reminderStatus('2026-10-22', TODAY)).toEqual({ state: 'overdue', days: -1 });
    expect(reminderStatus('2026-10-23', TODAY)).toEqual({ state: 'due_soon', days: 0 });
    expect(reminderStatus('2026-11-22', TODAY)).toEqual({ state: 'due_soon', days: 30 });
    expect(reminderStatus('2026-11-23', TODAY)).toEqual({ state: 'upcoming', days: 31 });
  });
});

// ---------------------------------------------------------------- money

describe('money', () => {
  it('parses prices written the way people write them', () => {
    expect(priceToCents('1299.99', 'USD')).toBe(129999);
    expect(priceToCents('1,299.99', 'USD')).toBe(129999);
    expect(priceToCents('1.299,99', 'EUR')).toBe(129999);
    expect(priceToCents('12,50', 'EUR')).toBe(1250);
    expect(priceToCents('1,299', 'USD')).toBe(129900);
    expect(priceToCents('1.299.000', 'EUR')).toBe(129900000);
    expect(priceToCents('$ 85', 'USD')).toBe(8500);
    expect(priceToCents('1200', 'JPY')).toBe(1200);
    expect(priceToCents('0', 'USD')).toBe(0);
  });
  it('rejects negatives and junk', () => {
    expect(priceToCents('-5', 'USD')).toBeNull();
    expect(priceToCents('abc', 'USD')).toBeNull();
    expect(priceToCents('', 'USD')).toBeNull();
    expect(priceToCents('99999999999', 'USD')).toBeNull();
  });
  it('round-trips and formats', () => {
    expect(centsToInput(129999, 'USD')).toBe('1299.99');
    expect(centsToInput(1200, 'JPY')).toBe('1200');
    expect(centsToInput(null, 'USD')).toBe('');
    expect(formatMoney(129999, 'USD', 'en-US')).toBe('$1,299.99');
    expect(formatMoney(1200, 'JPY', 'en-US')).toBe('¥1,200');
    expect(formatMoney(null, 'USD')).toBe('—');
  });
});

// ---------------------------------------------------------------- form

const SUGGESTION: ItemSuggestion = {
  name: 'Carrier 24ACC636', category: 'hvac', brand: 'Carrier', model: '24ACC636', serial_number: null, retailer: 'Home Depot',
  purchase_date: '2024-03-14', purchase_price_cents: 499999, currency: 'USD', warranty_months: 120, warranty_expires_at: '2034-03-14',
};

describe('applySuggestion', () => {
  it('fills only empty fields and reports what it filled', () => {
    const { form, filled } = applySuggestion(EMPTY_FORM, SUGGESTION);
    expect(form).toMatchObject({ name: 'Carrier 24ACC636', category: 'hvac', brand: 'Carrier', purchase_date: '2024-03-14', price: '4999.99', warranty_months: '120', warranty_expires_at: '2034-03-14' });
    expect(filled).toEqual(expect.arrayContaining(['name', 'brand', 'model', 'retailer', 'purchase_date', 'warranty_months', 'warranty_expires_at', 'category', 'price']));
    expect(filled).not.toContain('serial_number');
  });
  it('never overwrites what the customer already typed', () => {
    const typed = { ...EMPTY_FORM, name: 'Upstairs AC', brand: 'Trane', category: 'plumbing' as const, price: '10' };
    const { form } = applySuggestion(typed, SUGGESTION);
    expect(form).toMatchObject({ name: 'Upstairs AC', brand: 'Trane', category: 'plumbing', price: '10', model: '24ACC636' });
  });
  it('does nothing for an empty suggestion', () => {
    const empty: ItemSuggestion = { ...SUGGESTION, name: null, brand: null, model: null, retailer: null, purchase_date: null, purchase_price_cents: null, currency: null, warranty_months: null, warranty_expires_at: null, category: 'other' };
    const { form, filled } = applySuggestion(EMPTY_FORM, empty);
    expect(form).toEqual(EMPTY_FORM);
    expect(filled).toEqual([]);
  });
});

describe('validateForm / buildFields', () => {
  const ok = { ...EMPTY_FORM, name: 'Water heater' };
  it('accepts a minimal form', () => {
    expect(validateForm(ok, TODAY)).toEqual([]);
  });
  it('reports each problem on its field', () => {
    const issues = validateForm({
      ...ok, name: '  ', purchase_date: '2026-10-30', price: 'abc', warranty_months: '0', maintenance_months: '121', next_maintenance_due: '2026-13-01',
    }, TODAY);
    const fields = issues.map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'purchase_date', 'price', 'warranty_months', 'maintenance_months', 'next_maintenance_due']));
  });
  it('asks for an interval when a next maintenance date is given without one', () => {
    expect(validateForm({ ...ok, next_maintenance_due: '2027-01-01' }, TODAY).map((i) => i.field)).toContain('maintenance_months');
  });
  it('builds the exact RPC payload: blanks become null, price becomes minor units, maintenance can be removed', () => {
    const f = buildFields({ ...ok, brand: ' Rheem ', price: '1,299.99', warranty_months: '24', maintenance_months: '12', next_maintenance_due: '2027-03-01', equipment_id: 'e1' });
    expect(f).toMatchObject({
      name: 'Water heater', brand: 'Rheem', model: null, purchase_price_cents: 129999, currency: 'USD', warranty_months: 24,
      equipment_id: 'e1', maintenance_interval_months: 12, next_maintenance_due: '2027-03-01', source: 'customer',
    });
    const cleared = buildFields({ ...ok, maintenance_months: '', next_maintenance_due: '2027-03-01' });
    expect(cleared.maintenance_interval_months).toBeNull();
    expect(cleared.next_maintenance_due).toBeNull(); // no stray date without an interval
  });
});

const ITEM = (over: Partial<InventoryItem> = {}): InventoryItem => ({
  id: 'i1', category: 'water_heating', name: 'Water heater', brand: 'Rheem', model: 'XE40', serial_number: 'SN12345', location: 'Garage',
  retailer: 'Home Depot', purchase_date: '2024-03-14', purchase_price_cents: 129999, currency: 'USD', warranty_months: 24,
  warranty_expires_at: '2026-03-14', notes: null, equipment_id: null, source: 'customer', created_at: '2026-01-01T00:00:00Z', equipment: null, files: [], ...over,
});
const REMINDER = (over: Partial<InventoryReminder> = {}): InventoryReminder => ({
  id: 'r1', item_id: 'i1', item_name: 'Water heater', kind: 'maintenance', title: 'Maintenance: Water heater', due_date: '2026-12-01',
  interval_months: 12, status: 'active', last_completed_at: null, ...over,
});

describe('formFromItem / filterItems / labels', () => {
  it('loads an item and its active maintenance reminder into the form', () => {
    const f = formFromItem(ITEM(), [REMINDER(), REMINDER({ id: 'r2', item_id: 'other' })]);
    expect(f).toMatchObject({ name: 'Water heater', price: '1299.99', warranty_months: '24', maintenance_months: '12', next_maintenance_due: '2026-12-01', model: 'XE40' });
  });
  it('filters by text across name, brand, model, serial, room and store, and by category', () => {
    const items = [ITEM(), ITEM({ id: 'i2', name: 'Fridge', brand: 'LG', model: 'LRMVS', serial_number: null, location: 'Kitchen', category: 'kitchen', retailer: 'Best Buy' })];
    expect(filterItems(items, 'rheem', 'all').map((i) => i.id)).toEqual(['i1']);
    expect(filterItems(items, 'kitchen', 'all').map((i) => i.id)).toEqual(['i2']);
    expect(filterItems(items, 'sn123', 'all').map((i) => i.id)).toEqual(['i1']);
    expect(filterItems(items, '', 'kitchen').map((i) => i.id)).toEqual(['i2']);
    expect(filterItems(items, 'zzz', 'all')).toEqual([]);
  });
  it('labels equipment and byte sizes', () => {
    expect(equipmentLabel({ equipment_type: 'water_heater', make: 'Rheem', model: 'XE40' })).toBe('Rheem XE40');
    expect(equipmentLabel({ equipment_type: 'water_heater', make: null, model: null })).toBe('Water heater');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});

describe('checkUpload', () => {
  it('accepts photos and PDFs, and trusts the extension when a phone sends an empty type for HEIC', () => {
    expect(checkUpload({ name: 'a.jpg', type: 'image/jpeg', size: 100 })).toEqual({ ok: true, mime: 'image/jpeg' });
    expect(checkUpload({ name: 'IMG_0001.HEIC', type: '', size: 100 })).toEqual({ ok: true, mime: 'image/heic' });
    expect(checkUpload({ name: 'card.pdf', type: 'application/pdf', size: 100 })).toEqual({ ok: true, mime: 'application/pdf' });
  });
  it('rejects empty, oversized and unsupported files', () => {
    expect(checkUpload({ name: 'a.jpg', type: 'image/jpeg', size: 0 }).ok).toBe(false);
    expect(checkUpload({ name: 'a.jpg', type: 'image/jpeg', size: 40 * 1024 * 1024 }).ok).toBe(false);
    expect(checkUpload({ name: 'a.svg', type: 'image/svg+xml', size: 10 }).ok).toBe(false);
    expect(checkUpload({ name: 'a.exe', type: 'application/octet-stream', size: 10 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- calendar

describe('buildIcs', () => {
  const NOW = new Date('2026-10-23T12:00:00Z');
  it('produces a valid all-day calendar with a one-day-before alarm', () => {
    const ics = buildIcs([REMINDER()], 'Cool Air Co', NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('UID:reminder-r1@vireek');
    expect(ics).toContain('DTSTAMP:20261023T120000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261201');
    expect(ics).toContain('DTEND;VALUE=DATE:20261202');
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics).not.toMatch(/[^\r]\n/); // CRLF only
  });
  it('ends an event on the first of next month correctly and skips invalid dates', () => {
    const ics = buildIcs([REMINDER({ due_date: '2027-02-28' }), REMINDER({ id: 'bad', due_date: '2027-02-30' })], null, NOW);
    expect(ics).toContain('DTEND;VALUE=DATE:20270301');
    expect(ics).not.toContain('reminder-bad');
  });
  it('escapes text and folds long lines at 75 octets', () => {
    const ics = buildIcs([REMINDER({ title: 'Replace filter, check; "seal"\nnow', item_name: 'ü'.repeat(60) })], 'A, B', NOW);
    expect(ics).toContain('SUMMARY:Replace filter\\, check\\; "seal"\\nnow');
    const enc = new TextEncoder();
    for (const line of ics.split('\r\n')) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    // unfolding restores the full text
    expect(ics.replace(/\r\n /g, '')).toContain(`DESCRIPTION:${'ü'.repeat(60)} — A\\, B`);
  });
});

// ---------------------------------------------------------------- API

describe('errors', () => {
  it('maps database error codes to human messages', () => {
    expect(friendlyRpcError('HI_INVALID_DATE')).toContain('date');
    expect(friendlyRpcError('xx HI_LIMIT yy')).toContain('limit');
    expect(friendlyRpcError('permission denied for table x')).toBe('Something went wrong. Please try again.');
    expect(friendlyRpcError(null)).toBe('Something went wrong. Please try again.');
  });
});

describe('fetchPortalInventory', () => {
  it('returns normalised data', async () => {
    rpc.mockResolvedValue({ data: { customer: { name: 'Ana' }, business_name: 'Cool Air', items: [ITEM()] }, error: null });
    const r = await fetchPortalInventory(TOKEN);
    expect(rpc).toHaveBeenCalledWith('get_portal_home_inventory', { p_token: TOKEN });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.data.items).toHaveLength(1);
      expect(r.data.reminders).toEqual([]); // missing arrays never crash the page
      expect(r.data.summary.item_count).toBe(0);
    }
  });
  it('distinguishes "not available" from "failed"', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect((await fetchPortalInventory(TOKEN)).status).toBe('unavailable');
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await fetchPortalInventory(TOKEN)).status).toBe('error');
    rpc.mockRejectedValue(new Error('network'));
    expect((await fetchPortalInventory(TOKEN)).status).toBe('error');
  });
});

describe('RPC writes', () => {
  it('saves an item and sends file ids only when there are some', async () => {
    rpc.mockResolvedValue({ data: { id: 'i1', equipment_id: null, linked_by_serial: false }, error: null });
    await saveInventoryItem(TOKEN, null, { name: 'x' }, ['f1']);
    expect(rpc).toHaveBeenLastCalledWith('portal_inventory_save_item', { p_token: TOKEN, p_item_id: null, p_fields: { name: 'x' }, p_file_ids: ['f1'] });
    await saveInventoryItem(TOKEN, 'i1', { name: 'x' });
    expect(rpc).toHaveBeenLastCalledWith('portal_inventory_save_item', { p_token: TOKEN, p_item_id: 'i1', p_fields: { name: 'x' }, p_file_ids: null });
  });
  it('turns database errors into friendly InventoryErrors and a dead link into code "unavailable"', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'HI_INVALID_DATE' } });
    await expect(saveInventoryItem(TOKEN, null, {})).rejects.toBeInstanceOf(InventoryError);
    await expect(saveInventoryItem(TOKEN, null, {})).rejects.toThrow();
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(saveInventoryItem(TOKEN, null, {})).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('adds reminders and applies reminder actions', async () => {
    rpc.mockResolvedValue({ data: { id: 'r9' }, error: null });
    await addInventoryReminder(TOKEN, 'i1', 'Change filter', '2026-12-01', 3);
    expect(rpc).toHaveBeenLastCalledWith('portal_inventory_add_reminder', { p_token: TOKEN, p_item_id: 'i1', p_title: 'Change filter', p_due_date: '2026-12-01', p_interval_months: 3 });
    await reminderAction(TOKEN, 'r1', 'snooze', 14);
    expect(rpc).toHaveBeenLastCalledWith('portal_inventory_reminder_action', { p_token: TOKEN, p_reminder_id: 'r1', p_action: 'snooze', p_days: 14 });
    await reminderAction(TOKEN, 'r1', 'done');
    expect(rpc).toHaveBeenLastCalledWith('portal_inventory_reminder_action', { p_token: TOKEN, p_reminder_id: 'r1', p_action: 'done', p_days: null });
  });
});

describe('edge function calls', () => {
  const file = (name = 'receipt.jpg', type = 'image/jpeg') => new File([new Uint8Array([1, 2, 3, 4])], name, { type });

  it('uploads in three steps — sign, direct upload, register — and returns the read', async () => {
    invoke
      .mockResolvedValueOnce({ data: { path: 'o/c/u.jpg', upload_token: 'tok' }, error: null })
      .mockResolvedValueOnce({ data: { file: { id: 'f1' }, duplicate: false, read: { suggestion: SUGGESTION }, warning: null }, error: null });
    uploadToSignedUrl.mockResolvedValue({ error: null });

    const r = await uploadInventoryFile(TOKEN, file(), { kind: 'receipt', itemId: 'i1' });
    expect(r.read?.suggestion.name).toBe('Carrier 24ACC636');
    expect(invoke.mock.calls[0]).toEqual(['portal-home-inventory', { body: { token: TOKEN, action: 'sign_upload', kind: 'receipt', mime: 'image/jpeg', bytes: 4 } }]);
    expect(uploadToSignedUrl.mock.calls[0][0]).toBe('o/c/u.jpg');
    expect(uploadToSignedUrl.mock.calls[0][1]).toBe('tok');
    expect(uploadToSignedUrl.mock.calls[0][3]).toEqual({ contentType: 'image/jpeg' });
    expect(invoke.mock.calls[1][1].body).toMatchObject({ token: TOKEN, action: 'register', kind: 'receipt', path: 'o/c/u.jpg', name: 'receipt.jpg', itemId: 'i1' });
  });

  it('rejects an unsupported file before touching the network', async () => {
    await expect(uploadInventoryFile(TOKEN, file('x.svg', 'image/svg+xml'), { kind: 'other' })).rejects.toBeInstanceOf(InventoryError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not register when the direct upload fails', async () => {
    invoke.mockResolvedValueOnce({ data: { path: 'o/c/u.jpg', upload_token: 'tok' }, error: null });
    uploadToSignedUrl.mockResolvedValue({ error: { message: 'nope' } });
    await expect(uploadInventoryFile(TOKEN, file(), { kind: 'receipt' })).rejects.toThrow('upload did not finish');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('surfaces the server’s own message and status from a non-2xx reply', async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(JSON.stringify({ error: 'Too many uploads in a short time.', code: 'rate_limited' }), { status: 429 }) } });
    await expect(uploadInventoryFile(TOKEN, file(), { kind: 'receipt' })).rejects.toMatchObject({ message: 'Too many uploads in a short time.', status: 429, code: 'rate_limited' });
  });

  it('handles a network failure that has no response body', async () => {
    invoke.mockResolvedValueOnce({ data: null, error: new Error('Failed to fetch') });
    await expect(getInventoryFileUrl(TOKEN, 'f1')).rejects.toThrow('Could not reach the server');
  });

  it('views and deletes through the function', async () => {
    invoke.mockResolvedValue({ data: { url: 'https://signed/x', ok: true }, error: null });
    expect(await getInventoryFileUrl(TOKEN, 'f1')).toBe('https://signed/x');
    await deleteInventoryFile(TOKEN, 'f1');
    expect(invoke).toHaveBeenLastCalledWith('portal-home-inventory', { body: { token: TOKEN, action: 'delete_file', fileId: 'f1' } });
    await deleteInventoryItem(TOKEN, 'i1');
    expect(invoke).toHaveBeenLastCalledWith('portal-home-inventory', { body: { token: TOKEN, action: 'delete_item', itemId: 'i1' } });
  });
});
