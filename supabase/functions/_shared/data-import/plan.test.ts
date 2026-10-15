import { describe, expect, it } from 'vitest';
import {
  mapInvoiceStatus, mapJobStatus, normalizeEmail, normalizePhone, parseDateTime, parseMoney, phoneKey,
} from './normalize';
import { planCustomers, planJobs, summarize } from './plan';
import type { ExistingCustomer, ExistingJob } from './v2types';

const cust = (over: Partial<ExistingCustomer>): ExistingCustomer => ({
  id: 'c1', name: 'Existing', phone: null, email: null, address: null, notes: null,
  customer_type: 'residential', external_source: null, external_id: null, ...over,
});

const MAP = { name: 'Name', phone: 'Phone', email: 'Email', address: 'Address', external_id: 'ID' };

describe('normalizers', () => {
  it('normalizes US phones to E.164 and matches across formats', () => {
    expect(normalizePhone('(555) 123-4567')?.e164).toBe('+15551234567');
    expect(normalizePhone('1-555-123-4567 x22')?.e164).toBe('+15551234567');
    expect(normalizePhone('+44 20 7946 0958')?.e164).toBe('+442079460958');
    expect(normalizePhone('12')).toBeNull();
    expect(phoneKey('555.123.4567')).toBe(normalizePhone('+1 555 123 4567')?.key);
  });

  it('validates emails and lowercases them', () => {
    expect(normalizeEmail(' Jo@Example.COM ')).toBe('jo@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
  });

  it('parses money in US and EU styles, negatives and junk', () => {
    expect(parseMoney('$1,234.50')).toBe(1234.5);
    expect(parseMoney('1.234,50')).toBe(1234.5);
    expect(parseMoney('(45.00)')).toBe(-45);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('call us')).toBeUndefined();
  });

  it('interprets wall-clock dates in the business timezone (DST aware)', () => {
    expect(parseDateTime('3/14/2024 2:30 PM', 'America/New_York')).toBe('2024-03-14T18:30:00.000Z'); // EDT
    expect(parseDateTime('2024-01-15 09:00', 'America/New_York')).toBe('2024-01-15T14:00:00.000Z'); // EST
    expect(parseDateTime('2024-03-14T10:00:00Z', 'America/Chicago')).toBe('2024-03-14T10:00:00.000Z');
    expect(parseDateTime('Mar 14, 2024 2:30 PM', 'UTC')).toBe('2024-03-14T14:30:00.000Z');
    expect(parseDateTime('12/32/2024', 'UTC')).toBeUndefined();
    expect(parseDateTime('', 'UTC')).toBeNull();
  });

  it('maps competitor statuses', () => {
    expect(mapJobStatus('Complete Rated')).toBe('completed');
    expect(mapJobStatus('Canceled')).toBe('cancelled');
    expect(mapJobStatus('On my way')).toBe('en_route');
    expect(mapJobStatus('???')).toBeUndefined();
    expect(mapInvoiceStatus('Past Due')).toBe('sent');
  });
});

describe('planCustomers', () => {
  it('creates valid rows and errors rows without a name', () => {
    const plan = planCustomers(
      [{ Name: 'Ana', Phone: '(555) 111-2222', Email: 'ana@x.com', Address: '1 Main St', ID: 'A1' }, { Name: '', Phone: '5553334444', Email: '', Address: '', ID: 'A2' }],
      MAP, 'jobber', 'fill_blanks', [],
    );
    expect(plan.map((p) => p.action)).toEqual(['create', 'error']);
    expect(plan[0].values).toMatchObject({ phone: '+15551112222', external_source: 'jobber', external_id: 'A1', lifecycle_stage: 'active', source: 'import' });
    expect(plan[1].issues[0].severity).toBe('error');
  });

  it('warns and drops invalid phone/email instead of failing the row', () => {
    const [row] = planCustomers([{ Name: 'Bo', Phone: 'abc', Email: 'bad', Address: '', ID: '' }], MAP, 'csv', 'skip', []);
    expect(row.action).toBe('create');
    expect(row.issues.filter((i) => i.severity === 'warning')).toHaveLength(2);
    expect(row.values.phone).toBeNull();
  });

  it('is idempotent: re-running the same file against its own imported data changes nothing', () => {
    const rows = [{ Name: 'Ana', Phone: '(555) 111-2222', Email: 'ana@x.com', Address: '1 Main St', ID: 'A1' }];
    const imported = cust({ id: 'c9', name: 'Ana', phone: '+15551112222', email: 'ana@x.com', address: '1 Main St', external_source: 'jobber', external_id: 'A1' });
    const [row] = planCustomers(rows, MAP, 'jobber', 'overwrite', [imported]);
    expect(row.action).toBe('skip');
    expect(row.matchedBy).toBe('external_id');
  });

  it('matches an existing customer by phone in a different format and links the external id', () => {
    const existing = cust({ id: 'c2', name: 'Ana Perez', phone: '555-111-2222', address: '1 Main St' });
    const [row] = planCustomers([{ Name: 'Ana P.', Phone: '+1 (555) 111-2222', Email: 'ana@x.com', Address: '', ID: 'A1' }], MAP, 'jobber', 'fill_blanks', [existing]);
    expect(row.action).toBe('update');
    expect(row.matchedBy).toBe('phone');
    expect(row.targetId).toBe('c2');
    // fill_blanks: keeps the name/phone/address, adds the email and the external link
    expect(row.values).toEqual({ email: 'ana@x.com', external_source: 'jobber', external_id: 'A1' });
    expect(row.before).toMatchObject({ email: null });
  });

  it('overwrite replaces differing values; skip leaves everything alone', () => {
    const existing = cust({ id: 'c2', name: 'Ana Perez', phone: '555-111-2222', address: 'Old Rd' });
    const rows = [{ Name: 'Ana Perez', Phone: '5551112222', Email: '', Address: '9 New Ave', ID: '' }];
    expect(planCustomers(rows, MAP, 'csv', 'overwrite', [existing])[0].values).toEqual({ address: '9 New Ave' });
    expect(planCustomers(rows, MAP, 'csv', 'skip', [existing])[0].action).toBe('skip');
  });

  it('treats different external ids as different people and drops the shared phone', () => {
    const spouse = cust({ id: 'c3', name: 'Sam', phone: '+15551112222', external_source: 'jobber', external_id: 'S1' });
    const [row] = planCustomers([{ Name: 'Sue', Phone: '5551112222', Email: '', Address: '', ID: 'S2' }], MAP, 'jobber', 'fill_blanks', [spouse]);
    expect(row.action).toBe('create');
    expect(row.values.phone).toBeNull();
    expect(row.issues.some((i) => i.severity === 'warning' && i.field === 'phone')).toBe(true);
  });

  it('skips in-file duplicates and points at the first row', () => {
    const plan = planCustomers(
      [{ Name: 'Ana', Phone: '5551112222', Email: '', Address: '', ID: '' }, { Name: 'Ana P', Phone: '(555) 111-2222', Email: '', Address: '', ID: '' }],
      MAP, 'csv', 'fill_blanks', [],
    );
    expect(plan.map((p) => p.action)).toEqual(['create', 'skip']);
    expect(plan[1]).toMatchObject({ matchedBy: 'in_file', duplicateOfRow: 2 });
    expect(summarize(plan)).toMatchObject({ create: 1, skip: 1, duplicates: 1 });
  });

  it('builds names from first/last/company and addresses from parts', () => {
    const [a, b] = planCustomers(
      [{ F: 'Ana', L: 'Perez', C: '', S: '1 Main St', T: 'Austin', ST: 'TX', Z: '73301' }, { F: '', L: '', C: 'Acme HVAC', S: '', T: '', ST: '', Z: '' }],
      { first_name: 'F', last_name: 'L', company: 'C', address: 'S', city: 'T', state: 'ST', zip: 'Z' }, 'housecall_pro', 'skip', [],
    );
    expect(a.values).toMatchObject({ name: 'Ana Perez', address: '1 Main St, Austin, TX 73301', customer_type: 'residential' });
    expect(b.values).toMatchObject({ name: 'Acme HVAC', customer_type: 'commercial' });
  });
});

describe('planJobs', () => {
  const JOB_MAP = { customer_name: 'Customer', customer_phone: 'Phone', service_type: 'Service', scheduled_datetime: 'When', invoice_amount: 'Total', job_status: 'Status', external_id: 'Job #' };
  const ctx = { customers: [cust({ id: 'c1', name: 'Ana Perez', phone: '+15551112222' })], existingJobs: [] as ExistingJob[], timezone: 'America/Chicago', nowMs: Date.parse('2026-01-01T00:00:00Z') };

  it('links to an existing customer by phone, maps statuses and parses dates/amounts', () => {
    const [row] = planJobs([{ Customer: 'A. Perez', Phone: '(555) 111-2222', Service: 'AC repair', When: '3/14/2024 2:30 PM', Total: '$450.00', Status: 'Done', 'Job #': 'J1' }], JOB_MAP, 'service_titan', 'fill_blanks', ctx);
    expect(row.action).toBe('create');
    expect(row.values).toMatchObject({ customer_id: 'c1', job_status: 'completed', invoice_amount: 450, invoice_status: 'paid', external_source: 'service_titan', external_id: 'J1', scheduled_datetime: '2024-03-14T19:30:00.000Z' });
  });

  it('errors on a missing customer name and warns on bad values without failing the row', () => {
    const [bad, warn] = planJobs(
      [{ Customer: '', Phone: '', Service: '', When: '', Total: '', Status: '', 'Job #': 'J2' }, { Customer: 'Zed', Phone: '', Service: 'Tune-up', When: 'someday', Total: 'n/a', Status: 'weird', 'Job #': 'J3' }],
      JOB_MAP, 'csv', 'skip', ctx,
    );
    expect(bad.action).toBe('error');
    expect(warn.action).toBe('create');
    expect(warn.issues.filter((i) => i.severity === 'warning').map((i) => i.field).sort()).toEqual(['invoice_amount', 'job_status', 'scheduled_datetime']);
  });

  it('dedupes jobs by external id and by fingerprint when there is no id', () => {
    const existingJobs: ExistingJob[] = [
      { id: 'j1', customer_id: 'c1', customer_name: 'Ana Perez', customer_phone: null, service_type: 'AC repair', address: null, scheduled_datetime: '2024-03-14T19:30:00+00:00', job_status: 'completed', invoice_amount: 450, invoice_status: 'paid', external_source: null, external_id: null },
      { id: 'j2', customer_id: null, customer_name: 'Zed', customer_phone: null, service_type: null, address: null, scheduled_datetime: null, job_status: 'completed', invoice_amount: null, invoice_status: 'paid', external_source: 'csv', external_id: 'J9' },
    ];
    const plan = planJobs(
      [{ Customer: 'Ana Perez', Phone: '', Service: 'AC repair', When: '3/14/2024 2:30 PM', Total: '450', Status: '', 'Job #': '' }, { Customer: 'Zed', Phone: '', Service: 'x', When: '', Total: '', Status: '', 'Job #': 'J9' }],
      JOB_MAP, 'csv', 'skip', { ...ctx, existingJobs },
    );
    expect(plan.map((p) => [p.action, p.matchedBy])).toEqual([['skip', 'fingerprint'], ['skip', 'external_id']]);
  });
});
