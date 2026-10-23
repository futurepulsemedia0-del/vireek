import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENDPOINTS,
  ENDPOINT_KEYS,
  MAX_ATTEMPTS,
  PM_PROVIDERS,
  PROVIDER_META,
  authHeaders,
  buildNewWorkOrder,
  buildRestRequest,
  buildYardiGetRequests,
  classifyHttp,
  defaultSettings,
  endpointFor,
  invoiceVars,
  isAllowedBase,
  listVars,
  mapApprovalIn,
  mapStatusIn,
  missingInvoiceInputs,
  parsePage,
  parseRetryAfter,
  parseYardiServiceRequests,
  planWorkOrderSync,
  readPath,
  renderTemplate,
  retryDelayMs,
  scrub,
  statusVars,
  toCanonWorkOrder,
  toCents,
  toWoValues,
  validateCredentials,
  validateEndpointSpec,
  validateSettings,
  type PmProvider,
  type WoValues,
} from '../../supabase/functions/_shared/pm/engine';

const BUILDIUM_CREDS = { client_id: 'cid-123', client_secret: 'sek-456789', environment: 'sandbox' };

function wo(over: Partial<WoValues> = {}): WoValues {
  return {
    title: 'Leaking sink',
    description: 'Kitchen sink leaks',
    po_number: 'PO-1',
    site_name: 'Oak Court · Unit 4B',
    site_address: '1 Oak St',
    site_contact_name: 'Dana Tenant',
    site_contact_phone: '555-0100',
    site_contact_email: 'dana@example.com',
    not_to_exceed_cents: 50_000,
    approval_status: 'approved',
    approver_name: 'Pat PM',
    status: 'scheduled',
    ...over,
  };
}

describe('credentials + host allow-list', () => {
  it('accepts Buildium keys and picks the right base', () => {
    const prod = validateCredentials('buildium', { ...BUILDIUM_CREDS, environment: 'production' });
    const sand = validateCredentials('buildium', BUILDIUM_CREDS);
    expect(prod.ok && prod.apiBase).toBe('https://api.buildium.com/v1');
    expect(sand.ok && sand.apiBase).toBe('https://apisandbox.buildium.com/v1');
  });

  it('requires every non-optional field', () => {
    const r = validateCredentials('buildium', { client_id: 'x' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Client secret/);
  });

  it('builds the Propertyware base and validates the organization id', () => {
    const ok = validateCredentials('propertyware', { client_id: 'a', client_secret: 'b', organization_id: '1234' });
    expect(ok.ok && ok.apiBase).toBe('https://api.propertyware.com/pw/api/rest/v1');
    expect(validateCredentials('propertyware', { client_id: 'a', client_secret: 'b', organization_id: '12 34' }).ok).toBe(false);
  });

  it('only accepts a bare subdomain for Rentvine and AppFolio', () => {
    const rv = validateCredentials('rentvine', { subdomain: 'Acme', api_key: 'k', api_secret: 's' });
    expect(rv.ok && rv.apiBase).toBe('https://acme.rentvine.com/api/manager');
    for (const bad of ['evil.com/x', 'a.b', 'acme.rentvine.com', '-x', 'a b']) {
      expect(validateCredentials('rentvine', { subdomain: bad, api_key: 'k', api_secret: 's' }).ok).toBe(false);
      expect(validateCredentials('appfolio', { subdomain: bad, client_id: 'k', client_secret: 's' }).ok).toBe(false);
    }
    const af = validateCredentials('appfolio', { subdomain: 'acme', client_id: 'k', client_secret: 's' });
    expect(af.ok && af.apiBase).toBe('https://acme.appfolio.com');
  });

  it('rejects control characters and absurd lengths', () => {
    expect(validateCredentials('buildium', { client_id: 'a\nb', client_secret: 's' }).ok).toBe(false);
    expect(validateCredentials('buildium', { client_id: 'a'.repeat(601), client_secret: 's' }).ok).toBe(false);
  });

  it('refuses hosts that could receive secrets by trickery', () => {
    expect(isAllowedBase('buildium', 'https://api.buildium.com/v1')).toBe(true);
    expect(isAllowedBase('buildium', 'http://api.buildium.com/v1')).toBe(false);
    expect(isAllowedBase('buildium', 'https://api.buildium.com@evil.com/v1')).toBe(false);
    expect(isAllowedBase('buildium', 'https://evil.com/api.buildium.com')).toBe(false);
    expect(isAllowedBase('buildium', 'https://api.buildium.com.evil.com/v1')).toBe(false);
    expect(isAllowedBase('buildium', 'https://api.buildium.com:8443/v1')).toBe(false);
    expect(isAllowedBase('buildium', 'not a url')).toBe(false);
  });

  it('Yardi: needs a recognised Yardi host, with an explicit operator escape hatch for on-prem', () => {
    const base = { username: 'u', password: 'p', server_name: 's', database: 'd', platform: 'SQL Server', interface_entity: 'e', interface_license: 'l' };
    const hosted = validateCredentials('yardi', { ...base, server_url: 'https://www.yardiaspx14.com/12345/Webservices/ItfServiceRequests.asmx' });
    expect(hosted.ok).toBe(true);
    const evil = { ...base, server_url: 'https://pm.example.com/Webservices/ItfServiceRequests.asmx' };
    expect(validateCredentials('yardi', evil).ok).toBe(false);
    expect(validateCredentials('yardi', evil, ['pm.example.com']).ok).toBe(true);
    expect(validateCredentials('yardi', { ...base, server_url: 'https://www.yardiaspx14.com/x/Other.aspx' }).ok).toBe(false);
  });

  it('every provider documents credentials, steps and an access level', () => {
    for (const p of PM_PROVIDERS) {
      const m = PROVIDER_META[p];
      expect(m.steps.length).toBeGreaterThan(2);
      expect(m.credentials.length).toBeGreaterThan(1);
      expect(m.docsUrl).toMatch(/^https:\/\//);
    }
    expect(PROVIDER_META.yardi.access).toBe('partner_gated');
    expect(PROVIDER_META.appfolio.access).toBe('partner_gated');
  });
});

describe('auth headers + request building', () => {
  it('uses each provider’s own header scheme', () => {
    expect(authHeaders('buildium', BUILDIUM_CREDS)).toEqual({ 'x-buildium-client-id': 'cid-123', 'x-buildium-client-secret': 'sek-456789' });
    const pw = authHeaders('propertyware', { client_id: 'a', client_secret: 'b', organization_id: '9' });
    expect(pw['x-propertyware-system-id']).toBe('9');
    expect(authHeaders('rentvine', { api_key: 'k', api_secret: 's' }).Authorization).toBe(`Basic ${btoa('k:s')}`);
    expect(authHeaders('appfolio', { client_id: 'k', client_secret: 's' }).Authorization).toBe(`Basic ${btoa('k:s')}`);
  });

  it('never puts credentials in the URL', () => {
    const spec = endpointFor('buildium', defaultSettings('buildium'), 'workOrders')!;
    const req = buildRestRequest('buildium', BUILDIUM_CREDS, 'https://apisandbox.buildium.com/v1', spec, listVars(null, '2027-01-01T00:00:00.000Z'));
    expect(req.url).not.toContain('sek-456789');
    expect(req.url).not.toContain('cid-123');
    expect(req.headers['x-buildium-client-secret']).toBe('sek-456789');
  });

  it('pages with limit/offset and drops the since filter on a first sync', () => {
    const spec = endpointFor('buildium', defaultSettings('buildium'), 'workOrders')!;
    const first = buildRestRequest('buildium', BUILDIUM_CREDS, 'https://api.buildium.com/v1', spec, listVars(null, null));
    expect(first.url).toBe('https://api.buildium.com/v1/workorders?limit=100&offset=0');
    const next = buildRestRequest('buildium', BUILDIUM_CREDS, 'https://api.buildium.com/v1', spec, listVars('200', '2027-01-01T00:00:00Z'));
    expect(next.url).toContain('offset=200');
    expect(next.url).toContain('lastupdatedfrom=2027-01-01T00%3A00%3A00Z');
  });

  it('removes {since} keys from a POST body on a first sync (AppFolio)', () => {
    const spec = endpointFor('appfolio', defaultSettings('appfolio'), 'workOrders')!;
    const a = buildRestRequest('appfolio', { client_id: 'k', client_secret: 's' }, 'https://x.appfolio.com', spec, listVars(null, null));
    const b = buildRestRequest('appfolio', { client_id: 'k', client_secret: 's' }, 'https://x.appfolio.com', spec, listVars(null, '2027-02-01T00:00:00Z'));
    expect(a.body).toBe('{}');
    expect(b.body).toBe('{"updated_from":"2027-02-01T00:00:00Z"}');
    expect(a.headers['Content-Type']).toBe('application/json');
  });

  it('url-encodes the record id into paths', () => {
    const spec = endpointFor('buildium', defaultSettings('buildium'), 'pushStatus')!;
    const req = buildRestRequest('buildium', BUILDIUM_CREDS, 'https://api.buildium.com/v1', spec, { id: '12/../3' });
    expect(req.url).toBe('https://api.buildium.com/v1/workorders/12%2F..%2F3');
  });

  it('renders templates, keeping numbers as numbers', () => {
    const out = renderTemplate({ a: '{n}', b: 'x {s} y', c: ['{n}'], d: '{missing}' }, { n: 5, s: 'hi' });
    expect(out).toEqual({ a: 5, b: 'x hi y', c: [5], d: null });
  });

  it('every shipped default endpoint passes its own validator', () => {
    for (const p of PM_PROVIDERS) {
      for (const k of ENDPOINT_KEYS) {
        const spec = DEFAULT_ENDPOINTS[p][k];
        if (spec) expect(validateEndpointSpec(spec, k)).toBeTruthy();
      }
    }
  });

  it('validates user supplied endpoints', () => {
    expect(validateEndpointSpec({ method: 'GET', path: '/a/{id}' }, 'workOrders')).toBeTruthy();
    expect(validateEndpointSpec({ method: 'GET', path: '/a' }, 'pushStatus')).toBeNull();
    expect(validateEndpointSpec({ method: 'GET', path: 'a' }, 'workOrders')).toBeNull();
    expect(validateEndpointSpec({ method: 'GET', path: '/a/../b' }, 'workOrders')).toBeNull();
    expect(validateEndpointSpec({ method: 'GET', path: '//evil.com/x' }, 'workOrders')).toBeNull();
    expect(validateEndpointSpec({ method: 'DELETE', path: '/a' }, 'pushStatus')).toBeNull();
    expect(validateEndpointSpec({ method: 'PUT', path: '/a', body: { x: 'y'.repeat(5000) } }, 'pushStatus')).toBeNull();
  });
});

describe('response paging', () => {
  const spec = { method: 'GET' as const, path: '/x', paging: 'offset' as const };
  it('reads a bare array, a wrapped array and an itemsPath', () => {
    expect(parsePage([{ Id: 1 }], spec, null).items).toHaveLength(1);
    expect(parsePage({ Items: 'no', results: [{ id: 1 }, { id: 2 }] }, spec, null).items).toHaveLength(2);
    expect(parsePage({ a: { b: [{ id: 1 }] } }, { ...spec, itemsPath: 'a.b' }, null).items).toHaveLength(1);
    expect(parsePage(null, spec, null).items).toEqual([]);
    expect(parsePage([1, 'x', null, { id: 1 }], spec, null).items).toHaveLength(1);
  });
  it('continues only on a full page and never when paging is none', () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    expect(parsePage(full, spec, null).nextCursor).toBe('100');
    expect(parsePage(full, spec, '300').nextCursor).toBe('400');
    expect(parsePage(full.slice(0, 99), spec, null).nextCursor).toBeNull();
    expect(parsePage(full, { ...spec, paging: 'none' }, null).nextCursor).toBeNull();
  });
});

describe('field reading + canonical mapping', () => {
  it('readPath is case-insensitive, supports alternatives and joins', () => {
    const o = { Property: { Name: 'Oak' }, firstname: 'Dana', LastName: 'T', n: 5, empty: '  ' };
    expect(readPath(o, 'property.name')).toBe('Oak');
    expect(readPath(o, 'missing|n')).toBe('5');
    expect(readPath(o, 'empty|Property.Name')).toBe('Oak');
    expect(readPath(o, 'FirstName+LastName')).toBe('Dana T');
    expect(readPath(o, 'nope.deeper')).toBeNull();
    expect(readPath(null, 'a')).toBeNull();
  });

  const buildiumRaw = {
    Id: 9001,
    Title: 'Leaking sink',
    Description: 'Kitchen sink leaks',
    Status: 'InProgress',
    Property: { Id: 77, Name: 'Oak Court', Address: { AddressLine1: '1 Oak St' } },
    UnitNumber: '4B',
    RequestedByUserEntity: { FirstName: 'Dana', LastName: 'Tenant', Email: 'DANA@Example.com', PhoneNumber: '(555) 010-0100' },
    NotToExceedAmount: '$1,250.50',
    ApprovalStatus: 'Authorized',
    LastUpdatedDateTime: '2027-03-01T10:00:00Z',
  };

  it('maps a Buildium-shaped work order into Vireek columns', () => {
    const s = defaultSettings('buildium');
    const { values, unknownStatus } = toWoValues(toCanonWorkOrder(buildiumRaw, s), s);
    expect(values).toEqual({
      title: 'Leaking sink',
      description: 'Kitchen sink leaks',
      po_number: null,
      site_name: 'Oak Court · Unit 4B',
      site_address: '1 Oak St',
      site_contact_name: 'Dana Tenant',
      site_contact_phone: '(555) 010-0100',
      site_contact_email: 'dana@example.com',
      not_to_exceed_cents: 125_050,
      approval_status: 'approved',
      approver_name: null,
      status: 'in_progress',
    });
    expect(unknownStatus).toBeNull();
  });

  it('uses the provider number as the PO when none is given (and can be switched off)', () => {
    const s = defaultSettings('buildium');
    const raw = { Id: 1, WorkOrderNumber: 'WO-778', Title: 't' };
    expect(toWoValues(toCanonWorkOrder(raw, s), s).values.po_number).toBe('WO-778');
    expect(toWoValues(toCanonWorkOrder({ ...raw, PurchaseOrderNumber: 'PO-9' }, s), s).values.po_number).toBe('PO-9');
    const off = { ...s, usePmNumberAsPo: false };
    expect(toWoValues(toCanonWorkOrder(raw, off), off).values.po_number).toBeNull();
  });

  it('falls back safely: title, unknown statuses, default approval, bad money, long text', () => {
    const s = defaultSettings('buildium');
    const r = toWoValues(toCanonWorkOrder({ Id: 5, Status: 'Weird', NotToExceedAmount: 'n/a', Description: 'x'.repeat(6000) }, s), s);
    expect(r.values.title).toBe('Work order 5');
    expect(r.values.status).toBe('draft');
    expect(r.unknownStatus).toBe('Weird');
    expect(r.values.approval_status).toBe('pending');
    expect(r.values.not_to_exceed_cents).toBeNull();
    expect(r.values.description).toHaveLength(5000);
  });

  it('status and approval maps honour per-connection overrides', () => {
    const s = { ...defaultSettings('buildium'), statusIn: { onsitevisit: 'in_progress' as const }, approvalIn: { greenlight: 'approved' as const } };
    expect(mapStatusIn('On-Site Visit', s)).toEqual({ status: 'in_progress', known: true });
    expect(mapStatusIn('In Progress', s).status).toBe('in_progress');
    expect(mapStatusIn(null, s).known).toBe(false);
    expect(mapApprovalIn('Green Light', s)).toBe('approved');
    expect(mapApprovalIn('Denied', s)).toBe('rejected');
    expect(mapApprovalIn(null, { ...s, defaultApproval: 'not_required' })).toBe('not_required');
  });

  it('a new work order is never created already started without approval', () => {
    expect(buildNewWorkOrder(wo({ status: 'in_progress', approval_status: 'pending' })).status).toBe('scheduled');
    expect(buildNewWorkOrder(wo({ status: 'completed', approval_status: 'approved' })).status).toBe('completed');
  });

  it('toCents', () => {
    expect(toCents('1,234.50')).toBe(123_450);
    expect(toCents(99)).toBe(9900);
    expect(toCents('$0')).toBe(0);
    expect(toCents('')).toBeNull();
    expect(toCents('abc')).toBeNull();
    expect(toCents(-5)).toBeNull();
    expect(toCents(99_999_999_999)).toBeNull();
  });
});

describe('reconciliation planner', () => {
  const base = { ...wo(), status: 'scheduled' as const };

  it('does nothing when nothing changed', () => {
    const p = planWorkOrderSync(base, wo(), wo());
    expect(p.patch).toEqual({});
    expect(p.pushStatus).toBeNull();
    expect(p.notes).toEqual([]);
  });

  it('provider-owned fields: provider change wins, local edits are left alone', () => {
    const changed = planWorkOrderSync(base, wo({ title: 'Burst pipe' }), wo());
    expect(changed.patch).toEqual({ title: 'Burst pipe' });
    expect(changed.nextBase.title).toBe('Burst pipe');
    const localEdit = planWorkOrderSync(base, wo(), wo({ title: 'My edit' }));
    expect(localEdit.patch).toEqual({});
  });

  it('only writes fields that actually differ from Vireek', () => {
    const p = planWorkOrderSync(base, wo({ title: 'New' }), wo({ title: 'New' }));
    expect(p.patch).toEqual({});
  });

  it('status: provider moves on, Vireek unchanged → apply', () => {
    const p = planWorkOrderSync(base, wo({ status: 'completed' }), wo());
    expect(p.patch.status).toBe('completed');
    expect(p.pushStatus).toBeNull();
    expect(p.nextBase.status).toBe('completed');
  });

  it('status: Vireek moved on, provider unchanged → push', () => {
    const p = planWorkOrderSync(base, wo(), wo({ status: 'in_progress' }));
    expect(p.pushStatus).toBe('in_progress');
    expect(p.patch.status).toBeUndefined();
    expect(p.nextBase.status).toBe('scheduled');
  });

  it('status: both moved → Vireek wins, except a provider cancellation', () => {
    const vireekWins = planWorkOrderSync(base, wo({ status: 'draft' }), wo({ status: 'in_progress' }));
    expect(vireekWins.pushStatus).toBe('in_progress');
    expect(vireekWins.notes.length).toBe(1);
    const cancelled = planWorkOrderSync(base, wo({ status: 'cancelled' }), wo({ status: 'in_progress' }));
    expect(cancelled.patch.status).toBe('cancelled');
    expect(cancelled.pushStatus).toBeNull();
  });

  it('echo guard: after a push the next sync is a no-op', () => {
    const afterPush = { ...wo(), status: 'in_progress' as const };
    const p = planWorkOrderSync(afterPush, wo({ status: 'in_progress' }), wo({ status: 'in_progress' }));
    expect(p.patch).toEqual({});
    expect(p.pushStatus).toBeNull();
  });

  it('never starts work before approval (mirrors the DB trigger)', () => {
    const pending = wo({ approval_status: 'pending', status: 'scheduled' });
    const p = planWorkOrderSync({ ...pending }, wo({ approval_status: 'pending', status: 'in_progress' }), pending);
    expect(p.patch.status).toBeUndefined();
    expect(p.notes.join(' ')).toMatch(/approved/);
    expect(p.nextBase.status).toBe('scheduled');
  });

  it('approval granted and work started in the same sync is applied together', () => {
    const vv = wo({ approval_status: 'pending', status: 'scheduled' });
    const p = planWorkOrderSync({ ...vv }, wo({ approval_status: 'approved', status: 'in_progress' }), vv);
    expect(p.patch.approval_status).toBe('approved');
    expect(p.patch.status).toBe('in_progress');
  });

  it('refuses to withdraw approval after work started and says so', () => {
    const vv = wo({ approval_status: 'approved', status: 'in_progress' });
    const p = planWorkOrderSync({ ...vv }, wo({ approval_status: 'rejected', status: 'in_progress' }), vv);
    expect(p.patch.approval_status).toBeUndefined();
    expect(p.notes.join(' ')).toMatch(/already started/);
  });

  it('adopting an existing work order keeps Vireek’s status and pushes it when it differs', () => {
    const vv = wo({ status: 'completed' });
    const adopt = planWorkOrderSync({}, wo({ status: 'scheduled' }), vv);
    expect(adopt.patch.status).toBeUndefined();
    expect(adopt.pushStatus).toBe('completed');
    expect(planWorkOrderSync({}, wo(), wo()).pushStatus).toBeNull();
  });
});

describe('outbound payloads', () => {
  it('status vars use the configured provider words', () => {
    const s = { ...defaultSettings('buildium'), statusOut: { ...defaultSettings('buildium').statusOut, in_progress: 'Working' } };
    const req = buildRestRequest('buildium', BUILDIUM_CREDS, 'https://api.buildium.com/v1', endpointFor('buildium', s, 'pushStatus')!, statusVars(s, 'in_progress', { id: '42' }));
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://api.buildium.com/v1/workorders/42');
    expect(JSON.parse(req.body!)).toEqual({ Status: 'Working' });
  });

  it('builds a Buildium bill with typed numbers and a due date', () => {
    const s = { ...defaultSettings('buildium'), invoice: { dueDays: 15, constants: { vendor_id: '37', gl_account_id: '12', entity_type: 'Rental' } } };
    const vars = invoiceVars(s, { amountCents: 123_456, invoiceNumber: 'INV-0001', description: 'Visit 1', propertyId: '77', today: new Date('2027-03-01T12:00:00Z') });
    expect(missingInvoiceInputs('buildium', vars)).toEqual([]);
    const req = buildRestRequest('buildium', BUILDIUM_CREDS, 'https://api.buildium.com/v1', endpointFor('buildium', s, 'pushInvoice')!, vars);
    const body = JSON.parse(req.body!);
    expect(req.url).toBe('https://api.buildium.com/v1/bills');
    expect(body.Date).toBe('2027-03-01');
    expect(body.DueDate).toBe('2027-03-16');
    expect(body.VendorId).toBe(37);
    expect(body.ReferenceNumber).toBe('INV-0001');
    expect(body.Lines[0]).toEqual({ AccountingEntity: { Id: 77, AccountingEntityType: 'Rental' }, GlAccountId: 12, Amount: 1234.56, Memo: 'Visit 1' });
  });

  it('reports exactly which invoice inputs are missing', () => {
    const vars = invoiceVars(defaultSettings('buildium'), { amountCents: 100, invoiceNumber: 'x', description: 'd', propertyId: null, today: new Date() });
    expect(missingInvoiceInputs('buildium', vars)).toEqual(['vendor_id', 'gl_account_id', 'property_id']);
  });
});

describe('settings validation', () => {
  it('empty settings → provider defaults, with writes OFF and dry-run ON', () => {
    for (const p of PM_PROVIDERS) {
      const r = validateSettings(p as PmProvider, {});
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.settings.push).toEqual({ status: false, invoices: false, dryRun: true });
        expect(r.settings.defaultApproval).toBe('pending');
      }
    }
  });

  it('only lets you switch on writes the provider has an endpoint for', () => {
    expect(validateSettings('buildium', { push: { status: true, invoices: true, dryRun: true } }).ok).toBe(true);
    const rv = validateSettings('rentvine', { push: { status: true } });
    expect(rv.ok).toBe(false);
    const withEp = validateSettings('rentvine', { push: { status: true }, endpoints: { pushStatus: { method: 'PATCH', path: '/maintenance/work-orders/{id}', body: { statusId: '{status}' } } } });
    expect(withEp.ok).toBe(true);
    expect(validateSettings('propertyware', { push: { invoices: true } }).ok).toBe(false);
  });

  it('rejects bad mappings, statuses and constants', () => {
    expect(validateSettings('buildium', { mapping: { workOrder: { title: 'a;b' } } }).ok).toBe(false);
    expect(validateSettings('buildium', { statusIn: { x: 'bogus' } }).ok).toBe(false);
    expect(validateSettings('buildium', { statusOut: { draft: 'bad<>' } }).ok).toBe(false);
    expect(validateSettings('buildium', { invoice: { constants: { vendor_id: 'abc' } } }).ok).toBe(false);
    expect(validateSettings('buildium', { endpoints: { workOrders: { method: 'GET', path: 'nope' } } }).ok).toBe(false);
    expect(validateSettings('buildium', 'x').ok).toBe(false);
  });

  it('keeps defaults for fields it was not given and normalises status keys', () => {
    const r = validateSettings('buildium', { statusIn: { 'On Site': 'in_progress' }, backfillDays: 9999 });
    expect(r.ok && r.settings.statusIn).toEqual({ onsite: 'in_progress' });
    expect(r.ok && r.settings.backfillDays).toBe(365);
    expect(r.ok && r.settings.mapping.workOrder.title).toBe(defaultSettings('buildium').mapping.workOrder.title);
  });
});

describe('retry queue maths', () => {
  it('classifies HTTP outcomes', () => {
    expect(classifyHttp(200).outcome).toBe('ok');
    expect(classifyHttp(204).outcome).toBe('ok');
    expect(classifyHttp(401).outcome).toBe('auth');
    expect(classifyHttp(403).outcome).toBe('permanent');
    expect(classifyHttp(404).outcome).toBe('permanent');
    expect(classifyHttp(422).outcome).toBe('permanent');
    expect(classifyHttp(429).outcome).toBe('retry');
    expect(classifyHttp(503).outcome).toBe('retry');
    expect(classifyHttp(408).outcome).toBe('retry');
  });

  it('backs off exponentially, with jitter, capped at six hours', () => {
    const lo = () => 0;
    const hi = () => 1;
    expect(retryDelayMs(1, null, lo)).toBe(24_000);
    expect(retryDelayMs(1, null, hi)).toBe(36_000);
    expect(retryDelayMs(2, null, () => 0.5)).toBe(60_000);
    expect(retryDelayMs(3, null, () => 0.5)).toBe(120_000);
    expect(retryDelayMs(20, null, hi)).toBeLessThanOrEqual(6 * 3_600_000 * 1.2);
    let prev = 0;
    for (let a = 1; a <= MAX_ATTEMPTS; a++) {
      const d = retryDelayMs(a, null, () => 0.5);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('honours Retry-After when it is longer', () => {
    expect(retryDelayMs(1, 600, () => 0.5)).toBe(600_000);
    expect(retryDelayMs(1, 1, () => 0.5)).toBe(30_000);
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:26:00 GMT'))).toBe(120);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('scrubs credentials out of anything logged', () => {
    const text = `bad key sek-456789 and Basic ${btoa('cid-123:sek-456789')} failed`;
    const out = scrub(text, BUILDIUM_CREDS);
    expect(out).not.toContain('sek-456789');
    expect(out).not.toContain('cid-123');
    expect(out).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}/);
    expect(scrub('x'.repeat(1000), {})).toHaveLength(300);
  });
});

describe('Yardi SOAP (read only)', () => {
  const creds = { server_url: 'https://www.yardiaspx14.com/1/Webservices/ItfServiceRequests.asmx', username: 'u', password: 'p<&>', server_name: 's', database: 'd', platform: 'SQL Server', interface_entity: 'e', interface_license: 'l', property_codes: 'p1, p2' };

  it('builds one request per property code and escapes XML', () => {
    const reqs = buildYardiGetRequests(creds);
    expect(reqs).toHaveLength(2);
    expect(reqs[0].body).toContain('<YardiPropertyId>p1</YardiPropertyId>');
    expect(reqs[1].body).toContain('<YardiPropertyId>p2</YardiPropertyId>');
    expect(reqs[0].body).toContain('<Password>p&lt;&amp;&gt;</Password>');
    expect(reqs[0].headers.SOAPAction).toMatch(/GetServiceRequests_Login$/);
    expect(buildYardiGetRequests({ ...creds, property_codes: '' })).toHaveLength(1);
  });

  it('parses plain and escaped service request documents', () => {
    const plain = '<r><ServiceRequest><ServiceRequestId>10</ServiceRequestId><Status>Open</Status><UnitCode>4B</UnitCode></ServiceRequest></r>';
    expect(parseYardiServiceRequests(plain)).toEqual([{ ServiceRequestId: '10', Status: 'Open', UnitCode: '4B' }]);
    const escaped =
      '<soap:Body><Result>&lt;ServiceRequests&gt;&lt;ServiceRequest&gt;&lt;ServiceRequestId&gt;11&lt;/ServiceRequestId&gt;&lt;ProblemDescription&gt;Heat &amp;amp; AC&lt;/ProblemDescription&gt;&lt;/ServiceRequest&gt;&lt;/ServiceRequests&gt;</Result></soap:Body>';
    const rows = parseYardiServiceRequests(escaped);
    expect(rows).toHaveLength(1);
    expect(rows[0].ServiceRequestId).toBe('11');
    expect(rows[0].ProblemDescription).toBe('Heat & AC');
    expect(parseYardiServiceRequests('<empty/>')).toEqual([]);
  });

  it('turns a SOAP fault into a clear error', () => {
    expect(() => parseYardiServiceRequests('<soap:Fault><faultstring>nope</faultstring></soap:Fault>')).toThrow(/Yardi rejected/);
  });

  it('maps Yardi fields through the Yardi defaults', () => {
    const s = defaultSettings('yardi');
    const canon = toCanonWorkOrder({ ServiceRequestId: '11', ProblemDescription: 'No heat', Status: 'Open', PropertyCode: 'p1', UnitCode: '4B' }, s);
    expect(canon.external_id).toBe('11');
    expect(canon.title).toBe('No heat');
    expect(canon.unit_number).toBe('4B');
  });
});
