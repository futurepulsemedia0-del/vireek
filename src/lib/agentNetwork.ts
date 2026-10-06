import { supabase } from '@/lib/supabase';

/**
 * Vireek Agent Network — dashboard client library.
 *
 * Manages the credentials external AI agents (MCP / A2A) use to talk to
 * Vireek, and shows the audit trail of what they did. Backed by
 * supabase/migrations/20270320000000_agent_network_mcp_a2a.sql.
 *
 * Same key hygiene as src/lib/apiKeys.ts: the raw key is generated and
 * SHA-256 hashed in the browser, only the hash + a short prefix are stored,
 * and the raw value is shown exactly once.
 */

export const AGENT_SCOPES = [
  'customers:read',
  'equipment:read',
  'jobs:read',
  'schedule:read',
  'inventory:read',
  'quotes:create',
  'dispatch:assign',
  'messages:send',
  'payments:collect',
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const AGENT_SCOPE_META: Record<AgentScope, { label: string; write: boolean; tool: string }> = {
  'customers:read': { label: 'Look up one customer (contact details, lifecycle)', write: false, tool: 'get_customer' },
  'equipment:read': { label: 'Read a customer’s equipment and warranties', write: false, tool: 'get_equipment' },
  'jobs:read': { label: 'Read a job (status, schedule, invoice status)', write: false, tool: 'get_job' },
  'schedule:read': { label: 'See bookings and technician availability', write: false, tool: 'check_schedule' },
  'inventory:read': { label: 'Check parts stock levels', write: false, tool: 'check_inventory' },
  'quotes:create': { label: 'Create DRAFT quotes (never sent automatically)', write: true, tool: 'create_quote' },
  'dispatch:assign': { label: 'Assign a technician to a job', write: true, tool: 'dispatch_technician' },
  'messages:send': { label: 'Send an SMS to an existing customer', write: true, tool: 'send_customer_message' },
  'payments:collect': { label: 'Create a payment link for a job’s invoice', write: true, tool: 'collect_payment' },
};

/** Safe default: read-only scopes only. Write scopes must be ticked deliberately. */
export const DEFAULT_AGENT_SCOPES: AgentScope[] = AGENT_SCOPES.filter((s) => !AGENT_SCOPE_META[s].write);

export interface AgentClientRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: AgentScope[];
  daily_call_limit: number;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  calls_24h: number;
}

export interface AgentCallRow {
  id: string;
  client_name: string;
  protocol: 'mcp' | 'a2a';
  tool: string;
  is_write: boolean;
  status: string;
  governance_log_id: string | null;
  error_code: string | null;
  latency_ms: number | null;
  args: Record<string, unknown>;
  created_at: string;
}

export const CALL_STATUS_LABELS: Record<string, string> = {
  ok: 'OK',
  received: 'Received',
  pending_approval: 'Waiting for approval',
  executing: 'Running',
  executed: 'Done',
  rejected: 'Rejected',
  canceled: 'Canceled',
  failed: 'Failed',
  error: 'Error',
};

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes.buffer);
}

export function mcpEndpointUrl(): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
  return `${base.replace(/\/$/, '')}/functions/v1/mcp-server`;
}

export function agentCardUrl(): string {
  return `${mcpEndpointUrl()}/a2a/agent-card`;
}

/** Ready-to-paste config for MCP clients that accept a remote HTTP server with headers. */
export function mcpClientConfig(rawKeyPlaceholder = 'vrk_agent_YOUR_KEY'): string {
  return JSON.stringify(
    { mcpServers: { vireek: { url: mcpEndpointUrl(), headers: { Authorization: `Bearer ${rawKeyPlaceholder}` } } } },
    null,
    2,
  );
}

export async function createAgentClient(input: {
  name: string;
  scopes: AgentScope[];
  dailyCallLimit: number;
  expiresAt: string | null;
}): Promise<{ id: string; rawKey: string }> {
  const rawKey = `vrk_agent_${randomHex(24)}`;
  const { data, error } = await supabase.rpc('create_agent_network_client', {
    p_name: input.name,
    p_scopes: input.scopes,
    p_key_prefix: rawKey.slice(0, 16),
    p_key_hash: await sha256Hex(rawKey),
    p_daily_call_limit: input.dailyCallLimit,
    p_expires_at: input.expiresAt,
  });
  if (error) throw new Error(error.message);
  return { id: data as string, rawKey };
}

export async function revokeAgentClient(id: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_agent_network_client', { p_id: id });
  if (error) throw new Error(error.message);
}

export async function listAgentClients(): Promise<AgentClientRow[]> {
  const { data, error } = await supabase.rpc('list_agent_network_clients');
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    key_prefix: String(r.key_prefix),
    scopes: (r.scopes ?? []) as AgentScope[],
    daily_call_limit: Number(r.daily_call_limit),
    expires_at: (r.expires_at as string | null) ?? null,
    last_used_at: (r.last_used_at as string | null) ?? null,
    created_at: String(r.created_at),
    revoked_at: (r.revoked_at as string | null) ?? null,
    calls_24h: Number(r.calls_24h ?? 0),
  }));
}

export async function listAgentCalls(limit = 50): Promise<AgentCallRow[]> {
  const { data, error } = await supabase.rpc('list_agent_network_calls', { p_limit: limit, p_before: null });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentCallRow[];
}

/** One-line summary of a write call's arguments for the audit table (never shows message bodies in full). */
export function summarizeCallArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'create_quote':
      return `${String(args.customer_name ?? '')} · ${Array.isArray(args.line_items) ? args.line_items.length : 0} line(s)`;
    case 'dispatch_technician':
      return `job ${String(args.job_id ?? '').slice(0, 8)} → tech ${String(args.technician_id ?? '').slice(0, 8)}`;
    case 'send_customer_message':
      return `SMS (${String(args.body ?? '').length} chars)`;
    case 'collect_payment':
      return `job ${String(args.job_id ?? '').slice(0, 8)}`;
    default:
      return '';
  }
}
