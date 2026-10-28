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

import { SANDBOX_ENDPOINTS } from '@/lib/sandbox';
import {
  API_VERSION,
  ERROR_RESPONSES,
  LIST_PARAMETERS,
  RESOURCES,
  buildOpenApiSpec as buildContractSpec,
  listOperations,
  resourceByName,
  resourceOfEndpoint,
  toOpenApiPath,
} from '../../supabase/functions/api-v1/contract';
import type {
  ApiOperation,
  FieldDef,
  FieldType,
  OpenApiOperation,
  OpenApiSpec,
  ResourceDef,
} from '../../supabase/functions/api-v1/contract';

// Contract lives next to the edge function (single source of truth); re-exported for existing imports.
export { API_VERSION, ERROR_RESPONSES, LIST_PARAMETERS, RESOURCES, listOperations, resourceByName, resourceOfEndpoint, toOpenApiPath };
export type { ApiOperation, FieldDef, FieldType, OpenApiOperation, OpenApiSpec, ResourceDef };

export const PLACEHOLDER_BASE_URL = 'https://<your-project-ref>.supabase.co/functions/v1/api-v1';

export function resolveApiBaseUrl(): string {
  const raw = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/$/, '');
  return raw ? `${raw}/functions/v1/api-v1` : PLACEHOLDER_BASE_URL;
}

/* ------------------------------------------------------------------ */
/*  OpenAPI 3.1 (generated from the contract)                          */
/* ------------------------------------------------------------------ */

/** Spec for the page's download button. The published copy lives at /openapi.json. */
export function buildOpenApiSpec(baseUrl: string = resolveApiBaseUrl()): OpenApiSpec {
  return buildContractSpec(baseUrl === PLACEHOLDER_BASE_URL ? undefined : baseUrl);
}

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
