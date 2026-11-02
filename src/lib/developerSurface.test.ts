/**
 * Tests for the developer surface added on top of the api-v1 contract:
 * error catalog, webhook catalog, code samples and the drift guard for index.ts.
 * `node scripts/run-samples.mjs` (CI) additionally EXECUTES the samples.
 */
import { describe, expect, it } from 'vitest';
import publishedRaw from '../../public/openapi.json?raw';
import edgeFunctionSource from '../../supabase/functions/api-v1/index.ts?raw';
import {
  ERROR_CATALOG,
  ERROR_DOC_BASE,
  ERROR_RESPONSES,
  RESOURCES,
  SCHEMA_EXAMPLES,
  WEBHOOK_EVENTS,
  buildCodeSamples,
  buildOpenApiSpec,
  checkEdgeFunctionSource,
  errorBody,
  errorStatus,
  validateSpec,
  webhookSample,
} from '../../supabase/functions/api-v1/contract';

const RID = '6b1f0c52-8d3e-4a7b-9f21-0e5d4c3b2a19';

describe('error catalog', () => {
  it('has unique codes and valid HTTP statuses', () => {
    const codes = ERROR_CATALOG.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const e of ERROR_CATALOG) {
      expect(e.status).toBeGreaterThanOrEqual(400);
      expect(e.status).toBeLessThan(600);
      expect(e.cause.length).toBeGreaterThan(10);
      expect(e.fix.length).toBeGreaterThan(3);
    }
  });

  it('agrees with the documented response statuses in both directions', () => {
    const catalogStatuses = new Set(ERROR_CATALOG.map((e) => String(e.status)));
    for (const status of Object.keys(ERROR_RESPONSES))
      expect(catalogStatuses.has(status)).toBe(true);
    // 405 is not a per-operation response, everything else must be documented.
    for (const status of catalogStatuses)
      if (status !== '405') expect(status in ERROR_RESPONSES).toBe(true);
  });

  it('builds a consistent body with a string `error` (existing clients) plus code, doc_url, request_id', () => {
    for (const e of ERROR_CATALOG) {
      const body = errorBody(e.code, 'message', RID);
      expect(body).toEqual({
        error: 'message',
        code: e.code,
        doc_url: `${ERROR_DOC_BASE}${e.code}`,
        request_id: RID,
      });
      expect(errorStatus(e.code)).toBe(e.status);
    }
  });
});

describe('index.ts drift guard (error format)', () => {
  it('passes for the real function', () => {
    expect(checkEdgeFunctionSource(edgeFunctionSource)).toEqual([]);
  });

  it('fails when a raw { error } body is returned or errorBody() is not used', () => {
    expect(
      checkEdgeFunctionSource(
        `${edgeFunctionSource}\nconst x = json({ error: "oops" }, 500);`,
      ).join(' '),
    ).toMatch(/raw \{ error \}/);
    expect(checkEdgeFunctionSource(edgeFunctionSource.replaceAll('errorBody(', 'x('))).toEqual(
      expect.arrayContaining([expect.stringContaining('errorBody()')]),
    );
  });

  it('sends the request id and rate-limit headers and exposes them to browsers', () => {
    expect(edgeFunctionSource).toContain('"X-Request-Id"');
    expect(edgeFunctionSource).toContain('"X-RateLimit-Limit"');
    expect(edgeFunctionSource).toMatch(/Access-Control-Expose-Headers.*X-Request-Id/);
  });
});

describe('OpenAPI: errors, headers, samples, webhooks', () => {
  const spec = buildOpenApiSpec('https://example.supabase.co/functions/v1/api-v1');

  it('is still structurally valid and the published file is in sync', () => {
    expect(validateSpec(spec)).toEqual([]);
    expect(publishedRaw).toContain('"webhooks"');
  });

  it('Error schema lists every catalog code and requires the new fields', () => {
    const error = spec.components.schemas.Error as {
      required: string[];
      properties: { code: { enum: string[] } };
    };
    expect(error.required).toEqual(['error', 'code', 'doc_url', 'request_id']);
    expect(error.properties.code.enum).toEqual(ERROR_CATALOG.map((e) => e.code));
  });

  it('every operation has cURL, JavaScript, Python and Go samples that read the key from the environment', () => {
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) {
        expect(op['x-codeSamples'].map((s) => s.label)).toEqual([
          'cURL',
          'JavaScript',
          'Python',
          'Go',
        ]);
        for (const s of op['x-codeSamples']) {
          expect(s.source).not.toMatch(/vrk_live_[A-Za-z0-9]/);
          expect(s.source).toContain('VIREEK_API_KEY');
        }
      }
    }
  });

  it('documents one webhook per catalog event, with Beta ones marked', () => {
    expect(Object.keys(spec.webhooks).sort()).toEqual(WEBHOOK_EVENTS.map((w) => w.event).sort());
    for (const w of WEBHOOK_EVENTS) {
      const op = (spec.webhooks[w.event] as { post: Record<string, unknown> }).post;
      expect(op['x-stability']).toBe(w.stability);
    }
    expect(WEBHOOK_EVENTS.filter((w) => w.stability === 'stable').map((w) => w.event)).toEqual([
      'call.created',
      'lead.created',
      'job.created',
    ]);
  });
});

describe('webhook samples', () => {
  it('sample payloads for resource events contain every required field of the resource schema', () => {
    for (const w of WEBHOOK_EVENTS.filter((e) => e.schema)) {
      const resource = RESOURCES.find((r) => r.schema === w.schema)!;
      const data = (webhookSample(w).data ?? {}) as Record<string, unknown>;
      for (const field of resource.fields.filter((f) => !f.nullable))
        expect(data).toHaveProperty(field.name);
      expect(data).toEqual(SCHEMA_EXAMPLES[w.schema!]);
    }
  });

  it('uses the envelope the sender builds: id, event, created_at, data', () => {
    for (const w of WEBHOOK_EVENTS)
      expect(Object.keys(webhookSample(w))).toEqual(['id', 'event', 'created_at', 'data']);
  });
});

describe('buildCodeSamples', () => {
  it('turns query params into native request params and keeps the URL intact elsewhere', () => {
    const [curl, js, py, go] = buildCodeSamples('https://h.example/api-v1/calls?limit=25');
    expect(curl.source).toContain('"https://h.example/api-v1/calls?limit=25"');
    expect(js.source).toContain('fetch("https://h.example/api-v1/calls?limit=25"');
    expect(py.source).toContain('"https://h.example/api-v1/calls",');
    expect(py.source).toContain('params={"limit": 25}');
    expect(go.source).toContain(
      'http.NewRequest("GET", "https://h.example/api-v1/calls?limit=25", nil)',
    );
  });

  it('omits params for by-id URLs', () => {
    const py = buildCodeSamples('https://h.example/api-v1/calls/abc')[2];
    expect(py.source).not.toContain('params=');
  });
});
