import { describe, expect, it } from 'vitest';
import {
  TOOLS,
  canonicalJson,
  computeAvailability,
  escapeLike,
  getTool,
  hasScope,
  quoteTotals,
  summarizeStock,
  toolsForScopes,
  utcDays,
} from '../../supabase/functions/_shared/agent-network/tools';
import {
  RPC,
  a2aStateForStatus,
  buildAgentCard,
  extractA2aInvocation,
  mcpInitializeResult,
  mcpToolResult,
  mcpToolsList,
  negotiateMcpVersion,
  parseRpcBody,
} from '../../supabase/functions/_shared/agent-network/protocol';

const UUID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const UUID2 = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const KEY = 'order-0001-abc';

const validate = (tool: string, args: unknown) => getTool(tool)!.validate(args);

describe('tool registry', () => {
  it('every write tool has an action slug and an idempotency_key requirement', () => {
    for (const t of TOOLS.filter((x) => x.write)) {
      expect(t.actionSlug).toBeTruthy();
      expect((t.inputSchema.required as string[]).includes('idempotency_key')).toBe(true);
    }
  });

  it('only exposes tools inside the key scopes (plus status)', () => {
    const names = toolsForScopes(['customers:read']).map((t) => t.name).sort();
    expect(names).toEqual(['get_action_status', 'get_customer']);
    expect(hasScope(['jobs:read'], getTool('collect_payment')!)).toBe(false);
  });

  it('mcp tools/list hides write tools from a read-only key', () => {
    const names = mcpToolsList(['jobs:read', 'customers:read']).tools.map((t) => t.name);
    expect(names).not.toContain('create_quote');
    expect(names).toContain('get_job');
  });
});

describe('argument validation', () => {
  it('get_customer needs exactly one identifier', () => {
    expect(validate('get_customer', {}).ok).toBe(false);
    expect(validate('get_customer', { customer_id: UUID, email: 'a@b.co' }).ok).toBe(false);
    expect(validate('get_customer', { email: 'A@B.CO' })).toEqual({ ok: true, value: { email: 'a@b.co' } });
    expect(validate('get_customer', { phone: '12' }).ok).toBe(false);
  });

  it('rejects unknown arguments and bad uuids', () => {
    expect(validate('get_job', { job_id: 'nope' }).ok).toBe(false);
    expect(validate('get_job', { job_id: UUID, extra: 1 }).ok).toBe(false);
  });

  it('check_schedule caps the window at 14 days and orders from/to', () => {
    expect(validate('check_schedule', { from: '2027-01-01T00:00:00Z', to: '2027-01-10T00:00:00Z' }).ok).toBe(true);
    expect(validate('check_schedule', { from: '2027-01-01T00:00:00Z', to: '2027-02-10T00:00:00Z' }).ok).toBe(false);
    expect(validate('check_schedule', { from: '2027-01-10T00:00:00Z', to: '2027-01-01T00:00:00Z' }).ok).toBe(false);
  });

  it('create_quote requires an idempotency key and sane money', () => {
    const base = { customer_name: 'Ana', line_items: [{ description: 'Capacitor', quantity: 1, unit_price_cents: 18900 }] };
    expect(validate('create_quote', base).ok).toBe(false);
    expect(validate('create_quote', { ...base, idempotency_key: KEY }).ok).toBe(true);
    expect(validate('create_quote', { ...base, idempotency_key: KEY, line_items: [{ description: 'x', quantity: 1, unit_price_cents: 1.5 }] }).ok).toBe(false);
    expect(validate('create_quote', { ...base, idempotency_key: KEY, line_items: [{ description: 'x', quantity: -1, unit_price_cents: 100 }] }).ok).toBe(false);
    expect(validate('create_quote', { ...base, idempotency_key: KEY, tax_percent: 80 }).ok).toBe(false);
    expect(validate('create_quote', { ...base, idempotency_key: 'short' }).ok).toBe(false);
  });

  it('send_customer_message limits length and control characters', () => {
    expect(validate('send_customer_message', { idempotency_key: KEY, customer_id: UUID, body: 'Hi, we are on the way.' }).ok).toBe(true);
    expect(validate('send_customer_message', { idempotency_key: KEY, customer_id: UUID, body: 'x'.repeat(481) }).ok).toBe(false);
    expect(validate('send_customer_message', { idempotency_key: KEY, customer_id: UUID, body: 'bad\u0007bell' }).ok).toBe(false);
  });

  it('collect_payment takes no amount (cannot be chosen by the caller)', () => {
    expect(validate('collect_payment', { idempotency_key: KEY, job_id: UUID }).ok).toBe(true);
    expect(validate('collect_payment', { idempotency_key: KEY, job_id: UUID, amount: 1 }).ok).toBe(false);
  });
});

describe('pure helpers', () => {
  it('quoteTotals rounds tax once on the subtotal', () => {
    expect(quoteTotals([{ description: 'a', quantity: 2, unit_price_cents: 5000 }], 8.25)).toEqual({ subtotalCents: 10000, taxCents: 825, totalCents: 10825 });
  });

  it('canonicalJson ignores key order and undefined', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(canonicalJson({ a: [2, { d: 1 }], b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it('escapeLike neutralises wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('computeAvailability counts only active jobs on the right UTC day', () => {
    const jobs = [
      { id: '1', scheduled_datetime: '2027-01-05T09:00:00Z', job_status: 'scheduled', assigned_technician_id: UUID, service_type: null },
      { id: '2', scheduled_datetime: '2027-01-05T13:00:00Z', job_status: 'cancelled', assigned_technician_id: UUID, service_type: null },
      { id: '3', scheduled_datetime: '2027-01-06T09:00:00Z', job_status: 'in_progress', assigned_technician_id: UUID, service_type: null },
      { id: '4', scheduled_datetime: '2027-01-05T09:00:00Z', job_status: 'scheduled', assigned_technician_id: UUID2, service_type: null },
    ];
    const [t] = computeAvailability(jobs, [{ id: UUID, member_name: 'Sam', max_jobs_per_day: 2 }], '2027-01-05T00:00:00Z', '2027-01-07T00:00:00Z');
    expect(t.days).toEqual([
      { date: '2027-01-05', booked: 1, available: 1 },
      { date: '2027-01-06', booked: 1, available: 1 },
    ]);
    expect(utcDays('2027-01-05T10:00:00Z', '2027-01-05T11:00:00Z')).toEqual(['2027-01-05']);
  });

  it('summarizeStock ignores inactive locations and flags low stock', () => {
    const out = summarizeStock(
      [{ id: 'p1', part_number: 'CAP-45', name: '45/5 capacitor', unit_label: 'ea', reorder_point: 3 }],
      [
        { part_id: 'p1', location_id: 'v1', quantity_on_hand: 4, quantity_reserved: 1 },
        { part_id: 'p1', location_id: 'old', quantity_on_hand: 50, quantity_reserved: 0 },
      ],
      [
        { id: 'v1', name: 'Van 1', location_type: 'van', active: true },
        { id: 'old', name: 'Closed shop', location_type: 'warehouse', active: false },
      ],
    );
    expect(out[0].total_available).toBe(3);
    expect(out[0].below_reorder_point).toBe(true);
    expect(out[0].locations).toHaveLength(1);
  });
});

describe('JSON-RPC / MCP / A2A', () => {
  it('parses single, batch and rejects garbage', () => {
    expect(parseRpcBody('{nope').kind).toBe('invalid');
    expect(parseRpcBody('[]').kind).toBe('invalid');
    const one = parseRpcBody('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(one.kind === 'requests' && one.batch).toBe(false);
    const bad = parseRpcBody('[{"jsonrpc":"1.0","id":7,"method":"x"},{"jsonrpc":"2.0","method":"notifications/initialized"}]');
    if (bad.kind !== 'requests') throw new Error('expected requests');
    expect('invalid' in bad.items[0]).toBe(true);
    expect('invalid' in bad.items[1]).toBe(false);
    expect(RPC.METHOD_NOT_FOUND).toBe(-32601);
  });

  it('negotiates the protocol version', () => {
    expect(negotiateMcpVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateMcpVersion('1999-01-01')).toBe('2025-11-25');
    expect(mcpInitializeResult('2025-03-26').capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('marks tool failures as isError and keeps structured content on success', () => {
    expect(mcpToolResult({ ok: false, code: 'not_found', message: 'x' }).isError).toBe(true);
    const ok = mcpToolResult({ ok: true, data: { a: 1 } });
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent).toEqual({ a: 1 });
  });

  it('maps statuses to A2A task states', () => {
    expect(a2aStateForStatus('pending_approval')).toBe('input-required');
    expect(a2aStateForStatus('executed')).toBe('completed');
    expect(a2aStateForStatus('rejected')).toBe('rejected');
    expect(a2aStateForStatus('weird')).toBe('unknown');
  });

  it('extracts a skill invocation only from data parts', () => {
    expect(extractA2aInvocation({ parts: [{ kind: 'text', text: 'hi' }] })).toBeNull();
    expect(extractA2aInvocation({ parts: [{ kind: 'data', data: { skill: 'get_job', arguments: { job_id: UUID } } }] })).toEqual({ skill: 'get_job', args: { job_id: UUID } });
  });

  it('publishes an agent card with bearer security and every skill', () => {
    const card = buildAgentCard({ endpointUrl: 'https://x.supabase.co/functions/v1/mcp-server/a2a', siteUrl: 'https://vireek.com' });
    expect(card.skills).toHaveLength(TOOLS.length);
    expect(card.securitySchemes.agentKey.scheme).toBe('bearer');
    expect(card.capabilities.streaming).toBe(false);
  });
});
