/**
 * Vireek Agent Network — /dashboard/agent-network
 *
 * Where a business decides which external AI agents may talk to Vireek
 * (MCP + A2A), with which tools, and watches what they did. Every write tool
 * still needs approval in Agent Governance by default — this page only issues
 * credentials and shows the audit trail.
 */

import { useCallback, useEffect, useState } from 'react';
import { Network, Loader2, Plus, KeyRound, Copy, Ban, ShieldCheck } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  AGENT_SCOPES,
  AGENT_SCOPE_META,
  CALL_STATUS_LABELS,
  DEFAULT_AGENT_SCOPES,
  agentCardUrl,
  createAgentClient,
  listAgentCalls,
  listAgentClients,
  mcpClientConfig,
  mcpEndpointUrl,
  revokeAgentClient,
  summarizeCallArgs,
  type AgentCallRow,
  type AgentClientRow,
  type AgentScope,
} from '@/lib/agentNetwork';

const inputCls = 'focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary';

const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-success-500/10 text-success-500',
  executed: 'bg-success-500/10 text-success-500',
  pending_approval: 'bg-warning-500/10 text-warning-500',
  received: 'bg-bg-tertiary text-text-secondary',
  executing: 'bg-accent/10 text-accent',
  rejected: 'bg-danger/10 text-danger',
  failed: 'bg-danger/10 text-danger',
  error: 'bg-danger/10 text-danger',
  canceled: 'bg-bg-tertiary text-text-secondary',
};

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export function AgentNetworkPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [clients, setClients] = useState<AgentClientRow[]>([]);
  const [calls, setCalls] = useState<AgentCallRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(DEFAULT_AGENT_SCOPES);
  const [dailyLimit, setDailyLimit] = useState(1000);
  const [expiryDays, setExpiryDays] = useState<number | ''>(90);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, k] = await Promise.all([listAgentClients(), listAgentCalls(50)]);
      setClients(c);
      setCalls(k);
      setForbidden(false);
    } catch (e) {
      if (/Not authorized/i.test((e as Error).message)) setForbidden(true);
      else toast('Could not load the Agent Network.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleScope = (s: AgentScope) => setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const handleCreate = async () => {
    if (!name.trim() || scopes.length === 0) {
      toast('Give the agent a name and pick at least one tool.', 'error');
      return;
    }
    setCreating(true);
    try {
      const expiresAt = expiryDays === '' ? null : new Date(Date.now() + expiryDays * 86_400_000).toISOString();
      const { rawKey } = await createAgentClient({
        name: name.trim(),
        scopes,
        dailyCallLimit: Math.min(Math.max(Math.round(dailyLimit) || 1000, 1), 100000),
        expiresAt,
      });
      setNewKey(rawKey);
      setName('');
      setScopes(DEFAULT_AGENT_SCOPES);
      setShowForm(false);
      await load();
    } catch (e) {
      toast((e as Error).message || 'Could not create the agent key.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (c: AgentClientRow) => {
    if (!window.confirm(`Revoke "${c.name}"? It stops working immediately and its pending approvals are canceled.`)) return;
    try {
      await revokeAgentClient(c.id);
      toast('Agent key revoked.', 'success');
      await load();
    } catch {
      toast('Could not revoke this key.', 'error');
    }
  };

  const copy = async (text: string, okMsg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg, 'success');
    } catch {
      toast('Copy failed — select and copy manually.', 'error');
    }
  };

  const hasWrite = scopes.some((s) => AGENT_SCOPE_META[s].write);

  return (
    <DashboardLayout activeLabel="Agent Network">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <Network className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Agent Network (MCP + A2A)</p>
        </div>
        <p className="-mt-4 text-sm text-text-secondary">
          Let other AI agents (CRM, insurance, property, accounting, assistants) use Vireek through one governed door. Reads are scoped per tool; every action that changes something waits for approval in Agent Governance unless you relax it there.
        </p>

        {loading && clients.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" /> Loading…</div>
        ) : forbidden ? (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-text-secondary">
            Only owners, admins and members with security permission can manage external agents.
          </div>
        ) : (
          <>
            {newKey && (
              <div className="rounded-2xl border border-warning-500/40 bg-warning-500/5 p-5">
                <div className="mb-2 flex items-center gap-2"><KeyRound size={16} className="text-warning-500" /><p className="text-sm font-semibold text-text-primary">Copy this key now — it is shown only once</p></div>
                <code className="block break-all rounded-xl bg-bg-tertiary p-3 text-xs text-text-primary">{newKey}</code>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={() => copy(newKey, 'Key copied.')} className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3 py-1.5 text-xs font-medium text-white"><Copy size={12} /> Copy key</button>
                  <button onClick={() => copy(mcpClientConfig(newKey), 'MCP config copied.')} className="focus-ring flex items-center gap-1.5 rounded-xl bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-primary"><Copy size={12} /> Copy MCP config</button>
                  <button onClick={() => setNewKey(null)} className="focus-ring rounded-xl px-3 py-1.5 text-xs text-text-secondary">I saved it</button>
                </div>
              </div>
            )}

            {/* Connection details */}
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="mb-3 text-sm font-semibold text-text-primary">Connection details</p>
              <div className="space-y-2 text-xs text-text-secondary">
                <div className="flex flex-wrap items-center gap-2"><span className="w-28">MCP endpoint</span><code className="break-all text-text-primary">{mcpEndpointUrl()}</code><button onClick={() => copy(mcpEndpointUrl(), 'Copied.')} className="focus-ring text-accent">Copy</button></div>
                <div className="flex flex-wrap items-center gap-2"><span className="w-28">A2A agent card</span><code className="break-all text-text-primary">{agentCardUrl()}</code><button onClick={() => copy(agentCardUrl(), 'Copied.')} className="focus-ring text-accent">Copy</button></div>
                <p>Auth header: <code className="text-text-primary">Authorization: Bearer vrk_agent_…</code> · Limits: 60 calls/minute and a daily quota per key.</p>
              </div>
            </div>

            {/* Clients */}
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm font-semibold text-text-primary">Connected agents</p>
                <button onClick={() => setShowForm((s) => !s)} className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3 py-1.5 text-xs font-medium text-white">
                  <Plus size={12} /> {showForm ? 'Cancel' : 'Connect an agent'}
                </button>
              </div>

              {showForm && (
                <div className="mb-5 space-y-4 rounded-xl border border-border p-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <input className={`${inputCls} sm:col-span-3`} placeholder="Agent name (e.g. Insurance claims agent)" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
                    <label className="flex flex-col gap-1 text-xs text-text-secondary">Daily call limit
                      <input type="number" min={1} max={100000} className={inputCls} value={dailyLimit} onChange={(e) => setDailyLimit(Number(e.target.value))} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-text-secondary">Expires after (days, empty = never)
                      <input type="number" min={1} max={730} className={inputCls} value={expiryDays} onChange={(e) => setExpiryDays(e.target.value === '' ? '' : Number(e.target.value))} />
                    </label>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-text-secondary">Tools this agent may use</p>
                    {AGENT_SCOPES.map((s) => (
                      <label key={s} className="flex items-start gap-2.5 text-sm text-text-primary">
                        <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} className="mt-0.5 h-4 w-4 rounded border-border accent-accent" />
                        <span>
                          {AGENT_SCOPE_META[s].label}
                          {AGENT_SCOPE_META[s].write && <span className="ml-2 rounded-full bg-warning-500/10 px-2 py-0.5 text-[10px] font-medium text-warning-500">changes data · needs approval</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                  {hasWrite && (
                    <div className="flex items-start gap-2 rounded-xl bg-bg-tertiary p-3 text-xs text-text-secondary">
                      <ShieldCheck size={14} className="mt-0.5 shrink-0 text-cta" />
                      Write tools are held for human approval in Agent Governance by default. You can allow specific actions to run automatically there.
                    </div>
                  )}
                  <button disabled={creating} onClick={handleCreate} className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                    {creating ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Create key
                  </button>
                </div>
              )}

              {clients.length === 0 ? (
                <p className="text-sm text-text-secondary">No external agents connected yet.</p>
              ) : (
                <div className="space-y-3">
                  {clients.map((c) => {
                    const expired = c.expires_at !== null && new Date(c.expires_at) <= new Date();
                    const inactive = c.revoked_at !== null || expired;
                    return (
                      <div key={c.id} className={`rounded-xl border border-border p-4 ${inactive ? 'opacity-60' : ''}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-text-primary">{c.name}</p>
                          <code className="text-xs text-text-secondary">{c.key_prefix}…</code>
                          {c.revoked_at && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger">Revoked</span>}
                          {!c.revoked_at && expired && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">Expired</span>}
                          {!inactive && (
                            <button onClick={() => handleRevoke(c)} className="focus-ring ml-auto flex items-center gap-1 rounded-xl px-2 py-1 text-xs text-danger"><Ban size={12} /> Revoke</button>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {c.scopes.map((s) => (
                            <span key={s} className={`rounded-full px-2 py-0.5 text-[10px] ${AGENT_SCOPE_META[s]?.write ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}`}>{s}</span>
                          ))}
                        </div>
                        <p className="mt-2 text-xs text-text-secondary">
                          {c.calls_24h}/{c.daily_call_limit} calls in 24h · last used {fmt(c.last_used_at)} · expires {c.expires_at ? fmt(c.expires_at) : 'never'}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Audit */}
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="mb-1 text-sm font-semibold text-text-primary">Recent agent activity</p>
              <p className="mb-3 text-xs text-text-secondary">Actions waiting for approval appear in Agent Governance.</p>
              {calls.length === 0 ? (
                <p className="text-sm text-text-secondary">No agent calls yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-text-secondary">
                      <tr><th className="py-2 pr-3">When</th><th className="pr-3">Agent</th><th className="pr-3">Tool</th><th className="pr-3">Via</th><th className="pr-3">Detail</th><th className="pr-3">ms</th><th>Status</th></tr>
                    </thead>
                    <tbody className="text-text-primary">
                      {calls.map((k) => (
                        <tr key={k.id} className="border-t border-border">
                          <td className="py-2 pr-3 whitespace-nowrap">{fmt(k.created_at)}</td>
                          <td className="pr-3">{k.client_name}</td>
                          <td className="pr-3">{k.tool}{k.is_write && <span className="ml-1 text-warning-500">●</span>}</td>
                          <td className="pr-3 uppercase">{k.protocol}</td>
                          <td className="pr-3 text-text-secondary">{summarizeCallArgs(k.tool, k.args)}{k.error_code ? ` ${k.error_code}` : ''}</td>
                          <td className="pr-3">{k.latency_ms ?? '—'}</td>
                          <td><span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[k.status] ?? 'bg-bg-tertiary text-text-secondary'}`}>{CALL_STATUS_LABELS[k.status] ?? k.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
