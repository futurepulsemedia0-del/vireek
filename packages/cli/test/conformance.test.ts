// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { runConformance, summarize } from '../src/conformance.js';
import { main } from '../src/cli.js';
import { makeIo } from './helpers.js';

const KEY = 'vrk_agent_' + 'a1b2c3d4'.repeat(5);
const BASE = 'https://proj.supabase.co/functions/v1/mcp-server';
const TOOLS = [
  { name: 'find_customer', description: 'Look up one customer by phone.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'create_quote', description: 'Propose a quote (needs approval).', inputSchema: { type: 'object', properties: { idempotency_key: { type: 'string' } }, required: ['idempotency_key'], additionalProperties: false } },
];
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** A reference server that behaves correctly; `flaws` switches individual behaviours off. */
function server(flaws: { origin?: boolean; push?: boolean; strict?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const path = url.slice(BASE.length);
    const h = new Headers(init?.headers);
    if (path === '/a2a/agent-card') return j({ name: 'Vireek', description: 'x', url: BASE + '/a2a', version: '1', skills: [{ id: 'a' }], capabilities: {} });
    if (h.get('authorization') !== `Bearer ${KEY}`) return j({ error: 'unauthorized' }, 401);
    if (!flaws.origin && h.get('origin')) return j({ error: 'origin' }, 403);
    if (h.get('mcp-protocol-version') === '1999-01-01') return j({ error: 'bad version' }, 400);
    let body: any; try { body = JSON.parse(String(init?.body)); } catch { return j({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse' } }, 400); }
    if (body.id === undefined) return new Response(null, { status: 202 });
    const ok = (result: unknown) => j({ jsonrpc: '2.0', id: body.id, result });
    const err = (code: number) => j({ jsonrpc: '2.0', id: body.id, error: { code, message: 'e' } });
    if (path === '/a2a') {
      if (body.method === 'tasks/get') return err(-32001);
      return err(flaws.push ? -32004 : -32003);
    }
    switch (body.method) {
      case 'initialize': return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'v', version: '1' } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: flaws.strict ? TOOLS.map((t) => ({ ...t, inputSchema: { type: 'object' } })) : TOOLS });
      case 'tools/call': return TOOLS.some((t) => t.name === body.params.name) ? ok({ isError: true, content: [] }) : err(-32602);
      default: return err(-32601);
    }
  }) as typeof fetch;
}

describe('conformance self-test', () => {
  it('a correct server passes every check', async () => {
    const r = await runConformance({ baseUrl: BASE, key: KEY, fetchImpl: server() });
    expect(r.filter((x) => x.status === 'fail')).toEqual([]);
    expect(summarize(r).passed).toBeGreaterThanOrEqual(15);
  });
  it('detects real deviations (no Origin check, wrong push code, loose tool schemas)', async () => {
    const r = await runConformance({ baseUrl: BASE, key: KEY, fetchImpl: server({ origin: true, push: true, strict: true }) });
    const failed = r.filter((x) => x.status === 'fail').map((x) => x.id).sort();
    expect(failed).toEqual(['a2a-push', 'origin', 'tools-list']);
  });
  it('CLI: exit 0 on success, 1 on failure, 2 without a key, never prints the key', async () => {
    const ok = makeIo({ env: { VIREEK_AGENT_KEY: KEY, VIREEK_MCP_URL: BASE }, fetchImpl: server() });
    expect(await main(['conformance'], ok.io)).toBe(0);
    expect(ok.stdout()).toContain('0 failed');
    expect(ok.stdout() + ok.stderr()).not.toContain(KEY);
    const bad = makeIo({ env: { VIREEK_AGENT_KEY: KEY, VIREEK_MCP_URL: BASE }, fetchImpl: server({ origin: true }) });
    expect(await main(['conformance'], bad.io)).toBe(1);
    const nokey = makeIo({ env: { VIREEK_MCP_URL: BASE }, fetchImpl: server() });
    expect(await main(['conformance'], nokey.io)).toBe(2);
  });
});
