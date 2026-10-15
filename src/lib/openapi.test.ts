import { describe, expect, it } from 'vitest';
import { SANDBOX_ENDPOINTS } from '@/lib/sandbox';
import {
  POSTMAN_SCHEMA_URL,
  RESOURCES,
  buildOpenApiSpec,
  buildPostmanCollection,
  toOpenApiPath,
} from '@/lib/openapi';

const BASE = 'https://example.supabase.co/functions/v1/api-v1';

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

function resolve(spec: unknown, ref: string): unknown {
  return ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], spec);
}

describe('toOpenApiPath', () => {
  it('converts :param to {param}', () => {
    expect(toOpenApiPath('/calls/:id')).toBe('/calls/{id}');
    expect(toOpenApiPath('/calls')).toBe('/calls');
  });
});

describe('buildOpenApiSpec', () => {
  const spec = buildOpenApiSpec(BASE);

  it('is OpenAPI 3.0.3 with the given server and bearer auth', () => {
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.servers[0].url).toBe(BASE);
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.components.securitySchemes).toHaveProperty('bearerAuth');
  });

  it('documents exactly the endpoints the playground exposes, with matching scopes', () => {
    const ops = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => ({ path, method, op })),
    );
    expect(ops).toHaveLength(SANDBOX_ENDPOINTS.length);
    for (const ep of SANDBOX_ENDPOINTS) {
      const op = spec.paths[toOpenApiPath(ep.path)]?.[ep.method.toLowerCase()];
      expect(op, `${ep.method} ${ep.path}`).toBeDefined();
      expect(op['x-required-scope']).toBe(ep.scope);
    }
  });

  it('has unique operationIds and only documents 404 on by-id endpoints', () => {
    const ids = Object.values(spec.paths).flatMap((m) => Object.values(m).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(spec.paths['/calls/{id}'].get.responses).toHaveProperty('404');
    expect(spec.paths['/calls'].get.responses).not.toHaveProperty('404');
  });

  it('resolves every $ref', () => {
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(resolve(spec, ref), ref).toBeDefined();
  });

  it('keeps every required property declared in each schema', () => {
    for (const r of RESOURCES) {
      const schema = spec.components.schemas[r.schema] as { required: string[]; properties: Record<string, unknown> };
      for (const name of schema.required) expect(schema.properties).toHaveProperty(name);
    }
  });
});

describe('buildPostmanCollection', () => {
  const col = buildPostmanCollection(BASE) as {
    info: { schema: string };
    auth: { type: string };
    variable: { key: string; value: string }[];
    item: { name: string; item: { request: { method: string; url: { raw: string; variable?: unknown[] } } }[] }[];
  };

  it('is a v2.1 collection with bearer auth and an EMPTY api_key variable', () => {
    expect(col.info.schema).toBe(POSTMAN_SCHEMA_URL);
    expect(col.auth.type).toBe('bearer');
    expect(col.variable.find((v) => v.key === 'base_url')?.value).toBe(BASE);
    expect(col.variable.find((v) => v.key === 'api_key')?.value).toBe('');
  });

  it('contains one request per endpoint, grouped by resource', () => {
    const requests = col.item.flatMap((folder) => folder.item);
    expect(requests).toHaveLength(SANDBOX_ENDPOINTS.length);
    expect(col.item.map((f) => f.name)).toEqual(RESOURCES.map((r) => r.tag));
  });

  it('declares the :id path variable on by-id requests only', () => {
    const requests = col.item.flatMap((folder) => folder.item);
    const byId = requests.filter((r) => r.request.url.raw.endsWith(':id'));
    expect(byId).toHaveLength(SANDBOX_ENDPOINTS.filter((e) => e.hasId).length);
    for (const r of byId) expect(r.request.url.variable).toHaveLength(1);
  });
});
