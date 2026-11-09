import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, History, Inbox, ShieldCheck, SlidersHorizontal, Undo2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { DiffPreview } from '@/components/agentActions/DiffPreview';
import { formatDateTime } from '@/lib/format';
import {
  AUTONOMY_LABELS, LIMIT_LABELS, STATUS_LABELS, canUndo, describeLimit, expiresIn, groupInbox, riskHint,
  type ActionRow, type AuditRow, type Autonomy, type GrantRow, type LimitKind, type LimitRow, type ModuleState, type ToolMeta, type ToolPolicyRow,
} from '@/lib/agentActions';
import * as api from '@/lib/agentActionsApi';

type Tab = 'inbox' | 'activity' | 'controls';
const TABS: { id: Tab; label: string; icon: typeof Inbox }[] = [
  { id: 'inbox', label: 'Approval inbox', icon: Inbox },
  { id: 'activity', label: 'Activity & audit', icon: History },
  { id: 'controls', label: 'Controls', icon: SlidersHorizontal },
];
const LEVELS: Autonomy[] = ['suggest', 'require_approval', 'auto_notify'];
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

function ActionCard({ row, busy, onApprove, onReject, onUndo }: { row: ActionRow; busy: boolean; onApprove?: () => void; onReject?: () => void; onUndo?: () => void }) {
  const hint = riskHint(row);
  const left = expiresIn(row);
  return (
    <Card interactive={false} className="p-4" aria-labelledby={`a-${row.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`a-${row.id}`} className="break-words text-sm font-semibold text-text-primary">{row.tool_slug}</h3>
          <p className="text-xs text-text-secondary">{row.agent_id} · {formatDateTime(row.created_at)}{left ? ` · ${left}` : ''}</p>
        </div>
        <span className="rounded-full bg-surface-secondary px-2.5 py-1 text-xs font-medium text-text-secondary">{STATUS_LABELS[row.status]}</span>
      </div>
      <p className="mt-2 break-words text-sm text-text-primary"><span className="font-medium">Why: </span>{row.reason || 'No reason given'}</p>
      {hint && <p className="mt-2 flex items-start gap-2 rounded-lg bg-warning/10 p-2 text-xs text-text-primary"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{hint}</p>}
      {row.preview && <DiffPreview summary={row.preview.summary} diff={row.preview.diff} />}
      {row.decision_detail.length > 0 && <p className="mt-2 text-xs text-text-secondary">{row.decision_detail.join(' · ')}</p>}
      {row.error && <p className="mt-2 text-xs text-danger" role="status">{row.error}</p>}
      <p className="mt-2 text-xs text-text-secondary">Model {row.model} · prompt {row.prompt_version}</p>
      {(onApprove || onReject || onUndo) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {onApprove && <Button size="sm" loading={busy} onClick={onApprove}>Approve &amp; run</Button>}
          {onReject && <Button size="sm" variant="secondary" disabled={busy} onClick={onReject}>Reject</Button>}
          {onUndo && <Button size="sm" variant="secondary" loading={busy} onClick={onUndo}><Undo2 className="h-4 w-4" aria-hidden="true" />Undo</Button>}
        </div>
      )}
    </Card>
  );
}

export function AgentActionsPage() {
  const { profile, teamMember, isOwner } = useAuth();
  const { toast } = useToast();
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const [tab, setTab] = useState<Tab>('inbox');
  const [state, setState] = useState<ModuleState | null>(null);
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [policy, setPolicy] = useState<{ grants: GrantRow[]; tools: ToolPolicyRow[]; limits: LimitRow[] }>({ grants: [], tools: [], limits: [] });
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [verify, setVerify] = useState<string | null>(null);
  const [live, setLive] = useState('');

  const load = useCallback(async () => {
    if (!ownerId) return;
    setStatus('loading');
    try {
      const s = await api.fetchModuleState();
      setState(s);
      if (!s.enabled) { setStatus('ready'); return; }
      const [r, a, p] = await Promise.all([api.fetchRequests(ownerId), api.fetchAudit(ownerId), api.fetchPolicy(ownerId)]);
      setRows(r); setAudit(a); setPolicy(p);
      setTools(s.canManage ? await api.listTools().catch(() => []) : []);
      setStatus('ready');
    } catch { setStatus('error'); }
  }, [ownerId]);
  useEffect(() => { void load(); }, [load]);

  const grouped = useMemo(() => groupInbox(rows), [rows]);
  const allScopes = useMemo(() => [...new Set(tools.flatMap((t) => t.scopes))].sort(), [tools]);

  async function run(id: string, fn: () => Promise<string | void>, ok: string) {
    setBusyId(id);
    try {
      const msg = await fn();
      toast(msg || ok, msg ? 'error' : 'success'); setLive(msg || ok);
      await load();
    } catch (e) { toast(errText(e), 'error'); setLive(errText(e)); } finally { setBusyId(null); }
  }
  const guard = (fn: () => Promise<unknown>, ok: string) => run('ctl', async () => { await fn(); }, ok);

  if (!ownerId) return <DashboardLayout><EmptyState variant="no-permission" title="Sign in required" description="Open this page from your dashboard." /></DashboardLayout>;

  return (
    <DashboardLayout>
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        <header className="flex items-center gap-3">
          <Bot className="h-6 w-6 text-primary" aria-hidden="true" />
          <div>
            <h1 className="text-xl font-bold text-text-primary">Agent actions</h1>
            <p className="text-sm text-text-secondary">What your AI agents want to do, what they did, and the rules they must follow.</p>
          </div>
        </header>
        <p className="sr-only" role="status" aria-live="polite">{live}</p>

        {status === 'loading' && <div className="mt-6"><SkeletonCardList count={3} /></div>}
        {status === 'error' && <div className="mt-6"><EmptyStateError title="Could not load agent actions" onRetry={() => void load()} /></div>}
        {status === 'ready' && state && !state.enabled && (
          <div className="mt-6"><EmptyState variant="no-permission" icon={ShieldCheck} title="Agent actions are not enabled for your account" description="This module is rolled out per account. Contact support to request access." /></div>
        )}

        {status === 'ready' && state?.enabled && (
          <>
            {state.paused && (
              <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-text-primary">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />All agent actions are paused. Nothing will run until you resume (undo still works).
              </div>
            )}
            <div role="tablist" aria-label="Agent actions sections" className="mt-4 flex gap-1 overflow-x-auto border-b border-border">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1}
                  onClick={() => setTab(id)} className={`focus-ring flex min-h-[44px] items-center gap-2 whitespace-nowrap px-4 text-sm font-medium ${tab === id ? 'border-b-2 border-primary text-text-primary' : 'text-text-secondary'}`}>
                  <Icon className="h-4 w-4" aria-hidden="true" />{label}{id === 'inbox' && grouped.pending.length > 0 ? ` (${grouped.pending.length})` : ''}
                </button>
              ))}
            </div>

            <section role="tabpanel" id="panel-inbox" aria-labelledby="tab-inbox" hidden={tab !== 'inbox'} className="mt-4 space-y-6">
              {grouped.pending.length === 0 && grouped.suggested.length === 0 && <EmptyState compact icon={Inbox} title="Nothing waiting for you" description="When an agent needs your approval it will show up here with a preview of exactly what will change." />}
              {grouped.pending.length > 0 && <div className="space-y-3"><h2 className="text-sm font-semibold text-text-secondary">Needs approval</h2>
                {grouped.pending.map((r) => <ActionCard key={r.id} row={r} busy={busyId === r.id} onApprove={state.canManage ? () => run(r.id, async () => { const o = await api.approveAction(r.id, r.input_hash); return o.outcome === 'executed' ? undefined : `Not run: ${o.code ?? o.outcome}`; }, 'Approved and executed') : undefined} onReject={state.canManage ? () => run(r.id, () => api.rejectAction(r.id).then(() => undefined), 'Rejected') : undefined} />)}</div>}
              {grouped.suggested.length > 0 && <div className="space-y-3"><h2 className="text-sm font-semibold text-text-secondary">Suggestions</h2>
                {grouped.suggested.map((r) => <ActionCard key={r.id} row={r} busy={busyId === r.id} onApprove={state.canManage ? () => run(r.id, async () => { const o = await api.approveAction(r.id, r.input_hash); return o.outcome === 'executed' ? undefined : `Not run: ${o.code ?? o.outcome}`; }, 'Applied') : undefined} onReject={state.canManage ? () => run(r.id, () => api.rejectAction(r.id).then(() => undefined), 'Dismissed') : undefined} />)}</div>}
              {grouped.recent.length > 0 && <div className="space-y-3"><h2 className="text-sm font-semibold text-text-secondary">Recent</h2>
                {grouped.recent.map((r) => <ActionCard key={r.id} row={r} busy={busyId === r.id} onUndo={state.canManage && canUndo(r) ? () => run(r.id, () => api.undoAction(r.id).then(() => undefined), 'Undone') : undefined} />)}</div>}
            </section>

            <section role="tabpanel" id="panel-activity" aria-labelledby="tab-activity" hidden={tab !== 'activity'} className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant="secondary" loading={busyId === 'verify'} onClick={() => run('verify', async () => { const v = await api.verifyAudit(ownerId); setVerify(v.ok ? `Audit chain intact (${v.checked} entries).` : `Audit chain BROKEN: ${v.reason}`); })}>Verify audit chain</Button>
                {verify && <p role="status" className="text-sm text-text-primary">{verify}</p>}
              </div>
              {audit.length === 0 ? <EmptyState compact icon={History} title="No activity yet" description="Every proposal, approval, execution, undo and policy change is recorded here." /> : (
                <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full min-w-[480px] text-left text-xs">
                  <caption className="sr-only">Append-only audit log, newest first</caption>
                  <thead className="bg-surface-secondary text-text-secondary"><tr><th scope="col" className="px-3 py-2">#</th><th scope="col" className="px-3 py-2">When</th><th scope="col" className="px-3 py-2">Event</th><th scope="col" className="px-3 py-2">By</th><th scope="col" className="px-3 py-2">Tool / model</th></tr></thead>
                  <tbody>{audit.map((a) => (<tr key={a.seq} className="border-t border-border"><td className="px-3 py-2">{a.seq}</td><td className="px-3 py-2">{formatDateTime(a.created_at)}</td><td className="px-3 py-2">{a.event}</td><td className="break-all px-3 py-2">{a.actor}</td><td className="break-words px-3 py-2">{String(a.snapshot.tool_slug ?? '-')} {a.snapshot.model ? `· ${String(a.snapshot.model)}/${String(a.snapshot.prompt_version)}` : ''}</td></tr>))}</tbody>
                </table></div>)}
            </section>

            <section role="tabpanel" id="panel-controls" aria-labelledby="tab-controls" hidden={tab !== 'controls'} className="mt-4 space-y-6">
              {!state.canManage && <EmptyState compact variant="no-permission" title="View only" description="You need the 'Manage security' permission to change these controls." />}
              <Card interactive={false} className="p-4"><Switch label="Pause all agent actions" hint="Emergency stop for your account. Pending requests cannot be approved while paused; undo still works." checked={state.paused} disabled={!state.canManage} loading={busyId === 'ctl'} onChange={(v) => void guard(() => api.setPaused(v, v ? 'Paused from dashboard' : undefined), v ? 'Agent actions paused' : 'Agent actions resumed')} /></Card>
              <PolicyControls canManage={state.canManage} tools={tools} policy={policy} scopes={allScopes} busy={busyId === 'ctl'} guard={guard} />
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function PolicyControls({ canManage, tools, policy, scopes, busy, guard }: { canManage: boolean; tools: ToolMeta[]; policy: { grants: GrantRow[]; tools: ToolPolicyRow[]; limits: LimitRow[] }; scopes: string[]; busy: boolean; guard: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [agent, setAgent] = useState('');
  const [scope, setScope] = useState('');
  const [level, setLevel] = useState<Autonomy>('require_approval');
  const [kind, setKind] = useState<LimitKind>('messages');
  const [lTool, setLTool] = useState('');
  const [lMax, setLMax] = useState(10);
  const [lWin, setLWin] = useState(86_400);
  const [lExceed, setLExceed] = useState<'block' | 'approval'>('approval');
  const [lTz, setLTz] = useState('America/Chicago');
  const [lDays, setLDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [lStart, setLStart] = useState('08:00');
  const [lEnd, setLEnd] = useState('18:00');
  const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const agentOk = /^[a-z][a-z0-9_-]{1,62}$/.test(agent);

  return (
    <>
      <Card interactive={false} className="p-4">
        <h2 className="text-sm font-semibold text-text-primary">Tools</h2>
        {tools.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No tools are registered yet. Agent modules register their tools in the registry; they appear here once they do.</p> : (
          <ul className="mt-3 divide-y divide-border">
            {tools.map((t) => { const p = policy.tools.find((x) => x.tool_slug === t.slug); const enabled = p ? p.enabled : true; return (
              <li key={t.slug} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0"><p className="break-words text-sm font-medium text-text-primary">{t.slug}</p><p className="text-xs text-text-secondary">{t.description} · risk {t.risk} · max {AUTONOMY_LABELS[t.maxAutonomy]}</p></div>
                <div className="flex items-center gap-2">
                  <Select aria-label={`Autonomy for ${t.slug}`} value={p?.autonomy ?? ''} disabled={!canManage || busy} onChange={(e) => void guard(() => api.setToolPolicy(t.slug, enabled, (e.target.value || null) as Autonomy | null), 'Tool policy saved')}>
                    <option value="">Default ({AUTONOMY_LABELS[t.defaultAutonomy]})</option>{LEVELS.map((l) => <option key={l} value={l}>{AUTONOMY_LABELS[l]}</option>)}
                  </Select>
                  <Switch label={enabled ? 'On' : 'Off'} checked={enabled} disabled={!canManage || busy} onChange={(v) => void guard(() => api.setToolPolicy(t.slug, v, p?.autonomy ?? null), 'Tool policy saved')} />
                </div>
              </li>); })}
          </ul>)}
      </Card>

      <Card interactive={false} className="p-4">
        <h2 className="text-sm font-semibold text-text-primary">Agent permissions (scopes)</h2>
        <p className="mt-1 text-xs text-text-secondary">Agents have no permissions by default. Grant only what each agent needs.</p>
        {policy.grants.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No grants yet - every agent action is blocked.</p> : (
          <ul className="mt-2 divide-y divide-border">{policy.grants.map((g) => (
            <li key={`${g.agent_id}:${g.scope}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span className="break-all">{g.agent_id} · {g.scope} · {AUTONOMY_LABELS[g.autonomy]}</span>
              <Button size="xs" variant="ghost" disabled={!canManage || busy} onClick={() => void guard(() => api.deleteGrant(g.agent_id, g.scope), 'Grant removed')}>Remove</Button></li>))}</ul>)}
        {canManage && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Input label="Agent id" value={agent} onChange={(e) => setAgent(e.target.value.trim())} placeholder="dispatch-agent" error={agent && !agentOk ? 'Lowercase letters, digits, - and _' : undefined} />
            {scopes.length > 0 ? <Select label="Scope" value={scope} onChange={(e) => setScope(e.target.value)}><option value="">Choose...</option>{scopes.map((s) => <option key={s} value={s}>{s}</option>)}</Select> : <Input label="Scope" value={scope} onChange={(e) => setScope(e.target.value.trim())} placeholder="jobs:reschedule" />}
            <Select label="Autonomy ceiling" value={level} onChange={(e) => setLevel(e.target.value as Autonomy)}>{LEVELS.map((l) => <option key={l} value={l}>{AUTONOMY_LABELS[l]}</option>)}</Select>
            <div className="flex items-end"><Button fullWidth disabled={busy || !agentOk || !/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(scope)} onClick={() => void guard(() => api.setGrant(agent, scope, level), 'Grant saved')}>Grant</Button></div>
          </div>)}
      </Card>

      <Card interactive={false} className="p-4">
        <h2 className="text-sm font-semibold text-text-primary">Limits</h2>
        {policy.limits.length === 0 ? <p className="mt-2 text-sm text-text-secondary">No custom limits. A default of 30 agent calls per minute always applies.</p> : (
          <ul className="mt-2 divide-y divide-border">{policy.limits.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span className="break-words">{describeLimit(l)}</span>
              <Button size="xs" variant="ghost" disabled={!canManage || busy} onClick={() => void guard(() => api.deleteLimit(l.id), 'Limit removed')}>Remove</Button></li>))}</ul>)}
        {canManage && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select label="Type" value={kind} onChange={(e) => setKind(e.target.value as LimitKind)}>{(Object.keys(LIMIT_LABELS) as LimitKind[]).map((k) => <option key={k} value={k}>{LIMIT_LABELS[k]}</option>)}</Select>
            <Select label="Applies to tool" value={lTool} onChange={(e) => setLTool(e.target.value)}><option value="">All tools</option>{tools.map((t) => <option key={t.slug} value={t.slug}>{t.slug}</option>)}</Select>
            <Select label="When exceeded" value={lExceed} onChange={(e) => setLExceed(e.target.value as 'block' | 'approval')}><option value="approval">Ask for approval</option><option value="block">Block (hard)</option></Select>
            {kind === 'time_window' ? (<>
              <Input label="Time zone" value={lTz} onChange={(e) => setLTz(e.target.value.trim())} />
              <Input label="From" type="time" value={lStart} onChange={(e) => setLStart(e.target.value)} />
              <Input label="To" type="time" value={lEnd} onChange={(e) => setLEnd(e.target.value)} />
              <fieldset className="sm:col-span-3"><legend className="text-xs font-medium text-text-secondary">Days</legend><div className="mt-1 flex flex-wrap gap-2">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (<label key={d} className="flex min-h-[44px] items-center gap-1 text-sm"><input type="checkbox" checked={lDays.includes(i)} onChange={(e) => setLDays((p) => (e.target.checked ? [...p, i] : p.filter((x) => x !== i)))} />{d}</label>))}</div></fieldset>
            </>) : (<>
              <Input label={kind === 'discount_pct' ? 'Max %' : 'Max'} type="number" min={1} value={lMax} onChange={(e) => setLMax(Number(e.target.value))} />
              {kind !== 'discount_pct' && <Select label="Window" value={String(lWin)} onChange={(e) => setLWin(Number(e.target.value))}><option value="60">1 minute</option><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">1 week</option><option value="2592000">30 days</option></Select>}
            </>)}
            <div className="flex items-end sm:col-span-3"><Button disabled={busy || (kind === 'time_window' && (lDays.length === 0 || mins(lStart) === mins(lEnd) || !lTz))} onClick={() => void guard(() => api.upsertLimit({ kind, agentId: '', toolSlug: lTool, onExceed: lExceed,
              windowSec: kind === 'discount_pct' || kind === 'time_window' ? null : lWin, max: kind === 'time_window' ? null : lMax,
              days: kind === 'time_window' ? lDays : null, startMin: kind === 'time_window' ? mins(lStart) : null, endMin: kind === 'time_window' ? (mins(lEnd) === 0 ? 1440 : mins(lEnd)) : null, tz: kind === 'time_window' ? lTz : null }), 'Limit saved')}>Add limit</Button></div>
          </div>)}
      </Card>
    </>
  );
}
