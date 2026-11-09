// Kill-switch guard for edge functions. Dependency-free so it runs in Deno and Vitest.
// Fails CLOSED: if the switch state is unknown (never loaded, load failing past maxStaleMs,
// or a malformed payload) the capability is treated as stopped. Only put capabilities here
// that are safe to pause (never inbound call answering).

export const CAPABILITIES = [
  'outbound_dialer',
  'voice_cloning',
  'agent_auto_actions',
  'agent_action_framework',
  'price_auto_apply',
  'auto_replies',
  'ai_model_prompt_versions',
  'marketplace_ingestion',
  'sms_campaigns',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface RawSnapshot {
  global: string[];
  orgs: { key: string; tenant_id: string }[];
}

interface State { global: ReadonlySet<string>; orgs: ReadonlySet<string>; at: number }

export interface KillSwitchGuardOptions {
  load: () => Promise<unknown>;
  now?: () => number;
  /** Re-read at most this often. Default 15 s. */
  ttlMs?: number;
  /** If reads keep failing, trust the last good state for at most this long. Default 10 min. */
  maxStaleMs?: number;
}

export interface KillSwitchGuard {
  isStopped(key: Capability, tenantId?: string | null): Promise<boolean>;
}

export function parseSnapshot(raw: unknown): { global: Set<string>; orgs: Set<string> } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RawSnapshot>;
  if (!Array.isArray(r.global) || !Array.isArray(r.orgs)) return null;
  const global = new Set<string>();
  for (const k of r.global) { if (typeof k !== 'string') return null; global.add(k); }
  const orgs = new Set<string>();
  for (const o of r.orgs) {
    if (!o || typeof o.key !== 'string' || typeof o.tenant_id !== 'string') return null;
    orgs.add(`${o.key}:${o.tenant_id}`);
  }
  return { global, orgs };
}

export function createKillSwitchGuard({ load, now = Date.now, ttlMs = 15_000, maxStaleMs = 10 * 60_000 }: KillSwitchGuardOptions): KillSwitchGuard {
  let state: State | null = null;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    try {
      const parsed = parseSnapshot(await load());
      if (parsed) state = { ...parsed, at: now() };
    } catch {
      // keep last good state; staleness is enforced below
    }
  }

  async function ensure(): Promise<void> {
    if (state && now() - state.at < ttlMs) return;
    inflight ??= refresh().finally(() => { inflight = null; });
    await inflight;
  }

  return {
    async isStopped(key, tenantId) {
      await ensure();
      if (!state || now() - state.at > maxStaleMs) return true;
      if (state.global.has(key)) return true;
      return tenantId ? state.orgs.has(`${key}:${tenantId}`) : false;
    },
  };
}

interface RpcClient {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function loadKillSwitchSnapshot(client: RpcClient): Promise<unknown> {
  const { data, error } = await client.rpc('kill_switch_snapshot');
  if (error) throw new Error(error.message);
  return data;
}

let shared: KillSwitchGuard | null = null;
/** One guard per edge-function isolate (service-role client required). */
export function getKillSwitchGuard(client: RpcClient): KillSwitchGuard {
  shared ??= createKillSwitchGuard({ load: () => loadKillSwitchSnapshot(client) });
  return shared;
}

export function stoppedResponse(capability: Capability): Response {
  return new Response(JSON.stringify({ error: 'capability_stopped', capability }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
  });
}
