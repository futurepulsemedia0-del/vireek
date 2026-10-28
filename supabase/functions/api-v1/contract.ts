// supabase/functions/api-v1/contract.ts
//
// SINGLE SOURCE OF TRUTH for the public `api-v1` contract.
//
//   index.ts            routes, scopes, limits and validation come from here
//   src/lib/openapi.ts  the OpenAPI 3.1 document + Postman collection come from here
//   public/openapi.json the published spec is generated from here (npm run openapi:generate)
//   CI (openapi:check)  fails when index.ts, this file and public/openapi.json disagree
//
// Deliberately PURE: no imports and no Deno / DOM / Node globals, so the same
// file runs in the Deno edge function, in Vite/Vitest and in plain Node >= 22.18.
// Keep it that way — an import here breaks the generator script.

export const API_VERSION = '1.0.0';
export const RATE_LIMIT_PER_MINUTE = 120;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const SPEC_PUBLIC_PATH = '/openapi.json';
const TEMPLATE_SERVER_URL = 'https://{projectRef}.supabase.co/functions/v1/api-v1';

/* ------------------------------------------------------------------ */
/*  Resource definitions (routes + scopes + response schemas)           */
/* ------------------------------------------------------------------ */

export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'array';
export type ApiResourceName = 'calls' | 'leads' | 'jobs';

export interface FieldDef {
  name: string;
  type: FieldType;
  format?: 'uuid' | 'date-time';
  nullable?: boolean;
  description: string;
}

export interface ResourceDef {
  name: ApiResourceName;
  /** Postgres table the edge function reads. */
  table: string;
  schema: 'Call' | 'Lead' | 'Job';
  tag: 'Calls' | 'Leads' | 'Jobs';
  scope: string;
  description: string;
  fields: FieldDef[];
}

const id = (description: string, nullable = false): Omit<FieldDef, 'name'> => ({ type: 'string', format: 'uuid', nullable, description });
const text = (description: string, nullable = true): Omit<FieldDef, 'name'> => ({ type: 'string', nullable, description });
const stamp = (description: string, nullable = false): Omit<FieldDef, 'name'> => ({ type: 'string', format: 'date-time', nullable, description });
const f = (name: string, def: Omit<FieldDef, 'name'>): FieldDef => ({ name, ...def });

export const RESOURCES: ResourceDef[] = [
  {
    name: 'calls',
    table: 'calls',
    schema: 'Call',
    tag: 'Calls',
    scope: 'calls:read',
    description: 'Inbound calls handled by your AI receptionist — recordings, transcripts, summaries and sentiment.',
    fields: [
      f('id', id('Unique call ID.')),
      f('user_id', id('Owning account ID.')),
      f('external_id', text('ID of the call in the telephony provider.')),
      f('caller_phone', text('Caller phone number.')),
      f('caller_name', text('Caller name, when captured.')),
      f('call_datetime', stamp('When the call happened.')),
      f('duration_seconds', { type: 'integer', nullable: true, description: 'Call length in seconds.' }),
      f('summary', text('AI-written summary of the call.')),
      f('transcript', text('Full call transcript.')),
      f('recording_url', text('URL of the call recording.')),
      f('is_emergency', { type: 'boolean', description: 'True when the call was flagged as an emergency.' }),
      f('sentiment', text('Caller sentiment label.')),
      f('status', text('Pipeline status, e.g. new_lead or booked.', false)),
      f('tags', { type: 'array', description: 'Free-form tags.' }),
      f('customer_id', id('Linked customer ID.', true)),
      f('created_at', stamp('When the record was created.')),
    ],
  },
  {
    name: 'leads',
    table: 'leads',
    schema: 'Lead',
    tag: 'Leads',
    scope: 'leads:read',
    description: 'Leads captured from calls.',
    fields: [
      f('id', id('Unique lead ID.')),
      f('user_id', id('Owning account ID.')),
      f('call_id', id('Call this lead came from.', true)),
      f('name', text('Lead name.', false)),
      f('phone', text('Lead phone number.')),
      f('email', text('Lead email address.')),
      f('service_interested', text('Service the lead asked about.')),
      f('notes', text('Free-form notes.')),
      f('stage', text('Pipeline stage, e.g. new.', false)),
      f('tags', { type: 'array', description: 'Free-form tags.' }),
      f('customer_id', id('Linked customer ID.', true)),
      f('created_at', stamp('When the record was created.')),
    ],
  },
  {
    name: 'jobs',
    table: 'jobs',
    schema: 'Job',
    tag: 'Jobs',
    scope: 'jobs:read',
    description: 'Booked and scheduled jobs.',
    fields: [
      f('id', id('Unique job ID.')),
      f('user_id', id('Owning account ID.')),
      f('lead_id', id('Source lead.', true)),
      f('call_id', id('Source call.', true)),
      f('customer_id', id('Linked customer ID.', true)),
      f('customer_name', text('Customer name.', false)),
      f('service_type', text('Type of service.')),
      f('address', text('Service address.')),
      f('scheduled_datetime', stamp('Scheduled start time.', true)),
      f('assigned_technician_id', id('Assigned technician.', true)),
      f('job_status', text('Job status, e.g. scheduled.', false)),
      f('invoice_amount', { type: 'number', nullable: true, description: 'Invoice total.' }),
      f('invoice_status', text('Invoice status, e.g. not_sent.', false)),
      f('notes', text('Free-form notes.')),
      f('completed_at', stamp('When the job was completed.', true)),
      f('created_at', stamp('When the record was created.')),
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Shared constants (edge function + spec + reference page)            */
/* ------------------------------------------------------------------ */

export const LIST_PARAMETERS = [
  { name: 'limit', type: 'integer', description: `Max rows to return (1–${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}. Out-of-range values are clamped.` },
  { name: 'before', type: 'ISO 8601 timestamp', description: "Return rows created before this timestamp — pass the previous page's next_before. URL-encode it." },
] as const;

export const ERROR_RESPONSES: Record<string, string> = {
  '400': 'Malformed request: id is not a UUID, or before is not an ISO 8601 timestamp.',
  '401': 'Missing, invalid or revoked API key.',
  '403': 'The key is missing the scope this endpoint requires.',
  '404': 'The requested record does not exist on your account.',
  '429': `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE} requests/minute per key). Wait the number of seconds in the Retry-After header.`,
  '500': 'Unexpected server error.',
};

export const NOT_FOUND_MESSAGE = `Not found. Available resources: ${RESOURCES.map((r) => r.name).join(', ')}`;

export function resourceByName(name: string): ResourceDef | undefined {
  return RESOURCES.find((r) => r.name === name);
}

/** `/calls/:id` → `/calls/{id}` */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_]+)/g, '{$1}');
}

export function resourceOfEndpoint(ep: { path: string }): string {
  return ep.path.split('/').filter(Boolean)[0] ?? '';
}

/* ------------------------------------------------------------------ */
/*  Routing + input validation (used by index.ts)                       */
/* ------------------------------------------------------------------ */

export type RouteMatch =
  | { kind: 'not_found' }
  | { kind: 'ok'; resource: ApiResourceName; table: string; scope: string; id: string | null };

/**
 * Resolves `/api-v1/<resource>[/<id>]`. Strict: anything else (unknown resource,
 * extra segments, inherited Object keys like "constructor") is `not_found`.
 */
export function resolveRoute(pathname: string): RouteMatch {
  const segments = pathname.replace(/^\/api-v1\/?/, '').split('/').filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return { kind: 'not_found' };
  const def = RESOURCES.find((r) => r.name === segments[0]);
  if (!def) return { kind: 'not_found' };
  return { kind: 'ok', resource: def.name, table: def.table, scope: def.scope, id: segments[1] ?? null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Same clamping the function always had, plus truncation of fractional values. */
export function parseLimit(raw: string | null): number {
  return Math.min(Math.max(Math.trunc(Number(raw)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export type BeforeParse = { ok: true; value: string | null } | { ok: false };
const BEFORE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

export function parseBefore(raw: string | null): BeforeParse {
  if (raw === null) return { ok: true, value: null };
  let value = raw.trim();
  if (value === '') return { ok: true, value: null };
  // A "+" in an unencoded query string arrives as " " — restore it so the
  // `next_before` we return can be pasted back as-is.
  value = value.replace(/^(.*\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?) (\d{2}(?::?\d{2})?)$/, '$1+$2');
  const m = BEFORE_RE.exec(value);
  if (!m) return { ok: false };
  const [, , month, day, hour, minute, second] = m;
  const within = (v: string | undefined, min: number, max: number) => v === undefined || (Number(v) >= min && Number(v) <= max);
  if (!within(month, 1, 12) || !within(day, 1, 31) || !within(hour, 0, 23) || !within(minute, 0, 59) || !within(second, 0, 59)) {
    return { ok: false };
  }
  return { ok: true, value };
}

/* ------------------------------------------------------------------ */
/*  Operations (one per route) — the list the spec and the page share   */
/* ------------------------------------------------------------------ */

export interface ApiOperation {
  /** OpenAPI operationId, e.g. listCalls / getCall. */
  id: string;
  method: 'GET';
  /** Express-style path, e.g. /calls/:id */
  path: string;
  resource: ApiResourceName;
  scope: string;
  description: string;
  hasId: boolean;
  /** Documented response status codes, ascending. */
  statuses: string[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const singular = (name: string) => name.slice(0, -1);

export function listOperations(): ApiOperation[] {
  return RESOURCES.flatMap((r) => [
    {
      id: `list${cap(r.name)}`,
      method: 'GET' as const,
      path: `/${r.name}`,
      resource: r.name,
      scope: r.scope,
      description: `List ${r.name}, newest first (cursor-paginated).`,
      hasId: false,
      statuses: ['200', '400', '401', '403', '429', '500'],
    },
    {
      id: `get${cap(singular(r.name))}`,
      method: 'GET' as const,
      path: `/${r.name}/:id`,
      resource: r.name,
      scope: r.scope,
      description: `Fetch a single ${singular(r.name)} by ID.`,
      hasId: true,
      statuses: ['200', '400', '401', '403', '404', '429', '500'],
    },
  ]);
}

/* ------------------------------------------------------------------ */
/*  OpenAPI 3.1                                                         */
/* ------------------------------------------------------------------ */

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: { $ref: string }[];
  security: Record<string, string[]>[];
  'x-required-scope': string;
  'x-codeSamples': { lang: string; label: string; source: string }[];
  responses: Record<string, unknown>;
}

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    summary: string;
    version: string;
    description: string;
    contact: { name: string; url: string };
  };
  servers: { url: string; description: string; variables?: Record<string, { default: string; description: string }> }[];
  tags: { name: string; description: string }[];
  externalDocs: { description: string; url: string };
  security: Record<string, string[]>[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, unknown>;
    parameters: Record<string, unknown>;
    headers: Record<string, unknown>;
    responses: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

const EXAMPLE_ID = '3f2b8c1e-7a4d-4e0b-9c5a-1d2e3f4a5b6c';
const EXAMPLE_USER = '9a1c5e72-2b3d-4f60-8a7e-6c5d4b3a2f10';
const EXAMPLE_CUSTOMER = 'c7d6e5f4-a3b2-4c1d-9e8f-0a1b2c3d4e5f';
const EXAMPLE_TS = '2026-10-09T14:32:07.512+00:00';

export const SCHEMA_EXAMPLES: Record<ResourceDef['schema'], Record<string, unknown>> = {
  Call: {
    id: EXAMPLE_ID,
    user_id: EXAMPLE_USER,
    external_id: 'call_01HV3K8Q2M',
    caller_phone: '+15551234567',
    caller_name: 'Jordan Lee',
    call_datetime: EXAMPLE_TS,
    duration_seconds: 187,
    summary: 'Homeowner reported an AC failure and asked for a morning appointment tomorrow.',
    transcript: 'Caller: Hi, my AC stopped working this morning.\nAgent: I’m sorry to hear that. Can I get your address?',
    recording_url: 'https://example.com/recordings/call_01HV3K8Q2M.mp3',
    is_emergency: false,
    sentiment: 'neutral',
    status: 'new_lead',
    tags: ['hvac', 'repair'],
    customer_id: EXAMPLE_CUSTOMER,
    created_at: EXAMPLE_TS,
  },
  Lead: {
    id: EXAMPLE_ID,
    user_id: EXAMPLE_USER,
    call_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
    name: 'Jordan Lee',
    phone: '+15551234567',
    email: 'jordan.lee@example.com',
    service_interested: 'AC repair',
    notes: 'Prefers a morning window.',
    stage: 'new',
    tags: ['hvac'],
    customer_id: EXAMPLE_CUSTOMER,
    created_at: EXAMPLE_TS,
  },
  Job: {
    id: EXAMPLE_ID,
    user_id: EXAMPLE_USER,
    lead_id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
    call_id: '5e4d3c2b-1a09-4f8e-b7d6-c5b4a3928170',
    customer_id: EXAMPLE_CUSTOMER,
    customer_name: 'Jordan Lee',
    service_type: 'HVAC diagnostic',
    address: '742 Evergreen Terrace, Springfield',
    scheduled_datetime: '2026-10-10T09:00:00+00:00',
    assigned_technician_id: '8b7a6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d',
    job_status: 'scheduled',
    invoice_amount: 189,
    invoice_status: 'not_sent',
    notes: null,
    completed_at: null,
    created_at: EXAMPLE_TS,
  },
};

function schemaFor(resource: ResourceDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of resource.fields) {
    const prop: Record<string, unknown> = {
      type: field.nullable ? [field.type, 'null'] : field.type,
      description: field.description,
    };
    if (field.format) prop.format = field.format;
    if (field.type === 'array') prop.items = { type: 'string' };
    properties[field.name] = prop;
    if (!field.nullable) required.push(field.name);
  }
  return {
    type: 'object',
    description: `${resource.description} Additional fields may be present and can be added over time.`,
    required,
    properties,
    additionalProperties: true,
    examples: [SCHEMA_EXAMPLES[resource.schema]],
  };
}

/**
 * Builds the OpenAPI 3.1 document. Pass a concrete `baseUrl` for a ready-to-use
 * server entry; omit it for a `{projectRef}` server variable.
 */
export function buildOpenApiSpec(baseUrl?: string): OpenApiSpec {
  const curlBase = baseUrl ?? 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/api-v1';

  const paths: OpenApiSpec['paths'] = {};
  for (const op of listOperations()) {
    const resource = RESOURCES.find((r) => r.name === op.resource) as ResourceDef;
    const responses: Record<string, unknown> = {
      '200': {
        description: op.hasId ? `The ${singular(resource.name)}.` : `A page of ${resource.name}, newest first.`,
        content: {
          'application/json': {
            schema: op.hasId
              ? { type: 'object', required: ['data'], properties: { data: { $ref: `#/components/schemas/${resource.schema}` } } }
              : { $ref: `#/components/schemas/${resource.schema}List` },
          },
        },
      },
    };
    for (const code of op.statuses) if (code !== '200') responses[code] = { $ref: `#/components/responses/${code}` };

    const url = op.hasId ? `${curlBase}/${resource.name}/${EXAMPLE_ID}` : `${curlBase}/${resource.name}?limit=${DEFAULT_LIMIT}`;
    paths[toOpenApiPath(op.path)] = {
      get: {
        operationId: op.id,
        summary: op.description,
        description: `${op.description} ${resource.description} Requires the \`${op.scope}\` scope.`,
        tags: [resource.tag],
        parameters: op.hasId
          ? [{ $ref: '#/components/parameters/id' }]
          : [{ $ref: '#/components/parameters/limit' }, { $ref: '#/components/parameters/before' }],
        security: [{ bearerAuth: [op.scope] }],
        'x-required-scope': op.scope,
        'x-codeSamples': [{ lang: 'Shell', label: 'cURL', source: `curl -sS "${url}" \\\n  -H "Authorization: Bearer vrk_live_YOUR_KEY"` }],
        responses,
      },
    };
  }

  const schemas: Record<string, unknown> = {
    Error: {
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'string', description: 'Human-readable error message.' } },
      examples: [{ error: 'Invalid or revoked API key' }],
    },
  };
  for (const resource of RESOURCES) {
    schemas[resource.schema] = schemaFor(resource);
    schemas[`${resource.schema}List`] = {
      type: 'object',
      required: ['data', 'has_more', 'next_before'],
      properties: {
        data: { type: 'array', items: { $ref: `#/components/schemas/${resource.schema}` } },
        has_more: { type: 'boolean', description: 'True when another page may exist.' },
        next_before: {
          type: ['string', 'null'],
          format: 'date-time',
          description: 'Pass as `before` to fetch the next page. Null when the page is empty.',
        },
      },
    };
  }

  const responses: Record<string, unknown> = {};
  for (const [code, description] of Object.entries(ERROR_RESPONSES)) {
    responses[code] = {
      description,
      ...(code === '429' ? { headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } } } : {}),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Vireek API',
      summary: 'Read-only REST API for your Vireek calls, leads and jobs.',
      version: API_VERSION,
      description: [
        'Read-only access to your Vireek calls, leads and jobs.',
        '',
        '**Authentication** — send a scoped API key as `Authorization: Bearer vrk_live_…`. Create, rotate and revoke keys under Settings → API Keys. Every request is logged per key.',
        '',
        `**Rate limit** — ${RATE_LIMIT_PER_MINUTE} requests per minute per key. Exceeding it returns \`429\` with a \`Retry-After\` header.`,
        '',
        `**Pagination** — list endpoints return newest first as \`{ data, has_more, next_before }\`. Pass \`next_before\` back as \`before\` for the next page (\`limit\`: 1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        '',
        'Only `GET` is supported; other methods return `405`.',
      ].join('\n'),
      contact: { name: 'Vireek Developers', url: 'https://vireek.com/developers/api-reference' },
    },
    servers: baseUrl
      ? [{ url: baseUrl, description: 'Vireek API' }]
      : [
          {
            url: TEMPLATE_SERVER_URL,
            description: 'Your Vireek project',
            variables: { projectRef: { default: 'your-project-ref', description: 'Supabase project reference of your Vireek deployment.' } },
          },
        ],
    tags: RESOURCES.map((r) => ({ name: r.tag, description: r.description })),
    externalDocs: { description: 'Guides & webhooks', url: 'https://vireek.com/docs' },
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'vrk_live_…',
          description: 'API key, sent as `Authorization: Bearer vrk_live_…`. Scopes are enforced per endpoint (see `x-required-scope`).',
        },
      },
      parameters: {
        id: { name: 'id', in: 'path', required: true, description: 'Record ID (UUID).', schema: { type: 'string', format: 'uuid' } },
        limit: {
          name: 'limit',
          in: 'query',
          required: false,
          description: LIST_PARAMETERS[0].description,
          schema: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        },
        before: {
          name: 'before',
          in: 'query',
          required: false,
          description: LIST_PARAMETERS[1].description,
          schema: { type: 'string', format: 'date-time' },
        },
      },
      headers: {
        RetryAfter: { description: 'Seconds to wait before retrying.', schema: { type: 'integer', examples: [60] } },
      },
      responses,
      schemas,
    },
  };
}

/** Exact bytes written to public/openapi.json. */
export function serializeSpec(spec: OpenApiSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/*  Validation (used by tests AND the CI check script)                  */
/* ------------------------------------------------------------------ */

function walk(node: unknown, visit: (key: string, value: unknown, path: string) => void, path = ''): void {
  if (Array.isArray(node)) node.forEach((n, i) => walk(n, visit, `${path}/${i}`));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      visit(k, v, `${path}/${k}`);
      walk(v, visit, `${path}/${k}`);
    }
  }
}

function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], doc);
}

/** Structural checks for what this generator emits. Returns human-readable problems ([] = valid). */
export function validateSpec(spec: OpenApiSpec): string[] {
  const problems: string[] = [];
  if (!/^3\.1\.\d+$/.test(spec.openapi)) problems.push(`openapi must be 3.1.x, got "${spec.openapi}"`);
  if (!spec.servers?.length) problems.push('servers must not be empty');

  walk(spec, (key, value, path) => {
    if (key === 'nullable') problems.push(`${path}: "nullable" is OpenAPI 3.0 — use a type array like ["string","null"]`);
    if (key === '$ref' && typeof value === 'string' && resolvePointer(spec, value) === undefined) problems.push(`${path}: unresolved $ref ${value}`);
  });

  const operationIds = new Set<string>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const [method, op] of Object.entries(methods)) {
      const where = `${method.toUpperCase()} ${path}`;
      if (operationIds.has(op.operationId)) problems.push(`${where}: duplicate operationId ${op.operationId}`);
      operationIds.add(op.operationId);
      if (!op.responses['200']) problems.push(`${where}: missing 200 response`);
      if (!op.responses['401']) problems.push(`${where}: missing 401 response`);
      if (op.security?.[0]?.bearerAuth?.[0] !== op['x-required-scope']) problems.push(`${where}: security scope and x-required-scope differ`);
      const declared = op.parameters
        .map((p) => resolvePointer(spec, p.$ref) as { name: string; in: string } | undefined)
        .filter((p): p is { name: string; in: string } => !!p && p.in === 'path')
        .map((p) => p.name);
      for (const name of placeholders) if (!declared.includes(name)) problems.push(`${where}: path parameter {${name}} is not declared`);
    }
  }

  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    const s = schema as { required?: string[]; properties?: Record<string, unknown> };
    for (const req of s.required ?? []) if (!s.properties || !(req in s.properties)) problems.push(`schema ${name}: required "${req}" is not a declared property`);
  }
  return problems;
}

/**
 * Static guard over supabase/functions/api-v1/index.ts: routing, limits and
 * methods must come from this file, so the function cannot grow a route or
 * rule the spec does not describe. Returns problems ([] = ok).
 */
export function checkEdgeFunctionSource(source: string): string[] {
  const problems: string[] = [];
  const need = (re: RegExp, msg: string) => {
    if (!re.test(source)) problems.push(msg);
  };
  const forbid = (re: RegExp, msg: string) => {
    if (re.test(source)) problems.push(msg);
  };
  need(/from\s+["']\.\/contract\.ts["']/, 'index.ts must import from "./contract.ts"');
  need(/\bresolveRoute\(/, 'index.ts must route with resolveRoute() from contract.ts');
  need(/\bparseLimit\(/, 'index.ts must read `limit` with parseLimit() from contract.ts');
  need(/\bparseBefore\(/, 'index.ts must read `before` with parseBefore() from contract.ts');
  need(/\bisUuid\(/, 'index.ts must validate ids with isUuid() from contract.ts');
  need(/\bRATE_LIMIT_PER_MINUTE\b/, 'index.ts must use RATE_LIMIT_PER_MINUTE from contract.ts');
  forbid(/\bTABLE_BY_RESOURCE\b/, 'index.ts still defines its own route table (TABLE_BY_RESOURCE) — move it to contract.ts');
  forbid(/\bconst\s+RATE_LIMIT_PER_MINUTE\s*=/, 'index.ts redefines RATE_LIMIT_PER_MINUTE — import it from contract.ts');
  forbid(/\.split\(\s*["']\/["']\s*\)/, 'index.ts splits the path itself — routing belongs in resolveRoute() (contract.ts)');
  forbid(/Math\.max\(\s*Number\(/, 'index.ts clamps `limit` itself — use parseLimit() (contract.ts)');
  for (const m of source.matchAll(/req\.method\s*[!=]==?\s*["'](\w+)["']/g)) {
    if (m[1] !== 'GET' && m[1] !== 'OPTIONS') problems.push(`index.ts handles method ${m[1]}, which the OpenAPI spec does not document`);
  }
  return problems;
}
