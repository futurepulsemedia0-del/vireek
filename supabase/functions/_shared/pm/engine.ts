// supabase/functions/_shared/pm/engine.ts
//
// PURE logic for the property-management integrations (Buildium, Propertyware, Rentvine,
// AppFolio, Yardi). No Deno / Node / Supabase imports on purpose: the SAME file runs in the
// edge function, in the browser (settings UI) and in vitest.
//
// What lives here
//   - provider catalog + the partner access each provider needs (shown in the UI and docs)
//   - credential validation and the allow-listed host each provider's secrets may be sent to
//   - REST request builders (auth headers, paging, templated writes) and response parsers
//   - field mapping (provider JSON -> canonical record -> Vireek work order columns)
//   - the work-order reconciliation planner (who wins which field) and the approval/NTE gates
//   - retry-queue maths (error classification, exponential backoff with jitter)

export type PmProvider = 'buildium' | 'propertyware' | 'rentvine' | 'appfolio' | 'yardi';
export const PM_PROVIDERS: PmProvider[] = ['buildium', 'propertyware', 'rentvine', 'appfolio', 'yardi'];

export type WoStatus = 'draft' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
export type Approval = 'not_required' | 'pending' | 'approved' | 'rejected';
export const WO_STATUSES: WoStatus[] = ['draft', 'scheduled', 'in_progress', 'completed', 'cancelled'];
export const APPROVALS: Approval[] = ['not_required', 'pending', 'approved', 'rejected'];

export type AccessLevel = 'self_serve' | 'plan_required' | 'partner_gated';
export type QueueKind = 'push_status' | 'push_invoice';
export type EndpointKey = 'workOrders' | 'units' | 'tenants' | 'pushStatus' | 'pushInvoice';
export const ENDPOINT_KEYS: EndpointKey[] = ['workOrders', 'units', 'tenants', 'pushStatus', 'pushInvoice'];

// ============================================================
// CATALOG
// ============================================================

export interface CredentialField {
  key: string;
  label: string;
  kind: 'text' | 'secret' | 'select';
  options?: string[];
  placeholder?: string;
  help?: string;
  optional?: boolean;
}

export interface ProviderMeta {
  label: string;
  tagline: string;
  access: AccessLevel;
  /** One-line requirement shown on the provider card. */
  requirement: string;
  /** Steps the customer (the property manager) has to complete before we can connect. */
  steps: string[];
  docsUrl: string;
  credentials: CredentialField[];
  /** What the shipped defaults support. Anything else needs `settings.endpoints` after sandbox validation. */
  defaults: { pull: boolean; units: boolean; tenants: boolean; pushStatus: boolean; pushInvoice: boolean };
}

export const PROVIDER_META: Record<PmProvider, ProviderMeta> = {
  buildium: {
    label: 'Buildium',
    tagline: 'Open API with a client ID and secret',
    access: 'plan_required',
    requirement: 'Buildium Premium plan with the Open API switched on',
    steps: [
      'The property manager turns on the Open API (Settings → Application settings → System preferences → API settings). It needs a Premium plan.',
      'They create an API key under Settings → Developer tools. Buildium shows a client ID and a secret (copy the secret immediately).',
      'Give the key only the permissions work orders, rentals/units, tenants and bills need.',
      'Paste the client ID and secret here. Use the sandbox environment first.',
    ],
    docsUrl: 'https://developer.buildium.com/',
    credentials: [
      { key: 'client_id', label: 'Client ID', kind: 'text' },
      { key: 'client_secret', label: 'Client secret', kind: 'secret' },
      { key: 'environment', label: 'Environment', kind: 'select', options: ['production', 'sandbox'], help: 'Start with sandbox.' },
    ],
    defaults: { pull: true, units: true, tenants: true, pushStatus: true, pushInvoice: true },
  },
  propertyware: {
    label: 'Propertyware',
    tagline: 'REST API with client ID, secret and organization ID',
    access: 'self_serve',
    requirement: 'API key created in Propertyware for your organization',
    steps: [
      'The property manager creates an API key in Propertyware (client ID + secret).',
      'They give you their organization (system) ID. A key only works for the organization it belongs to.',
      'Paste the client ID, secret and organization ID here.',
    ],
    docsUrl: 'https://app.propertyware.com/pw/apidocs/',
    credentials: [
      { key: 'client_id', label: 'Client ID', kind: 'text' },
      { key: 'client_secret', label: 'Client secret', kind: 'secret' },
      { key: 'organization_id', label: 'Organization ID', kind: 'text', help: 'Sent as x-propertyware-system-id.' },
    ],
    defaults: { pull: true, units: true, tenants: false, pushStatus: true, pushInvoice: false },
  },
  rentvine: {
    label: 'Rentvine',
    tagline: 'Open REST API with an API key and secret',
    access: 'self_serve',
    requirement: 'API key + secret created by the property manager, tied to a role',
    steps: [
      'The property manager creates a role limited to maintenance, units and tenants.',
      'In Rentvine: Settings → Users, Roles and API → API → New API Key, pick that role, save.',
      'Copy the key and secret immediately. The secret cannot be shown again.',
      'Paste the key, secret and their Rentvine subdomain here.',
    ],
    docsUrl: 'https://docs.rentvine.com',
    credentials: [
      { key: 'subdomain', label: 'Rentvine subdomain', kind: 'text', placeholder: 'acmeproperties', help: 'The part before .rentvine.com' },
      { key: 'api_key', label: 'API key', kind: 'text' },
      { key: 'api_secret', label: 'API secret', kind: 'secret' },
    ],
    defaults: { pull: true, units: true, tenants: true, pushStatus: false, pushInvoice: false },
  },
  appfolio: {
    label: 'AppFolio',
    tagline: 'Stack partner API (read), write access approved separately',
    access: 'partner_gated',
    requirement: 'AppFolio Stack partner access; writing work orders needs a separate approval',
    steps: [
      'Apply for AppFolio Stack partner access. Production access is gated and may have unit minimums.',
      'The property manager enables API access for your integration in their AppFolio account and issues a client ID and secret.',
      'Reading work orders works with API access. Writing status back needs write access plus AppFolio approval for work orders.',
      'Paste their AppFolio subdomain, client ID and secret here.',
    ],
    docsUrl: 'https://www.appfolio.com/stack',
    credentials: [
      { key: 'subdomain', label: 'AppFolio subdomain', kind: 'text', placeholder: 'acmeproperties', help: 'The part before .appfolio.com' },
      { key: 'client_id', label: 'Client ID', kind: 'text' },
      { key: 'client_secret', label: 'Client secret', kind: 'secret' },
    ],
    defaults: { pull: true, units: true, tenants: true, pushStatus: false, pushInvoice: false },
  },
  yardi: {
    label: 'Yardi Voyager',
    tagline: 'ITF SOAP interface (Service Requests)',
    access: 'partner_gated',
    requirement: 'Yardi Standard Interface partnership + a licensed Service Requests interface',
    steps: [
      'Join the Yardi interface partner program and sign the data-exchange agreement for the Service Requests interface.',
      'The property manager licenses the interface in Voyager and creates an interface user and security group.',
      'They send you the interface URL, username, password, server name, database, platform, interface entity and license.',
      'Validate everything in the Yardi sandbox before connecting production.',
    ],
    docsUrl: 'https://www.yardi.com/products/voyager/',
    credentials: [
      { key: 'server_url', label: 'Interface URL', kind: 'text', placeholder: 'https://www.yardiaspx14.com/12345/Webservices/ItfServiceRequests.asmx' },
      { key: 'username', label: 'Interface username', kind: 'text' },
      { key: 'password', label: 'Interface password', kind: 'secret' },
      { key: 'server_name', label: 'Server name', kind: 'text' },
      { key: 'database', label: 'Database', kind: 'text' },
      { key: 'platform', label: 'Platform', kind: 'select', options: ['SQL Server', 'Oracle'] },
      { key: 'interface_entity', label: 'Interface entity', kind: 'text' },
      { key: 'interface_license', label: 'Interface license', kind: 'secret' },
      { key: 'property_codes', label: 'Property codes', kind: 'text', placeholder: 'prop1, prop2', help: 'Comma separated Yardi property codes to sync.', optional: true },
    ],
    defaults: { pull: true, units: false, tenants: false, pushStatus: false, pushInvoice: false },
  },
};

// ============================================================
// CREDENTIALS + HOST ALLOW-LIST (SSRF guard)
// ============================================================

export type Credentials = Record<string, string>;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const HOSTS: Record<PmProvider, RegExp> = {
  buildium: /^https:\/\/(api|apisandbox)\.buildium\.com$/i,
  propertyware: /^https:\/\/api\.propertyware\.com$/i,
  rentvine: /^https:\/\/[a-z0-9-]+\.rentvine\.com$/i,
  appfolio: /^https:\/\/[a-z0-9-]+\.appfolio\.com$/i,
  yardi: /^https:\/\/([a-z0-9-]+\.)*(yardi\.com|yardiaspx\d*\.com|yardiasp\d*\.com)$/i,
};

/** `extraHosts` = exact hostnames an operator allowed through env (e.g. an on-prem Yardi server). */
export function isAllowedBase(provider: PmProvider, url: string, extraHosts: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return HOSTS[provider].test(`https://${u.hostname}`) || extraHosts.map((h) => h.toLowerCase()).includes(u.hostname.toLowerCase());
}

export type CredResult = { ok: true; credentials: Credentials; apiBase: string; label: string } | { ok: false; error: string };

export function validateCredentials(provider: PmProvider, input: unknown, extraHosts: string[] = []): CredResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Enter the credentials.' };
  const src = input as Record<string, unknown>;
  const out: Credentials = {};
  for (const f of PROVIDER_META[provider].credentials) {
    const raw = typeof src[f.key] === 'string' ? (src[f.key] as string).trim() : '';
    if (!raw && !f.optional && f.kind !== 'select') return { ok: false, error: `${f.label} is required.` };
    if (raw.length > 600 || /[\r\n\0]/.test(raw)) return { ok: false, error: `${f.label} is not valid.` };
    if (f.kind === 'select') {
      out[f.key] = f.options?.includes(raw) ? raw : (f.options?.[0] ?? '');
    } else if (raw) out[f.key] = raw;
  }
  let apiBase = '';
  let label = '';
  switch (provider) {
    case 'buildium':
      apiBase = out.environment === 'sandbox' ? 'https://apisandbox.buildium.com/v1' : 'https://api.buildium.com/v1';
      label = out.client_id.slice(0, 40);
      break;
    case 'propertyware':
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(out.organization_id)) return { ok: false, error: 'Organization ID is not valid.' };
      apiBase = 'https://api.propertyware.com/pw/api/rest/v1';
      label = `Org ${out.organization_id}`;
      break;
    case 'rentvine':
      if (!SLUG.test(out.subdomain)) return { ok: false, error: 'Enter only the subdomain, for example acmeproperties.' };
      apiBase = `https://${out.subdomain.toLowerCase()}.rentvine.com/api/manager`;
      label = `${out.subdomain.toLowerCase()}.rentvine.com`;
      break;
    case 'appfolio':
      if (!SLUG.test(out.subdomain)) return { ok: false, error: 'Enter only the subdomain, for example acmeproperties.' };
      apiBase = `https://${out.subdomain.toLowerCase()}.appfolio.com`;
      label = `${out.subdomain.toLowerCase()}.appfolio.com`;
      break;
    case 'yardi': {
      apiBase = out.server_url.replace(/\/+$/, '');
      if (!/\.asmx$/i.test(apiBase)) return { ok: false, error: 'Interface URL must end with ItfServiceRequests.asmx.' };
      label = (() => {
        try {
          return new URL(apiBase).hostname;
        } catch {
          return 'Yardi';
        }
      })();
      break;
    }
  }
  if (!isAllowedBase(provider, apiBase, extraHosts)) return { ok: false, error: `That address is not a recognised ${PROVIDER_META[provider].label} host.` };
  return { ok: true, credentials: out, apiBase, label };
}

export function authHeaders(provider: PmProvider, c: Credentials): Record<string, string> {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  switch (provider) {
    case 'buildium':
      return { 'x-buildium-client-id': c.client_id, 'x-buildium-client-secret': c.client_secret };
    case 'propertyware':
      return { 'x-propertyware-client-id': c.client_id, 'x-propertyware-client-secret': c.client_secret, 'x-propertyware-system-id': c.organization_id };
    case 'rentvine':
      return { Authorization: `Basic ${b64(`${c.api_key}:${c.api_secret}`)}` };
    case 'appfolio':
      return { Authorization: `Basic ${b64(`${c.client_id}:${c.client_secret}`)}` };
    default:
      return {};
  }
}

// ============================================================
// REST ENDPOINT SPECS (defaults + per-connection overrides)
// ============================================================

export interface EndpointSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Appended to the connection's api base. `{id}` is the provider's record id. */
  path: string;
  /** Query string. `{limit}` `{offset}` `{since}` are filled in; entries still holding `{since}` are dropped on a first sync. */
  query?: Record<string, string>;
  /** JSON body template for POST/PUT/PATCH. String leaves may hold `{placeholders}`. */
  body?: unknown;
  /** Where the array lives in the response. Empty = the response itself (or the first array property). */
  itemsPath?: string;
  paging?: 'offset' | 'none';
}

const PAGE = 100;
export const PAGE_SIZE = PAGE;

const OFFSET_Q = { limit: '{limit}', offset: '{offset}' };

export const DEFAULT_ENDPOINTS: Record<PmProvider, Partial<Record<EndpointKey, EndpointSpec>>> = {
  buildium: {
    workOrders: { method: 'GET', path: '/workorders', query: { ...OFFSET_Q, lastupdatedfrom: '{since}' }, paging: 'offset' },
    units: { method: 'GET', path: '/rentals/units', query: OFFSET_Q, paging: 'offset' },
    tenants: { method: 'GET', path: '/leases/tenants', query: OFFSET_Q, paging: 'offset' },
    pushStatus: { method: 'PUT', path: '/workorders/{id}', body: { Status: '{status}' } },
    pushInvoice: {
      method: 'POST',
      path: '/bills',
      body: {
        Date: '{date}',
        DueDate: '{due_date}',
        VendorId: '{vendor_id}',
        ReferenceNumber: '{invoice_number}',
        Memo: '{description}',
        Lines: [
          {
            AccountingEntity: { Id: '{property_id}', AccountingEntityType: '{entity_type}' },
            GlAccountId: '{gl_account_id}',
            Amount: '{amount}',
            Memo: '{description}',
          },
        ],
      },
    },
  },
  propertyware: {
    workOrders: { method: 'GET', path: '/workorders', query: { ...OFFSET_Q, lastmodifieddatestart: '{since}' }, paging: 'offset' },
    units: { method: 'GET', path: '/units', query: OFFSET_Q, paging: 'offset' },
    pushStatus: { method: 'PUT', path: '/workorders/{id}', body: { status: '{status}' } },
  },
  rentvine: {
    workOrders: { method: 'GET', path: '/maintenance/work-orders/search', query: OFFSET_Q, paging: 'offset' },
  },
  appfolio: {
    workOrders: { method: 'POST', path: '/api/v2/reports/work_order.json', body: { updated_from: '{since}' }, paging: 'none' },
    units: { method: 'POST', path: '/api/v2/reports/unit_directory.json', body: {}, paging: 'none' },
    tenants: { method: 'POST', path: '/api/v2/reports/tenant_directory.json', body: {}, paging: 'none' },
  },
  yardi: {},
};

const PATH_OK = /^\/[A-Za-z0-9/_\-.{}]{0,200}$/;
const PLACEHOLDER = /\{[a-z_]+\}/g;

export function validateEndpointSpec(input: unknown, key: EndpointKey): EndpointSpec | null {
  if (!input || typeof input !== 'object') return null;
  const s = input as Record<string, unknown>;
  const method = s.method;
  const readOnly = key === 'workOrders' || key === 'units' || key === 'tenants';
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return null;
  if (!readOnly && method === 'GET') return null;
  if (typeof s.path !== 'string' || !PATH_OK.test(s.path) || s.path.includes('..') || s.path.includes('//')) return null;
  const spec: EndpointSpec = { method, path: s.path };
  if (s.query && typeof s.query === 'object') {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.query as Record<string, unknown>).slice(0, 12)) {
      if (/^[A-Za-z0-9_.-]{1,40}$/.test(k) && typeof v === 'string' && v.length <= 80) q[k] = v;
    }
    spec.query = q;
  }
  if (s.body !== undefined && method !== 'GET') {
    if (JSON.stringify(s.body).length > 4000) return null;
    spec.body = s.body;
  }
  if (typeof s.itemsPath === 'string' && /^[A-Za-z0-9_.]{0,60}$/.test(s.itemsPath)) spec.itemsPath = s.itemsPath;
  spec.paging = s.paging === 'none' ? 'none' : 'offset';
  return spec;
}

// ============================================================
// SETTINGS
// ============================================================

export type WoMappingKey =
  | 'external_id' | 'number' | 'title' | 'description' | 'status' | 'priority' | 'property_name' | 'property_id'
  | 'unit_number' | 'unit_id' | 'address' | 'contact_name' | 'contact_phone' | 'contact_email' | 'nte'
  | 'approval' | 'approver' | 'po_number' | 'updated_at';
export const WO_MAPPING_KEYS: WoMappingKey[] = [
  'external_id', 'number', 'title', 'description', 'status', 'priority', 'property_name', 'property_id', 'unit_number',
  'unit_id', 'address', 'contact_name', 'contact_phone', 'contact_email', 'nte', 'approval', 'approver', 'po_number', 'updated_at',
];
export const WO_MAPPING_LABELS: Record<WoMappingKey, string> = {
  external_id: 'Provider record ID', number: 'Work order number', title: 'Title', description: 'Description', status: 'Status',
  priority: 'Priority', property_name: 'Property name', property_id: 'Property ID', unit_number: 'Unit number', unit_id: 'Unit ID',
  address: 'Site address', contact_name: 'Tenant / site contact name', contact_phone: 'Contact phone', contact_email: 'Contact email',
  nte: 'Not-to-exceed amount', approval: 'Approval status', approver: 'Approved by', po_number: 'PO number', updated_at: 'Last updated',
};
export type UnitMappingKey = 'external_id' | 'property_id' | 'property_name' | 'unit_number' | 'address' | 'city' | 'state' | 'postal_code' | 'updated_at';
export type TenantMappingKey = 'external_id' | 'unit_id' | 'name' | 'email' | 'phone' | 'status' | 'updated_at';

type MapSet<K extends string> = Record<K, string>;
const WO_MAP_DEFAULT: MapSet<WoMappingKey> = {
  external_id: 'Id|id|WorkOrderId|work_order_id|service_request_id|ServiceRequestId',
  number: 'WorkOrderNumber|Number|work_order_number|ServiceRequestNumber|OrderNumber',
  title: 'Title|Subject|Name|title|job_description|Summary',
  description: 'Description|WorkDetails|Details|description|ProblemDescription|job_description',
  status: 'WorkOrderStatus|Status|status|TaskStatus',
  priority: 'Priority|priority',
  property_name: 'Property.Name|PropertyName|property_name|Building.Name|PropertyCode',
  property_id: 'Property.Id|PropertyId|property_id|BuildingId|PropertyCode',
  unit_number: 'Unit.UnitNumber|Unit.Number|UnitNumber|UnitName|unit_name|unit|UnitCode',
  unit_id: 'UnitId|Unit.Id|unit_id|UnitCode',
  address: 'Property.Address.AddressLine1|PropertyAddress|property_address|Address.AddressLine1|address',
  contact_name: 'RequestedByUserEntity.FirstName+RequestedByUserEntity.LastName|primary_tenant|TenantName|ContactName|ResidentName',
  contact_phone: 'RequestedByUserEntity.PhoneNumber|primary_tenant_phone_number|TenantPhone|ContactPhone|Phone',
  contact_email: 'RequestedByUserEntity.Email|primary_tenant_email|TenantEmail|ContactEmail|Email',
  nte: 'NotToExceedAmount|NotToExceed|NteAmount|estimate_amount|AuthorizedAmount',
  approval: 'ApprovalStatus|Approval|approval_status|AuthorizationStatus',
  approver: 'ApprovedBy|approved_by|Approver',
  po_number: 'PurchaseOrderNumber|PoNumber|po_number|PO',
  updated_at: 'LastUpdatedDateTime|LastModifiedDateTime|LastUpdated|UpdatedAt|updated_at|ModifiedDate',
};
const UNIT_MAP_DEFAULT: MapSet<UnitMappingKey> = {
  external_id: 'Id|id|unit_id|UnitId',
  property_id: 'PropertyId|Property.Id|property_id|BuildingId',
  property_name: 'PropertyName|Property.Name|property_name|Building.Name',
  unit_number: 'UnitNumber|Number|unit_name|UnitName|unit',
  address: 'Address.AddressLine1|AddressLine1|address|property_address',
  city: 'Address.City|City|city',
  state: 'Address.State|State|state',
  postal_code: 'Address.PostalCode|PostalCode|postal_code|Zip',
  updated_at: 'LastUpdatedDateTime|LastModifiedDateTime|updated_at',
};
const TENANT_MAP_DEFAULT: MapSet<TenantMappingKey> = {
  external_id: 'Id|id|tenant_id|TenantId',
  unit_id: 'UnitId|Unit.Id|unit_id|CurrentLease.UnitId',
  name: 'FirstName+LastName|name|Name|tenant|FullName',
  email: 'Email|email|PrimaryEmail',
  phone: 'PhoneNumbers.Mobile|PhoneNumbers.Home|PhoneNumber|phone|phone_number|Phone',
  status: 'Status|status|LeaseStatus',
  updated_at: 'LastUpdatedDateTime|LastModifiedDateTime|updated_at',
};
export const UNIT_MAPPING_KEYS = Object.keys(UNIT_MAP_DEFAULT) as UnitMappingKey[];
export const TENANT_MAPPING_KEYS = Object.keys(TENANT_MAP_DEFAULT) as TenantMappingKey[];

const YARDI_WO: Partial<MapSet<WoMappingKey>> = {
  external_id: 'ServiceRequestId|ServiceRequestNumber|RequestId',
  number: 'ServiceRequestNumber|ServiceRequestId|WorkOrderNumber',
  title: 'ShortDescription|Category|ProblemDescription',
  description: 'ProblemDescription|Description|Details',
  status: 'Status|ServiceRequestStatus',
  priority: 'Priority',
  property_name: 'PropertyCode|PropertyName',
  property_id: 'PropertyCode',
  unit_number: 'UnitCode|Unit',
  unit_id: 'UnitCode',
  contact_name: 'TenantName|ResidentName|RequestorName',
  contact_phone: 'TenantPhone|PhoneNumber|Phone',
  contact_email: 'TenantEmail|Email',
  updated_at: 'UpdateDate|ModifiedDate|RequestDate',
};

export const DEFAULT_STATUS_IN: Record<string, WoStatus> = {
  new: 'draft', open: 'draft', requested: 'draft', unassigned: 'draft', assigned: 'draft', pending: 'draft', submitted: 'draft',
  reopened: 'draft', onhold: 'draft', deferred: 'draft', waiting: 'draft',
  scheduled: 'scheduled', dispatched: 'scheduled', accepted: 'scheduled', vendorassigned: 'scheduled',
  inprogress: 'in_progress', started: 'in_progress', working: 'in_progress', onsite: 'in_progress',
  completed: 'completed', complete: 'completed', done: 'completed', closed: 'completed', resolved: 'completed', finished: 'completed',
  cancelled: 'cancelled', canceled: 'cancelled', declined: 'cancelled', void: 'cancelled', voided: 'cancelled', rejected: 'cancelled', deleted: 'cancelled',
};
export const DEFAULT_STATUS_OUT: Record<WoStatus, string> = {
  draft: 'New', scheduled: 'Scheduled', in_progress: 'InProgress', completed: 'Completed', cancelled: 'Cancelled',
};
export const DEFAULT_APPROVAL_IN: Record<string, Approval> = {
  approved: 'approved', authorized: 'approved', authorised: 'approved', accepted: 'approved', ok: 'approved', yes: 'approved', true: 'approved', oktoproceed: 'approved',
  pending: 'pending', awaiting: 'pending', awaitingapproval: 'pending', submitted: 'pending', requested: 'pending', underreview: 'pending',
  rejected: 'rejected', denied: 'rejected', declined: 'rejected', no: 'rejected', false: 'rejected',
  notrequired: 'not_required', none: 'not_required', na: 'not_required',
};

export interface PmSettings {
  version: 1;
  pull: { workOrders: boolean; units: boolean; tenants: boolean };
  createWorkOrders: boolean;
  defaultApproval: Approval;
  usePmNumberAsPo: boolean;
  unknownStatus: WoStatus;
  backfillDays: number;
  statusIn: Record<string, WoStatus>;
  statusOut: Record<WoStatus, string>;
  approvalIn: Record<string, Approval>;
  mapping: { workOrder: MapSet<WoMappingKey>; unit: MapSet<UnitMappingKey>; tenant: MapSet<TenantMappingKey> };
  push: { status: boolean; invoices: boolean; dryRun: boolean };
  invoice: { dueDays: number; constants: Record<string, string> };
  endpoints: Partial<Record<EndpointKey, EndpointSpec>>;
}

export const INVOICE_CONSTANTS: { key: string; label: string; numeric?: boolean; providers: PmProvider[]; placeholder?: string }[] = [
  { key: 'vendor_id', label: 'Your vendor ID in the property manager’s system', numeric: true, providers: ['buildium'] },
  { key: 'gl_account_id', label: 'GL account ID to bill against', numeric: true, providers: ['buildium'] },
  { key: 'entity_type', label: 'Accounting entity type', providers: ['buildium'], placeholder: 'Rental' },
];

export function defaultSettings(provider: PmProvider): PmSettings {
  const m = PROVIDER_META[provider].defaults;
  return {
    version: 1,
    pull: { workOrders: m.pull, units: m.units, tenants: m.tenants },
    createWorkOrders: true,
    defaultApproval: 'pending',
    usePmNumberAsPo: true,
    unknownStatus: 'draft',
    backfillDays: 30,
    statusIn: {},
    statusOut: { ...DEFAULT_STATUS_OUT },
    approvalIn: {},
    mapping: {
      workOrder: { ...WO_MAP_DEFAULT, ...(provider === 'yardi' ? YARDI_WO : {}) } as MapSet<WoMappingKey>,
      unit: { ...UNIT_MAP_DEFAULT },
      tenant: { ...TENANT_MAP_DEFAULT },
    },
    // Writing to a customer's system is opt-in, and every opt-in starts as a dry run.
    push: { status: false, invoices: false, dryRun: true },
    invoice: { dueDays: 30, constants: { entity_type: 'Rental' } },
    endpoints: {},
  };
}

const MAP_RE = /^[A-Za-z0-9_.|+\- ]{1,200}$/;
const KEY_RE = /^[a-z0-9]{1,40}$/;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const int = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);

export type SettingsResult = { ok: true; settings: PmSettings } | { ok: false; error: string };

export function validateSettings(provider: PmProvider, input: unknown): SettingsResult {
  const d = defaultSettings(provider);
  if (input === null || input === undefined || (typeof input === 'object' && Object.keys(input as object).length === 0)) return { ok: true, settings: d };
  if (typeof input !== 'object') return { ok: false, error: 'Settings are not valid.' };
  const s = input as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: PmSettings = { ...d };

  out.pull = { workOrders: bool(s.pull?.workOrders, d.pull.workOrders), units: bool(s.pull?.units, d.pull.units), tenants: bool(s.pull?.tenants, d.pull.tenants) };
  out.createWorkOrders = bool(s.createWorkOrders, d.createWorkOrders);
  out.usePmNumberAsPo = bool(s.usePmNumberAsPo, d.usePmNumberAsPo);
  out.defaultApproval = APPROVALS.includes(s.defaultApproval) ? s.defaultApproval : d.defaultApproval;
  out.unknownStatus = WO_STATUSES.includes(s.unknownStatus) ? s.unknownStatus : d.unknownStatus;
  out.backfillDays = int(s.backfillDays, d.backfillDays, 1, 365);

  for (const [name, target, allowed] of [['statusIn', 'statusIn', WO_STATUSES], ['approvalIn', 'approvalIn', APPROVALS]] as const) {
    const raw = s[name];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Status mappings are not valid.' };
    const clean: Record<string, never> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 60)) {
      const nk = normKey(k);
      if (!KEY_RE.test(nk) || !(allowed as readonly string[]).includes(v as string)) return { ok: false, error: `“${k}” has an invalid status mapping.` };
      (clean as Record<string, unknown>)[nk] = v;
    }
    (out as unknown as Record<string, unknown>)[target] = clean;
  }

  if (s.statusOut !== undefined) {
    const so: Record<string, string> = { ...d.statusOut };
    for (const st of WO_STATUSES) {
      const v = s.statusOut?.[st];
      if (v === undefined) continue;
      if (typeof v !== 'string' || !/^[A-Za-z0-9 _-]{1,40}$/.test(v)) return { ok: false, error: `The status sent to ${PROVIDER_META[provider].label} for “${st}” is not valid.` };
      so[st] = v;
    }
    out.statusOut = so as Record<WoStatus, string>;
  }

  if (s.mapping !== undefined) {
    const next = { workOrder: { ...d.mapping.workOrder }, unit: { ...d.mapping.unit }, tenant: { ...d.mapping.tenant } };
    for (const [set, keys] of [['workOrder', WO_MAPPING_KEYS], ['unit', UNIT_MAPPING_KEYS], ['tenant', TENANT_MAPPING_KEYS]] as const) {
      const given = s.mapping?.[set];
      if (given === undefined) continue;
      if (!given || typeof given !== 'object') return { ok: false, error: 'Field mapping is not valid.' };
      for (const k of keys as readonly string[]) {
        const v = given[k];
        if (v === undefined) continue;
        if (typeof v !== 'string' || !MAP_RE.test(v.trim())) return { ok: false, error: `The field path for “${k}” is not valid.` };
        (next[set] as Record<string, string>)[k] = v.trim();
      }
    }
    out.mapping = next as PmSettings['mapping'];
  }

  if (s.invoice !== undefined) {
    const constants: Record<string, string> = { ...d.invoice.constants };
    for (const c of INVOICE_CONSTANTS) {
      const v = s.invoice?.constants?.[c.key];
      if (v === undefined || v === '') continue;
      if (typeof v !== 'string' || (c.numeric ? !/^\d{1,12}$/.test(v.trim()) : !/^[A-Za-z0-9 _-]{1,40}$/.test(v.trim()))) return { ok: false, error: `${c.label} is not valid.` };
      constants[c.key] = v.trim();
    }
    out.invoice = { dueDays: int(s.invoice?.dueDays, d.invoice.dueDays, 0, 180), constants };
  }

  if (s.endpoints !== undefined) {
    if (!s.endpoints || typeof s.endpoints !== 'object') return { ok: false, error: 'Endpoints are not valid.' };
    const eps: Partial<Record<EndpointKey, EndpointSpec>> = {};
    for (const k of ENDPOINT_KEYS) {
      if (s.endpoints[k] === undefined || s.endpoints[k] === null) continue;
      const spec = validateEndpointSpec(s.endpoints[k], k);
      if (!spec) return { ok: false, error: `The ${k} endpoint is not valid. Use an absolute path such as /workorders/{id}.` };
      eps[k] = spec;
    }
    out.endpoints = eps;
  }
  if (s.push !== undefined) {
    out.push = { status: bool(s.push?.status, false), invoices: bool(s.push?.invoices, false), dryRun: bool(s.push?.dryRun, true) };
    const label = PROVIDER_META[provider].label;
    if (out.push.status && !endpointFor(provider, out, 'pushStatus')) return { ok: false, error: `Status updates are not set up for ${label} yet. Add the endpoint under Advanced first.` };
    if (out.push.invoices && !endpointFor(provider, out, 'pushInvoice')) return { ok: false, error: `Invoice sync is not set up for ${label} yet. Add the endpoint under Advanced first.` };
  }
  return { ok: true, settings: out };
}

export function endpointFor(provider: PmProvider, settings: PmSettings, key: EndpointKey): EndpointSpec | null {
  return settings.endpoints[key] ?? DEFAULT_ENDPOINTS[provider][key] ?? null;
}

// ============================================================
// REQUESTS
// ============================================================

export interface HttpReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Fills `{name}` placeholders. A leaf that is EXACTLY one placeholder keeps the value's type (numbers stay numbers). */
export function renderTemplate(tpl: unknown, vars: Record<string, string | number | null | undefined>): unknown {
  if (typeof tpl === 'string') {
    const whole = /^\{([a-z_]+)\}$/.exec(tpl);
    if (whole) {
      const v = vars[whole[1]];
      return v === undefined || v === null ? null : v;
    }
    return tpl.replace(PLACEHOLDER, (m) => String(vars[m.slice(1, -1)] ?? ''));
  }
  if (Array.isArray(tpl)) return tpl.map((x) => renderTemplate(x, vars));
  if (tpl && typeof tpl === 'object') return Object.fromEntries(Object.entries(tpl as Record<string, unknown>).map(([k, v]) => [k, renderTemplate(v, vars)]));
  return tpl;
}

/** Removes keys whose value is exactly `{since}` (a first sync has no watermark yet). */
function dropSince(tpl: unknown): unknown {
  if (Array.isArray(tpl)) return tpl.map(dropSince);
  if (tpl && typeof tpl === 'object') {
    return Object.fromEntries(Object.entries(tpl as Record<string, unknown>).filter(([, v]) => v !== '{since}').map(([k, v]) => [k, dropSince(v)]));
  }
  return tpl;
}

function buildUrl(base: string, spec: EndpointSpec, vars: Record<string, string | number | null | undefined>): string {
  const path = spec.path.replace(/\{id\}/g, encodeURIComponent(String(vars.id ?? '')));
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(spec.query ?? {})) {
    if (v.includes('{since}') && !vars.since) continue;
    q.set(k, v.replace(PLACEHOLDER, (m) => String(vars[m.slice(1, -1)] ?? '')));
  }
  const qs = q.toString();
  return `${base.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
}

export function buildRestRequest(
  provider: PmProvider,
  creds: Credentials,
  apiBase: string,
  spec: EndpointSpec,
  vars: Record<string, string | number | null | undefined> = {},
): HttpReq {
  const hasBody = spec.method !== 'GET' && spec.body !== undefined;
  const body: unknown = hasBody ? renderTemplate(vars.since ? spec.body : dropSince(spec.body), vars) : undefined;
  return {
    method: spec.method,
    url: buildUrl(apiBase, spec, vars),
    headers: { Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...authHeaders(provider, creds) },
    body: hasBody ? JSON.stringify(body) : undefined,
  };
}

export const listVars = (cursor: string | null, since: string | null) => ({ limit: PAGE, offset: cursor ? Number(cursor) || 0 : 0, since: since ?? '' });

export interface Page {
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

const ARRAY_KEYS = ['items', 'results', 'data', 'records', 'WorkOrders', 'workOrders', 'ServiceRequests', 'Units', 'Tenants', 'value'];

export function parsePage(json: unknown, spec: EndpointSpec, cursor: string | null): Page {
  let arr: unknown = json;
  if (spec.itemsPath) arr = readRaw(json, spec.itemsPath);
  else if (!Array.isArray(json) && json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    arr = ARRAY_KEYS.map((k) => o[k]).find(Array.isArray) ?? Object.values(o).find(Array.isArray);
  }
  const items = (Array.isArray(arr) ? arr : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
  const offset = cursor ? Number(cursor) || 0 : 0;
  const more = spec.paging !== 'none' && items.length >= PAGE;
  return { items, nextCursor: more ? String(offset + items.length) : null };
}

// ============================================================
// FIELD READING (provider JSON -> canonical)
// ============================================================

function readRaw(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    const rec = cur as Record<string, unknown>;
    const hit = seg in rec ? seg : Object.keys(rec).find((k) => k.toLowerCase() === seg.toLowerCase());
    cur = hit === undefined ? undefined : rec[hit];
  }
  return cur;
}

const scalar = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
};

/** `A|B.C` = first non-empty alternative; `A+B` = join parts with a space. Case-insensitive keys. */
export function readPath(obj: unknown, expr: string): string | null {
  for (const alt of expr.split('|')) {
    const parts = alt.split('+').map((p) => scalar(readRaw(obj, p.trim()))).filter((x): x is string => !!x);
    if (parts.length) return parts.join(' ');
  }
  return null;
}

export type CanonWo = Record<WoMappingKey, string | null>;
export const toCanonWorkOrder = (raw: Record<string, unknown>, settings: PmSettings): CanonWo =>
  Object.fromEntries(WO_MAPPING_KEYS.map((k) => [k, readPath(raw, settings.mapping.workOrder[k])])) as CanonWo;
export const toCanonUnit = (raw: Record<string, unknown>, settings: PmSettings) =>
  Object.fromEntries(UNIT_MAPPING_KEYS.map((k) => [k, readPath(raw, settings.mapping.unit[k])])) as Record<UnitMappingKey, string | null>;
export const toCanonTenant = (raw: Record<string, unknown>, settings: PmSettings) =>
  Object.fromEntries(TENANT_MAPPING_KEYS.map((k) => [k, readPath(raw, settings.mapping.tenant[k])])) as Record<TenantMappingKey, string | null>;

export function parseTimestamp(v: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? t : null;
}

// ============================================================
// YARDI (SOAP, read only)
// ============================================================

const xmlUnescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildYardiGetRequests(creds: Credentials): HttpReq[] {
  const codes = (creds.property_codes ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  return (codes.length ? codes : ['']).map((code) => {
    const f = (n: string, v: string) => `<${n}>${xmlEscape(v)}</${n}>`;
    const body =
      '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap:Body><GetServiceRequests_Login xmlns="http://tempuri.org/YSI.Interfaces.WebServices/ItfServiceRequests">' +
      f('UserName', creds.username) + f('Password', creds.password) + f('ServerName', creds.server_name) + f('Database', creds.database) +
      f('Platform', creds.platform || 'SQL Server') + f('InterfaceEntity', creds.interface_entity) + f('InterfaceLicense', creds.interface_license) +
      f('YardiPropertyId', code) + '</GetServiceRequests_Login></soap:Body></soap:Envelope>';
    return {
      method: 'POST',
      url: creds.server_url,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'http://tempuri.org/YSI.Interfaces.WebServices/ItfServiceRequests/GetServiceRequests_Login' },
      body,
    };
  });
}

/** Tolerant reader: Yardi often wraps the real document as escaped XML inside the SOAP result. */
export function parseYardiServiceRequests(xml: string): Record<string, unknown>[] {
  if (/<(\w+:)?Fault\b/.test(xml)) throw new Error('Yardi rejected the request. Check the interface credentials and license.');
  const doc = /&lt;ServiceRequests?(&gt;|\s)/.test(xml) ? xmlUnescape(xml) : xml;
  const out: Record<string, unknown>[] = [];
  for (const m of doc.matchAll(/<ServiceRequest\b[^>]*>([\s\S]*?)<\/ServiceRequest>/g)) {
    const rec: Record<string, unknown> = {};
    for (const t of m[1].matchAll(/<([A-Za-z][\w.-]*)\b[^>]*>([^<]*)<\/\1>/g)) {
      const v = xmlUnescape(t[2]).trim();
      if (v && !(t[1] in rec)) rec[t[1]] = v;
    }
    if (Object.keys(rec).length) out.push(rec);
  }
  return out;
}

// ============================================================
// NORMALISATION + MAPPING TO VIREEK
// ============================================================

export const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function toCents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const cleaned = typeof v === 'number' ? String(v) : String(v).replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  const c = Math.round(n * 100);
  return c > 2_147_483_647 ? null : c;
}

const clip = (s: string | null, n: number) => (s === null ? null : s.slice(0, n).trim() || null);
const phone = (s: string | null) => (s ? s.replace(/[^\d+()\-\s.x]/g, '').trim().slice(0, 40) || null : null);

export function mapStatusIn(raw: string | null, s: PmSettings): { status: WoStatus; known: boolean } {
  const k = raw ? normKey(raw) : '';
  const hit = s.statusIn[k] ?? DEFAULT_STATUS_IN[k];
  return hit ? { status: hit, known: true } : { status: s.unknownStatus, known: false };
}

export function mapApprovalIn(raw: string | null, s: PmSettings): Approval {
  const k = raw ? normKey(raw) : '';
  return s.approvalIn[k] ?? DEFAULT_APPROVAL_IN[k] ?? s.defaultApproval;
}

/** Vireek-domain values of the PM-owned fields + the PM status. This is what we compare, store as base and write. */
export interface WoValues {
  title: string;
  description: string | null;
  po_number: string | null;
  site_name: string | null;
  site_address: string | null;
  site_contact_name: string | null;
  site_contact_phone: string | null;
  site_contact_email: string | null;
  not_to_exceed_cents: number | null;
  approval_status: Approval;
  approver_name: string | null;
  status: WoStatus;
}
export const PM_OWNED: (keyof WoValues)[] = [
  'title', 'description', 'po_number', 'site_name', 'site_address', 'site_contact_name', 'site_contact_phone', 'site_contact_email',
  'not_to_exceed_cents', 'approval_status', 'approver_name',
];

export function toWoValues(c: CanonWo, s: PmSettings): { values: WoValues; unknownStatus: string | null } {
  const st = mapStatusIn(c.status, s);
  const site = [c.property_name, c.unit_number ? `Unit ${c.unit_number}` : null].filter(Boolean).join(' · ');
  const ref = c.number ?? c.external_id;
  return {
    values: {
      title: clip(c.title, 200) ?? `Work order ${ref ?? ''}`.trim(),
      description: clip(c.description, 5000),
      po_number: clip(c.po_number ?? (s.usePmNumberAsPo ? c.number : null), 80),
      site_name: clip(site || null, 200),
      site_address: clip(c.address, 300),
      site_contact_name: clip(c.contact_name, 120),
      site_contact_phone: phone(c.contact_phone),
      site_contact_email: clip(c.contact_email, 200)?.toLowerCase() ?? null,
      not_to_exceed_cents: toCents(c.nte) || null,
      approval_status: mapApprovalIn(c.approval, s),
      approver_name: clip(c.approver, 120),
      status: st.status,
    },
    unknownStatus: st.known ? null : c.status,
  };
}

// ============================================================
// RECONCILIATION PLANNER
// ============================================================

export type WoBase = Partial<WoValues>;
export interface PlanResult {
  /** Columns to write to work_orders (empty = nothing to do). */
  patch: Partial<WoValues>;
  /** Vireek's status should be pushed to the provider. */
  pushStatus: WoStatus | null;
  /** The snapshot to store as the link's base after applying `patch`. */
  nextBase: WoBase;
  notes: string[];
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const started = (s: WoStatus) => s === 'in_progress' || s === 'completed';
const approvalOk = (a: Approval) => a === 'approved' || a === 'not_required';

/**
 * Field ownership:
 *   - PM-owned fields (title, description, PO, site, contact, NTE, approval): the provider wins whenever IT changed them.
 *   - status: three-way. Only one side changed -> that side wins. Both changed -> Vireek wins (and is pushed),
 *     except a provider cancellation, which always wins.
 * The database gates are respected here, never worked around: work never starts before approval, and an approval
 * can't be withdrawn once work has started (that is raised as a note for a human instead).
 */
export function planWorkOrderSync(base: WoBase, pm: WoValues, vv: WoValues): PlanResult {
  const patch: Partial<WoValues> = {};
  const notes: string[] = [];
  const nextBase: WoBase = { ...base };

  for (const f of PM_OWNED) {
    nextBase[f] = pm[f] as never;
    if (!same(pm[f], base[f]) && !same(pm[f], vv[f])) (patch as Record<string, unknown>)[f] = pm[f];
  }

  let status = vv.status;
  let pushStatus: WoStatus | null = null;
  if (base.status === undefined) {
    // Adopting an existing Vireek work order: Vireek keeps its status and the provider is told.
    if (pm.status !== vv.status) pushStatus = vv.status;
  } else {
    const pmChanged = pm.status !== base.status;
    const vvChanged = vv.status !== base.status;
    if (pmChanged && !vvChanged) status = pm.status;
    else if (!pmChanged && vvChanged) pushStatus = vv.status;
    else if (pmChanged && vvChanged && pm.status !== vv.status) {
      if (pm.status === 'cancelled') {
        status = 'cancelled';
        notes.push('Cancelled by the property manager while Vireek had other changes.');
      } else {
        pushStatus = vv.status;
        notes.push(`Status differs (property manager: ${pm.status}, Vireek: ${vv.status}). Vireek wins and will be pushed.`);
      }
    }
  }

  // Approval gates (mirror the database trigger; never worked around).
  if (patch.approval_status && !approvalOk(patch.approval_status) && started(vv.status)) {
    delete patch.approval_status;
    notes.push(`The property manager now shows approval as “${pm.approval_status}” but work has already started. Review this work order.`);
  }
  const approval = (patch.approval_status ?? vv.approval_status) as Approval;
  if (started(status) && !approvalOk(approval)) {
    status = started(vv.status) ? vv.status : 'scheduled';
    notes.push('Held at Scheduled until the work order is approved in Vireek.');
  }
  if (status !== vv.status) patch.status = status;
  nextBase.status = pushStatus ? (base.status ?? pm.status) : status;
  return { patch, pushStatus, nextBase, notes };
}

export function buildNewWorkOrder(pm: WoValues): WoValues {
  const v = { ...pm };
  if (started(v.status) && !approvalOk(v.approval_status)) v.status = 'scheduled';
  return v;
}

// ============================================================
// OUTBOUND PAYLOADS
// ============================================================

export function statusVars(s: PmSettings, status: WoStatus, ref: { id: string; number?: string | null }) {
  return { id: ref.id, status: s.statusOut[status], vireek_status: status, number: ref.number ?? '' };
}

export interface InvoiceInput {
  amountCents: number;
  invoiceNumber: string;
  description: string;
  propertyId: string | null;
  today: Date;
}
export function invoiceVars(s: PmSettings, i: InvoiceInput): Record<string, string | number | null> {
  const due = new Date(i.today.getTime() + s.invoice.dueDays * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const num = (k: string) => (s.invoice.constants[k] ? Number(s.invoice.constants[k]) : null);
  return {
    amount: Math.round(i.amountCents) / 100,
    amount_cents: i.amountCents,
    invoice_number: i.invoiceNumber.slice(0, 60),
    description: i.description.slice(0, 500),
    date: iso(i.today),
    due_date: iso(due),
    property_id: i.propertyId && /^\d+$/.test(i.propertyId) ? Number(i.propertyId) : i.propertyId,
    vendor_id: num('vendor_id'),
    gl_account_id: num('gl_account_id'),
    entity_type: s.invoice.constants.entity_type ?? 'Rental',
  };
}

/** Required values for an invoice POST; returns the missing ones so the UI/log can say exactly what to fill in. */
export function missingInvoiceInputs(provider: PmProvider, vars: Record<string, unknown>): string[] {
  if (provider !== 'buildium') return [];
  return (['vendor_id', 'gl_account_id', 'property_id'] as const).filter((k) => vars[k] === null || vars[k] === undefined || vars[k] === '');
}

// ============================================================
// RETRY QUEUE
// ============================================================

export type Outcome = 'ok' | 'retry' | 'auth' | 'permanent';

export function classifyHttp(status: number): { outcome: Outcome; message: string } {
  if (status >= 200 && status < 300) return { outcome: 'ok', message: 'OK' };
  if (status === 401) return { outcome: 'auth', message: 'The provider rejected our credentials. Reconnect to continue.' };
  if (status === 403) return { outcome: 'permanent', message: 'Access denied. The API key or partner agreement does not allow this action.' };
  if (status === 408 || status === 425 || status === 429) return { outcome: 'retry', message: status === 429 ? 'Rate limited by the provider.' : 'The provider timed out.' };
  if (status >= 500) return { outcome: 'retry', message: `The provider had a server error (${status}).` };
  if (status === 404) return { outcome: 'permanent', message: 'The record no longer exists on the provider side.' };
  return { outcome: 'permanent', message: `The provider rejected the request (${status}).` };
}

export const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 6 * 3_600_000;

/** attempt = number of attempts already made (1 after the first failure). ±20% jitter; honours Retry-After. */
export function retryDelayMs(attempt: number, retryAfterSec: number | null = null, rand: () => number = Math.random): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exp * (0.8 + rand() * 0.4));
  const floor = retryAfterSec && retryAfterSec > 0 ? Math.min(MAX_DELAY_MS, retryAfterSec * 1000) : 0;
  return Math.max(jittered, floor);
}

export function parseRetryAfter(h: string | null, now = Date.now()): number | null {
  if (!h) return null;
  if (/^\d+$/.test(h)) return Number(h);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : null;
}

/** Strip anything that looks like a credential from text before it is logged or shown. */
export function scrub(text: string, creds: Credentials): string {
  let out = text;
  for (const v of Object.values(creds)) if (v && v.length >= 4) out = out.split(v).join('•••');
  return out.replace(/Basic [A-Za-z0-9+/=]{8,}/g, 'Basic •••').slice(0, 300);
}

// ============================================================
// STATS
// ============================================================

export interface PmStats {
  created: number; updated: number; linked: number; pushed: number; skipped: number; queued: number; failed: number; units: number; tenants: number;
}
export const emptyStats = (): PmStats => ({ created: 0, updated: 0, linked: 0, pushed: 0, skipped: 0, queued: 0, failed: 0, units: 0, tenants: 0 });
