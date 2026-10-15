/**
 * OpenAPI 3 spec + Postman collection for the public `api-v1` edge function.
 *
 * The endpoint list is NOT duplicated here — it is derived from
 * SANDBOX_ENDPOINTS (src/lib/sandbox.ts), which the playground already
 * uses, so the spec, the playground and the reference page cannot drift.
 * Only resource schemas live in this file.
 *
 * Pure functions, no network access.
 */

import { SANDBOX_ENDPOINTS, type SandboxEndpoint } from '@/lib/sandbox';

export const API_VERSION = '1.0.0';
export const PLACEHOLDER_BASE_URL = 'https://<your-project-ref>.supabase.co/functions/v1/api-v1';

export function resolveApiBaseUrl(): string {
  const raw = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/$/, '');
  return raw ? `${raw}/functions/v1/api-v1` : PLACEHOLDER_BASE_URL;
}

/* ------------------------------------------------------------------ */
/*  Resource schemas                                                    */
/* ------------------------------------------------------------------ */

export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'array';

export interface FieldDef {
  name: string;
  type: FieldType;
  format?: 'uuid' | 'date-time';
  nullable?: boolean;
  description: string;
}

export interface ResourceDef {
  name: 'calls' | 'leads' | 'jobs';
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

export function resourceByName(name: string): ResourceDef | undefined {
  return RESOURCES.find((r) => r.name === name);
}

/* ------------------------------------------------------------------ */
/*  Shared constants (used by the spec AND the reference page)          */
/* ------------------------------------------------------------------ */

export const LIST_PARAMETERS = [
  { name: 'limit', type: 'integer', description: 'Max rows to return (1–100). Defaults to 25.' },
  { name: 'before', type: 'ISO 8601 timestamp', description: 'Return rows created before this timestamp — pass the previous page\'s next_before.' },
] as const;

export const ERROR_RESPONSES: Record<string, string> = {
  '401': 'Missing, invalid or revoked API key.',
  '403': 'The key is missing the scope this endpoint requires.',
  '404': 'The requested record does not exist on your account.',
  '500': 'Unexpected server error.',
};

/** `/calls/:id` → `/calls/{id}` */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_]+)/g, '{$1}');
}

export function resourceOfEndpoint(ep: SandboxEndpoint): string {
  return ep.path.split('/').filter(Boolean)[0] ?? '';
}

function operationId(ep: SandboxEndpoint, resource: ResourceDef): string {
  const singular = resource.name.slice(0, -1); // calls → call
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return ep.hasId ? `get${cap(singular)}` : `list${cap(resource.name)}`;
}

function endpointResponseCodes(ep: SandboxEndpoint): string[] {
  return ep.hasId ? ['401', '403', '404', '500'] : ['401', '403', '500'];
}

/* ------------------------------------------------------------------ */
/*  OpenAPI                                                             */
/* ------------------------------------------------------------------ */

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: { $ref: string }[];
  'x-required-scope': string;
  responses: Record<string, unknown>;
}

export interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  security: Record<string, string[]>[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, unknown>;
    parameters: Record<string, unknown>;
    responses: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

function schemaFor(resource: ResourceDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of resource.fields) {
    const prop: Record<string, unknown> = { type: field.type, description: field.description };
    if (field.format) prop.format = field.format;
    if (field.nullable) prop.nullable = true;
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
  };
}

export function buildOpenApiSpec(baseUrl: string = resolveApiBaseUrl()): OpenApiSpec {
  const paths: OpenApiSpec['paths'] = {};
  for (const ep of SANDBOX_ENDPOINTS) {
    const resource = resourceByName(resourceOfEndpoint(ep));
    if (!resource) continue;

    const responses: Record<string, unknown> = {
      '200': {
        description: ep.hasId ? `The ${resource.schema.toLowerCase()}.` : `A page of ${resource.name}, newest first.`,
        content: {
          'application/json': {
            schema: ep.hasId
              ? { type: 'object', required: ['data'], properties: { data: { $ref: `#/components/schemas/${resource.schema}` } } }
              : { $ref: `#/components/schemas/${resource.schema}List` },
          },
        },
      },
    };
    for (const code of endpointResponseCodes(ep)) responses[code] = { $ref: `#/components/responses/${code}` };

    const operation: OpenApiOperation = {
      operationId: operationId(ep, resource),
      summary: ep.description,
      description: `${ep.description} Requires the \`${ep.scope}\` scope.`,
      tags: [resource.tag],
      parameters: ep.hasId
        ? [{ $ref: '#/components/parameters/id' }]
        : [{ $ref: '#/components/parameters/limit' }, { $ref: '#/components/parameters/before' }],
      'x-required-scope': ep.scope,
      responses,
    };
    paths[toOpenApiPath(ep.path)] = { [ep.method.toLowerCase()]: operation };
  }

  const schemas: Record<string, unknown> = {
    Error: {
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'string', description: 'Human-readable error message.' } },
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
          type: 'string',
          format: 'date-time',
          nullable: true,
          description: 'Pass as `before` to fetch the next page. Null when the page is empty.',
        },
      },
    };
  }

  const responses: Record<string, unknown> = {};
  for (const [code, description] of Object.entries(ERROR_RESPONSES)) {
    responses[code] = {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Vireek API',
      version: API_VERSION,
      description:
        'Read-only access to your Vireek calls, leads and jobs. Authenticate with a scoped API key created under Settings → API Keys. Every request is logged per key.',
    },
    servers: [{ url: baseUrl, description: 'Your Vireek project' }],
    tags: RESOURCES.map((r) => ({ name: r.tag, description: r.description })),
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
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
        before: {
          name: 'before',
          in: 'query',
          required: false,
          description: LIST_PARAMETERS[1].description,
          schema: { type: 'string', format: 'date-time' },
        },
      },
      responses,
      schemas,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Postman                                                             */
/* ------------------------------------------------------------------ */

export const POSTMAN_SCHEMA_URL = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

export function buildPostmanCollection(baseUrl: string = resolveApiBaseUrl()): Record<string, unknown> {
  const folders = RESOURCES.map((resource) => {
    const items = SANDBOX_ENDPOINTS.filter((ep) => resourceOfEndpoint(ep) === resource.name).map((ep) => {
      const url: Record<string, unknown> = ep.hasId
        ? {
            raw: `{{base_url}}${ep.path}`,
            host: ['{{base_url}}'],
            path: ep.path.split('/').filter(Boolean),
            variable: [{ key: 'id', value: '', description: 'Record ID (UUID).' }],
          }
        : {
            raw: `{{base_url}}${ep.path}?limit=25`,
            host: ['{{base_url}}'],
            path: ep.path.split('/').filter(Boolean),
            query: [
              { key: 'limit', value: '25', description: LIST_PARAMETERS[0].description },
              { key: 'before', value: '', description: LIST_PARAMETERS[1].description, disabled: true },
            ],
          };
      return {
        name: ep.hasId ? `Get ${resource.schema.toLowerCase()}` : `List ${resource.name}`,
        request: {
          method: ep.method,
          header: [{ key: 'Accept', value: 'application/json' }],
          url,
          description: `${ep.description} Requires the ${ep.scope} scope.`,
        },
        event: [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: ["pm.test('Status is 200', function () { pm.response.to.have.status(200); });"],
            },
          },
        ],
      };
    });
    return { name: resource.tag, description: resource.description, item: items };
  });

  return {
    info: {
      name: 'Vireek API',
      description: 'Read-only access to Vireek calls, leads and jobs. Set the `api_key` collection variable to a key from Settings → API Keys.',
      schema: POSTMAN_SCHEMA_URL,
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{api_key}}', type: 'string' }] },
    variable: [
      { key: 'base_url', value: baseUrl },
      { key: 'api_key', value: '' },
    ],
    item: folders,
  };
}

/* ------------------------------------------------------------------ */
/*  Download helper                                                     */
/* ------------------------------------------------------------------ */

export function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
