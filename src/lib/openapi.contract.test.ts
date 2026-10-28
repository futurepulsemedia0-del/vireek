/**
 * Contract tests for the public api-v1 edge function.
 *
 * supabase/functions/api-v1/contract.ts is the single source of truth. These
 * tests prove that the router the function uses, the OpenAPI 3.1 document, the
 * published /openapi.json, the playground catalog and the function's own source
 * all describe the same API. `npm run openapi:check` enforces the same in CI.
 */
import { describe, expect, it } from 'vitest';
import publishedRaw from '../../public/openapi.json?raw';
import edgeFunctionSource from '../../supabase/functions/api-v1/index.ts?raw';
import { SANDBOX_ENDPOINTS } from '@/lib/sandbox';
import { PLACEHOLDER_BASE_URL, buildOpenApiSpec as buildAppSpec } from '@/lib/openapi';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RESOURCES,
  SCHEMA_EXAMPLES,
  buildOpenApiSpec,
  checkEdgeFunctionSource,
  isUuid,
  listOperations,
  parseBefore,
  parseLimit,
  resolveRoute,
  serializeSpec,
  toOpenApiPath,
  validateSpec,
  type OpenApiSpec,
} from '../../supabase/functions/api-v1/contract';

const BASE = 'https://example.supabase.co/functions/v1/api-v1';
const UUID = '3f2b8c1e-7a4d-4e0b-9c5a-1d2e3f4a5b6c';

function routesOf(spec: OpenApiSpec): string[] {
  return Object.entries(spec.paths)
    .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`))
    .sort();
}

/** The routes the API is supposed to expose, derived from the resource list only. */
function expectedRoutes(): string[] {
  return RESOURCES.flatMap((r) => [`GET /${r.name}`, `GET /${r.name}/{id}`]).sort();
}

describe('resolveRoute (the router index.ts uses)', () => {
  it('resolves every documented list and by-id route with the right table and scope', () => {
    for (const r of RESOURCES) {
      expect(resolveRoute(`/api-v1/${r.name}`)).toEqual({ kind: 'ok', resource: r.name, table: r.table, scope: r.scope, id: null });
      expect(resolveRoute(`/api-v1/${r.name}/${UUID}`)).toEqual({ kind: 'ok', resource: r.name, table: r.table, scope: r.scope, id: UUID });
      expect(r.scope).toBe(`${r.name}:read`);
    }
  });

  it('tolerates a trailing slash', () => {
    expect(resolveRoute('/api-v1/calls/').kind).toBe('ok');
  });

  it('is strict: unknown resources, extra segments and the bare root are not found', () => {
    for (const path of ['/api-v1', '/api-v1/', '/api-v1/nope', `/api-v1/calls/${UUID}/extra`, '/api-v1/calls/a/b/c']) {
      expect(resolveRoute(path).kind, path).toBe('not_found');
    }
  });

  it('never matches inherited Object keys', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(resolveRoute(`/api-v1/${name}`).kind, name).toBe('not_found');
    }
  });
});

describe('input parsing', () => {
  it('parseLimit clamps to 1–100, defaults to 25 and truncates fractions', () => {
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('')).toBe(DEFAULT_LIMIT);
    expect(parseLimit('abc')).toBe(DEFAULT_LIMIT);
    expect(parseLimit('0')).toBe(DEFAULT_LIMIT);
    expect(parseLimit('-3')).toBe(1);
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('2.7')).toBe(2);
    expect(parseLimit('100')).toBe(MAX_LIMIT);
    expect(parseLimit('5000')).toBe(MAX_LIMIT);
  });

  it('isUuid accepts UUIDs and rejects everything else', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    for (const bad of ['', 'abc', '123', `${UUID}x`, "' or 1=1 --", '../etc/passwd']) expect(isUuid(bad), bad).toBe(false);
  });

  it('parseBefore accepts ISO 8601 timestamps and treats empty as absent', () => {
    expect(parseBefore(null)).toEqual({ ok: true, value: null });
    expect(parseBefore('')).toEqual({ ok: true, value: null });
    expect(parseBefore('2026-10-09')).toEqual({ ok: true, value: '2026-10-09' });
    expect(parseBefore('2026-10-09T14:32:07Z')).toEqual({ ok: true, value: '2026-10-09T14:32:07Z' });
    expect(parseBefore('2026-10-09T14:32:07.512345+00:00')).toEqual({ ok: true, value: '2026-10-09T14:32:07.512345+00:00' });
  });

  it('parseBefore restores a "+" that an unencoded query string turned into a space', () => {
    expect(parseBefore('2026-10-09T14:32:07.512 00:00')).toEqual({ ok: true, value: '2026-10-09T14:32:07.512+00:00' });
  });

  it('parseBefore rejects malformed or out-of-range values', () => {
    for (const bad of ['garbage', '2026-13-01', '2026-10-32', '2026-10-09T25:00:00Z', '2026-10-09T10:61:00Z', '1; drop table calls', '2026-10-09T']) {
      expect(parseBefore(bad), bad).toEqual({ ok: false });
    }
  });
});

describe('OpenAPI 3.1 document', () => {
  const spec = buildOpenApiSpec(BASE);

  it('is a valid 3.1 document (no 3.0-only keywords, every $ref resolves, ids unique)', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(validateSpec(spec)).toEqual([]);
    expect(JSON.stringify(spec)).not.toContain('"nullable"');
  });

  it('documents exactly the routes the API exposes — nothing more, nothing less', () => {
    expect(routesOf(spec)).toEqual(expectedRoutes());
  });

  it('every documented route resolves in the real router with the documented scope', () => {
    for (const [path, methods] of Object.entries(spec.paths)) {
      expect(Object.keys(methods)).toEqual(['get']);
      const match = resolveRoute(`/api-v1${path.replace('{id}', UUID)}`);
      expect(match.kind, path).toBe('ok');
      if (match.kind === 'ok') {
        expect(methods.get['x-required-scope']).toBe(match.scope);
        expect(methods.get.security).toEqual([{ bearerAuth: [match.scope] }]);
      }
    }
  });

  it('documents rate limiting (429 + Retry-After) and 400 on every operation, 404 only by id', () => {
    for (const methods of Object.values(spec.paths)) {
      expect(methods.get.responses).toHaveProperty('400');
      expect(methods.get.responses).toHaveProperty('429');
    }
    expect(spec.components.responses['429']).toHaveProperty('headers');
    expect(spec.paths['/calls'].get.responses).not.toHaveProperty('404');
    expect(spec.paths['/calls/{id}'].get.responses).toHaveProperty('404');
  });

  it('uses a {projectRef} server variable unless a base URL is given', () => {
    expect(spec.servers[0].url).toBe(BASE);
    const templated = buildOpenApiSpec();
    expect(templated.servers[0].url).toContain('{projectRef}');
    expect(templated.servers[0].variables).toHaveProperty('projectRef');
  });

  it('keeps schema examples consistent with their schemas', () => {
    for (const r of RESOURCES) {
      const example = SCHEMA_EXAMPLES[r.schema];
      const names = r.fields.map((f) => f.name);
      for (const f of r.fields) if (!f.nullable) expect(example, `${r.schema}.${f.name}`).toHaveProperty(f.name);
      for (const key of Object.keys(example)) expect(names, `${r.schema}.${key}`).toContain(key);
    }
  });

  it('the app wrapper passes real base URLs through and templates the placeholder', () => {
    expect(buildAppSpec(BASE).servers[0].url).toBe(BASE);
    expect(buildAppSpec(PLACEHOLDER_BASE_URL).servers[0].url).toContain('{projectRef}');
  });
});

describe('listOperations (shared by the spec and the reference page)', () => {
  const ops = listOperations();

  it('has one list and one by-id operation per resource', () => {
    expect(ops).toHaveLength(RESOURCES.length * 2);
    expect(ops.filter((o) => o.hasId)).toHaveLength(RESOURCES.length);
  });

  it('lists ascending status codes, with 404 only on by-id operations', () => {
    for (const op of ops) {
      expect(op.statuses).toEqual([...op.statuses].sort());
      expect(op.statuses).toContain('401');
      expect(op.statuses).toContain('429');
      expect(op.statuses.includes('404')).toBe(op.hasId);
    }
  });
});

describe('published /openapi.json', () => {
  const published = JSON.parse(publishedRaw) as OpenApiSpec;

  it('is valid OpenAPI 3.1', () => {
    expect(published.openapi).toBe('3.1.0');
    expect(validateSpec(published)).toEqual([]);
  });

  it('is byte-for-byte what the contract generates — run `npm run openapi:generate` if this fails', () => {
    expect(publishedRaw).toBe(serializeSpec(buildOpenApiSpec(published.servers[0].url)));
  });

  it('documents exactly the routes the API exposes', () => {
    expect(routesOf(published)).toEqual(expectedRoutes());
  });
});

describe('playground catalog parity', () => {
  it('SANDBOX_ENDPOINTS lists exactly the documented routes, with the documented scopes', () => {
    const spec = buildOpenApiSpec(BASE);
    expect(SANDBOX_ENDPOINTS.map((e) => `${e.method} ${toOpenApiPath(e.path)}`).sort()).toEqual(routesOf(spec));
    for (const e of SANDBOX_ENDPOINTS) {
      expect(e.scope, e.path).toBe(spec.paths[toOpenApiPath(e.path)].get['x-required-scope']);
    }
  });
});

describe('edge function guard (checkEdgeFunctionSource)', () => {
  it('passes for the real supabase/functions/api-v1/index.ts', () => {
    expect(checkEdgeFunctionSource(edgeFunctionSource)).toEqual([]);
  });

  it('fails when routing is re-implemented inside the function', () => {
    const rogue = `${edgeFunctionSource}\nconst TABLE_BY_RESOURCE = {};\nconst parts = url.pathname.split("/");`;
    const problems = checkEdgeFunctionSource(rogue).join('\n');
    expect(problems).toMatch(/TABLE_BY_RESOURCE/);
    expect(problems).toMatch(/splits the path itself/);
  });

  it('fails when the function starts handling an undocumented method', () => {
    const rogue = `${edgeFunctionSource}\nif (req.method === "POST") { /* create */ }`;
    expect(checkEdgeFunctionSource(rogue).join('\n')).toMatch(/method POST/);
  });

  it('fails when the contract import is removed', () => {
    const rogue = edgeFunctionSource.replace(/from\s+["']\.\/contract\.ts["']/, 'from "./other.ts"');
    expect(checkEdgeFunctionSource(rogue).join('\n')).toMatch(/must import from/);
  });
});

describe('validateSpec', () => {
  it('flags 3.0-isms and broken refs so drift is caught', () => {
    const broken = JSON.parse(JSON.stringify(buildOpenApiSpec(BASE))) as OpenApiSpec;
    broken.openapi = '3.0.3';
    (broken.components.schemas.Call as { properties: Record<string, Record<string, unknown>> }).properties.summary.nullable = true;
    broken.paths['/calls'].get.responses['400'] = { $ref: '#/components/responses/999' };
    const problems = validateSpec(broken).join('\n');
    expect(problems).toMatch(/must be 3\.1/);
    expect(problems).toMatch(/nullable/);
    expect(problems).toMatch(/unresolved \$ref/);
  });
});
