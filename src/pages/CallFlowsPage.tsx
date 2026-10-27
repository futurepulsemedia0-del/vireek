import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Copy, GitBranch, Loader2, Lock, Pencil, Plus, Power, PowerOff, RefreshCw, Rocket, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { FlowCanvas, NEW_PREFIX, NODE_ICONS } from '@/components/call-flows/FlowCanvas';
import { NodeEditor } from '@/components/call-flows/NodeEditor';
import { FlowSimulator } from '@/components/call-flows/FlowSimulator';
import { browserTimezone, isValidTimezone, wallClockNow } from '@/lib/callRouting';
import {
  FlowConflictError,
  FlowLiveError,
  FlowNameTakenError,
  MAX_FLOWS,
  MAX_FLOW_NAME_LENGTH,
  MAX_NODES,
  NODE_KINDS,
  NODE_KIND_META,
  copyName,
  createBlankFlow,
  createFlow,
  createNode,
  createStarterFlow,
  deleteFlow,
  fetchFlowContext,
  fetchFlowRecord,
  fetchFlowRecords,
  fetchLiveFlowId,
  flowsEqual,
  nodeById,
  publishFlow,
  removeNode,
  saveFlowDraft,
  setEdge,
  setLiveFlow,
  simulateFlow,
  validateFlow,
  type CallFlowConfig,
  type FlowContext,
  type FlowNode,
  type FlowNodeKind,
  type FlowRecord,
  type FlowSimInput,
} from '@/lib/callFlows';

const PAGE_LABEL = 'Call Flows';
const LIST_PATH = '/dashboard/calls/flows';

function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}

const isNodeKind = (v: string): v is FlowNodeKind => (NODE_KINDS as string[]).includes(v);
const formatWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// ============================================================
// LIST
// ============================================================

interface ScopeProps {
  accountOwnerId: string;
  userId: string;
}

function FlowList({ accountOwnerId, userId }: ScopeProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [records, setRecords] = useState<FlowRecord[]>([]);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [template, setTemplate] = useState<'starter' | 'blank'>('starter');
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<FlowRecord | null>(null);
  const [liveChange, setLiveChange] = useState<{ flow: FlowRecord | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [recs, live] = await Promise.all([fetchFlowRecords(accountOwnerId), fetchLiveFlowId(accountOwnerId)]);
      setRecords(recs);
      setLiveId(live);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const names = useMemo(() => records.map((r) => r.name), [records]);

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast(err instanceof FlowNameTakenError || err instanceof FlowLiveError ? err.message : fallback, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () =>
    run(async () => {
      const name = newName.trim();
      if (!name) {
        toast('Give your flow a name first.', 'error');
        return;
      }
      if (records.length >= MAX_FLOWS) {
        toast(`You can have up to ${MAX_FLOWS} flows.`, 'error');
        return;
      }
      const tz = browserTimezone();
      const rec = await createFlow(accountOwnerId, userId, name, template === 'starter' ? createStarterFlow(tz) : createBlankFlow(tz));
      navigate(`${LIST_PATH}/${rec.id}`);
    }, 'Could not create the flow. Please try again.');

  const handleDuplicate = (rec: FlowRecord) =>
    run(async () => {
      if (records.length >= MAX_FLOWS) {
        toast(`You can have up to ${MAX_FLOWS} flows.`, 'error');
        return;
      }
      const copy = await createFlow(accountOwnerId, userId, copyName(rec.name, names), rec.draft);
      toast('Flow duplicated.', 'success');
      navigate(`${LIST_PATH}/${copy.id}`);
    }, 'Could not duplicate the flow.');

  const handleDelete = () =>
    run(async () => {
      if (!toDelete) return;
      await deleteFlow(accountOwnerId, toDelete.id);
      setRecords((prev) => prev.filter((r) => r.id !== toDelete.id));
      toast('Flow deleted.', 'success');
      setToDelete(null);
    }, 'Could not delete the flow.');

  const handleLive = () =>
    run(async () => {
      if (!liveChange) return;
      await setLiveFlow(accountOwnerId, userId, liveChange.flow?.id ?? null);
      setLiveId(liveChange.flow?.id ?? null);
      toast(liveChange.flow ? `“${liveChange.flow.name}” is now live.` : 'No flow is live now.', 'success');
      setLiveChange(null);
    }, 'Could not change the live flow. Nothing was changed.');

  const header = (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard/calls')}
          className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to call history"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Call Flows</h1>
          <p className="mt-1 text-sm text-text-secondary">Design what callers hear: menus, business hours, routing and fallbacks.</p>
        </div>
      </div>
      {!loading && !loadError && (
        <Button type="button" size="sm" onClick={() => setShowNew((v) => !v)} disabled={records.length >= MAX_FLOWS}>
          <Plus size={14} /> New flow
        </Button>
      )}
    </div>
  );

  const newForm = showNew && (
    <Card className="mb-6 space-y-4 p-5 hover:translate-y-0">
      <h2 className="text-sm font-semibold text-text-primary">Create a flow</h2>
      <Input label="Flow name" value={newName} maxLength={MAX_FLOW_NAME_LENGTH} placeholder="e.g. Main line" onChange={(e) => setNewName(e.target.value)} />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-text-primary">Start from</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['starter', 'Menu with business hours', 'Open: a key menu. Closed: an after-hours notice. Ready to publish.'],
              ['blank', 'Blank', 'Every call goes straight to your AI receptionist. Build from there.'],
            ] as const
          ).map(([value, title, text]) => (
            <label key={value} className={`focus-within:ring-2 focus-within:ring-accent/40 flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${template === value ? 'border-accent bg-accent/5' : 'border-border'}`}>
              <input type="radio" name="flow-template" className="mt-1" checked={template === value} onChange={() => setTemplate(value)} />
              <span>
                <span className="block text-sm font-semibold text-text-primary">{title}</span>
                <span className="block text-xs text-text-secondary">{text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => void handleCreate()} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create and open
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowNew(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );

  if (loading) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        {header}
        <SkeletonCardList count={3} rows={2} />
      </DashboardLayout>
    );
  }

  if (loadError) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        {header}
        <EmptyState icon={AlertTriangle} title="Couldn't load your call flows" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel={PAGE_LABEL}>
      {header}
      {newForm}

      {records.length === 0 ? (
        !showNew && (
          <EmptyState
            icon={GitBranch}
            title="Design your first call flow"
            description="Greet callers, offer a key menu, branch on business hours and make sure no call is ever lost."
            action={{ label: 'Create a flow', onClick: () => setShowNew(true) }}
          />
        )
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2" aria-label="Call flows">
          {records.map((rec) => {
            const isLive = rec.id === liveId;
            const unpublished = !flowsEqual(rec.draft, rec.published);
            return (
              <li key={rec.id} className="min-w-0">
                <Card className="h-full space-y-4 p-5 hover:translate-y-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-semibold text-text-primary">{rec.name}</h2>
                      {isLive && <span className="rounded-full bg-success-500/10 px-2.5 py-1 text-[11px] font-semibold text-success-500">Live</span>}
                      {!rec.published && <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold text-text-secondary">Draft only</span>}
                      {rec.published && !unpublished && <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold text-text-secondary">Published v{rec.publishedVersion}</span>}
                      {rec.published && unpublished && <span className="rounded-full bg-warning-500/10 px-2.5 py-1 text-[11px] font-semibold text-warning-500">v{rec.publishedVersion} · unpublished changes</span>}
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {rec.draft.nodes.length} step{rec.draft.nodes.length === 1 ? '' : 's'} · updated {formatWhen(rec.updatedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => navigate(`${LIST_PATH}/${rec.id}`)}>
                      <Pencil size={14} /> Edit
                    </Button>
                    <Button type="button" variant="secondary" size="sm" onClick={() => void handleDuplicate(rec)} disabled={busy}>
                      <Copy size={14} /> Duplicate
                    </Button>
                    {isLive ? (
                      <Button type="button" variant="secondary" size="sm" onClick={() => setLiveChange({ flow: null })} disabled={busy}>
                        <PowerOff size={14} /> Take offline
                      </Button>
                    ) : (
                      <Button type="button" variant="secondary" size="sm" onClick={() => setLiveChange({ flow: rec })} disabled={busy || !rec.published} title={rec.published ? undefined : 'Publish this flow first'}>
                        <Power size={14} /> Make live
                      </Button>
                    )}
                    <Button type="button" variant="ghost" size="sm" onClick={() => setToDelete(rec)} disabled={busy || isLive} aria-label={`Delete ${rec.name}`} title={isLive ? 'Take this flow offline before deleting it' : undefined}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this flow?"
        description={`“${toDelete?.name ?? ''}” and its published version will be permanently removed. This can't be undone.`}
        confirmLabel={busy ? 'Deleting…' : 'Delete flow'}
        onConfirm={handleDelete}
        onCancel={() => setToDelete(null)}
      />
      <ConfirmDialog
        open={liveChange !== null}
        title={liveChange?.flow ? 'Make this flow live?' : 'Take the live flow offline?'}
        description={
          liveChange?.flow
            ? `New incoming calls will follow “${liveChange.flow.name}” (published v${liveChange.flow.publishedVersion}). Calls already in progress are not affected.`
            : 'No call flow will answer calls until you make one live again. Calls already in progress are not affected.'
        }
        confirmLabel={busy ? 'Saving…' : liveChange?.flow ? 'Make live' : 'Take offline'}
        onConfirm={handleLive}
        onCancel={() => setLiveChange(null)}
      />
    </DashboardLayout>
  );
}

// ============================================================
// BUILDER
// ============================================================

function FlowBuilder({ accountOwnerId, userId, flowId }: ScopeProps & { flowId: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [ctx, setCtx] = useState<FlowContext | null>(null);
  const [record, setRecord] = useState<FlowRecord | null>(null);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [config, setConfig] = useState<CallFlowConfig | null>(null);
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [simInput, setSimInput] = useState<FlowSimInput>({ at: wallClockNow(browserTimezone()), keys: [], ringOutcome: 'answered' });
  const editorRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setConflict(false);
    try {
      const [rec, context, live] = await Promise.all([fetchFlowRecord(accountOwnerId, flowId), fetchFlowContext(accountOwnerId), fetchLiveFlowId(accountOwnerId)]);
      setCtx(context);
      setRecord(rec);
      setLiveId(live);
      setConfig(rec?.draft ?? null);
      setName(rec?.name ?? '');
      setSelectedId(null);
      setSimInput({ at: wallClockNow(rec?.draft.timezone ?? browserTimezone()), keys: [], ringOutcome: 'answered' });
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId, flowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const flowIssues = useMemo(() => (config && ctx ? validateFlow(config, ctx) : []), [config, ctx]);
  const nameError = !name.trim() ? 'Give this flow a name.' : '';
  const errorCount = flowIssues.filter((i) => i.severity === 'error').length + (nameError ? 1 : 0);
  const warningCount = flowIssues.length - flowIssues.filter((i) => i.severity === 'error').length;
  const simResult = useMemo(() => (config && ctx ? simulateFlow(config, ctx, simInput) : null), [config, ctx, simInput]);
  const zones = useMemo(timezoneOptions, []);

  const dirty = config !== null && record !== null && (!flowsEqual(config, record.draft) || name.trim() !== record.name);
  const unpublished = config !== null && record !== null && !flowsEqual(config, record.published);
  const isLive = record !== null && liveId === record.id;

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const edit = (fn: (c: CallFlowConfig) => CallFlowConfig) => setConfig((c) => (c ? fn(c) : c));
  const select = (id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };
  const changeSim = (next: FlowSimInput) => setSimInput(next);

  const addNode = (kind: FlowNodeKind) => {
    if (!config || config.nodes.length >= MAX_NODES) {
      toast(`A flow can have at most ${MAX_NODES} steps.`, 'error');
      return;
    }
    const node = createNode(kind, config.nodes);
    edit((c) => ({ ...c, nodes: [...c.nodes, node], entryId: c.entryId && c.nodes.some((n) => n.id === c.entryId) ? c.entryId : node.id }));
    select(node.id);
  };

  const connect = (nodeId: string, slot: string, value: string) => {
    if (value.startsWith(NEW_PREFIX)) {
      const kind = value.slice(NEW_PREFIX.length);
      if (!config || !isNodeKind(kind) || config.nodes.length >= MAX_NODES) {
        toast(`A flow can have at most ${MAX_NODES} steps.`, 'error');
        return;
      }
      const node = createNode(kind, config.nodes);
      edit((c) => ({ ...c, nodes: [...c.nodes.map((n) => (n.id === nodeId ? setEdge(n, slot, node.id) : n)), node] }));
      select(node.id);
      return;
    }
    edit((c) => ({ ...c, nodes: c.nodes.map((n) => (n.id === nodeId ? setEdge(n, slot, value || null) : n)) }));
  };

  const changeNode = (node: FlowNode) => edit((c) => ({ ...c, nodes: c.nodes.map((n) => (n.id === node.id ? node : n)) }));
  const deleteNode = (id: string) => {
    edit((c) => removeNode(c, id));
    setSelectedId(null);
  };

  const handleError = (err: unknown, fallbackMessage: string) => {
    if (err instanceof FlowConflictError) {
      setConflict(true);
      toast(err.message, 'error');
    } else if (err instanceof FlowNameTakenError) {
      toast(err.message, 'error');
    } else {
      toast(fallbackMessage, 'error');
    }
  };

  const handleSave = async () => {
    if (!config || !record) return;
    if (nameError) {
      toast(nameError, 'error');
      return;
    }
    setSaving(true);
    try {
      const saved = await saveFlowDraft(accountOwnerId, userId, record.id, name, config, record.updatedAt);
      setRecord(saved);
      setName(saved.name);
      toast('Draft saved.', 'success');
    } catch (err) {
      handleError(err, 'Could not save your changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!config || !record || errorCount > 0) return;
    setPublishing(true);
    try {
      const base = dirty ? await saveFlowDraft(accountOwnerId, userId, record.id, name, config, record.updatedAt) : record;
      const published = await publishFlow(accountOwnerId, userId, base.id, name, config, base.publishedVersion, base.updatedAt);
      setRecord(published);
      setName(published.name);
      toast(isLive ? 'Published. New calls use this flow.' : 'Published. Make it live when you are ready.', 'success');
    } catch (err) {
      handleError(err, 'Could not publish. Nothing was changed.');
    } finally {
      setPublishing(false);
      setConfirmPublish(false);
    }
  };

  const handleMakeLive = async () => {
    if (!record) return;
    try {
      await setLiveFlow(accountOwnerId, userId, record.id);
      setLiveId(record.id);
      toast('This flow is now live.', 'success');
    } catch {
      toast('Could not make the flow live. Nothing was changed.', 'error');
    } finally {
      setConfirmLive(false);
    }
  };

  const statusLabel = !record?.published ? 'Draft only' : unpublished ? `Published v${record.publishedVersion} · unpublished changes` : `Published v${record.publishedVersion}`;
  const statusStyle = !record?.published ? 'bg-bg-tertiary text-text-secondary' : unpublished ? 'bg-warning-500/10 text-warning-500' : 'bg-success-500/10 text-success-500';

  const header = (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(LIST_PATH)}
          className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to all flows"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{record ? name.trim() || 'Untitled flow' : 'Call Flows'}</h1>
            {record && <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusStyle}`}>{statusLabel}</span>}
            {isLive && <span className="rounded-full bg-success-500/10 px-2.5 py-1 text-[11px] font-semibold text-success-500">Live</span>}
          </div>
          <p className="mt-1 text-sm text-text-secondary">Build the journey: what callers hear, which keys they press and where each call ends up.</p>
        </div>
      </div>
      {config && record && (
        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfig(record.draft);
                setName(record.name);
                setSelectedId(null);
              }}
              disabled={saving || publishing}
            >
              <RotateCcw size={14} /> Discard
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={() => void handleSave()} disabled={!dirty || saving || publishing}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save draft
          </Button>
          <Button type="button" size="sm" onClick={() => setConfirmPublish(true)} disabled={errorCount > 0 || publishing || saving || (!dirty && !unpublished)} title={errorCount > 0 ? `Fix ${errorCount} problem(s) to publish` : undefined}>
            {publishing ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} Publish
          </Button>
        </div>
      )}
    </div>
  );

  if (loading) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        {header}
        <SkeletonCardList count={3} rows={3} />
      </DashboardLayout>
    );
  }

  if (loadError || !ctx) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        {header}
        <EmptyState icon={AlertTriangle} title="Couldn't load this flow" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      </DashboardLayout>
    );
  }

  if (!record || !config) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        {header}
        <EmptyState icon={GitBranch} title="This flow doesn't exist" description="It may have been deleted. Go back to see your flows." action={{ label: 'All flows', onClick: () => navigate(LIST_PATH) }} />
      </DashboardLayout>
    );
  }

  const selectedNode = nodeById(config, selectedId);
  const publishDescription = isLive
    ? 'This flow is live. New incoming calls will follow the published version immediately. Calls already in progress are not affected.'
    : 'Publishing saves this version for the call engine. It does not change which flow answers calls — make it live when you are ready.';

  return (
    <DashboardLayout activeLabel={PAGE_LABEL}>
      {header}

      {conflict && (
        <div role="alert" className="mb-4 flex flex-col gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-text-primary">Someone else changed this flow. Reload to see the latest version — your unsaved edits here will be replaced.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw size={14} /> Reload
          </Button>
        </div>
      )}

      {record.published && !isLive && !dirty && !unpublished && (
        <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-text-primary">This flow is published but not live yet — callers still follow whichever flow is live now.</p>
          <Button type="button" size="sm" onClick={() => setConfirmLive(true)}>
            <Power size={14} /> Make live
          </Button>
        </div>
      )}

      {(flowIssues.length > 0 || nameError) && (
        <Card className="mb-4 p-4 hover:translate-y-0">
          <p className="text-sm font-semibold text-text-primary">
            {errorCount > 0 ? `${errorCount} problem${errorCount === 1 ? '' : 's'} to fix before publishing` : 'Ready to publish'}
            {warningCount > 0 && (
              <span className="font-normal text-text-secondary">
                {' '}
                · {warningCount} suggestion{warningCount === 1 ? '' : 's'}
              </span>
            )}
          </p>
          <ul className="mt-2 space-y-1">
            {nameError && <li className="text-xs text-danger">{nameError}</li>}
            {flowIssues.slice(0, 8).map((i, idx) => (
              <li key={idx} className={`text-xs ${i.severity === 'error' ? 'text-danger' : 'text-text-secondary'}`}>
                {i.nodeId ? (
                  <button type="button" className="focus-ring text-left underline-offset-2 hover:underline" onClick={() => select(i.nodeId as string)}>
                    {i.message}
                  </button>
                ) : (
                  i.message
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Add a step">
            {NODE_KINDS.map((kind) => {
              const Icon = NODE_ICONS[kind];
              return (
                <Button key={kind} type="button" variant="secondary" size="sm" onClick={() => addNode(kind)} disabled={config.nodes.length >= MAX_NODES}>
                  <Plus size={12} />
                  <Icon size={14} />
                  {NODE_KIND_META[kind].label}
                </Button>
              );
            })}
          </div>
          <FlowCanvas config={config} ctx={ctx} selectedId={selectedId} issues={flowIssues} simulation={simResult} onSelect={select} onConnect={connect} />
        </div>

        <div className="min-w-0 space-y-6">
          <div ref={editorRef}>
            {selectedNode ? (
              <NodeEditor
                key={selectedNode.id}
                node={selectedNode}
                ctx={ctx}
                issues={flowIssues.filter((i) => i.nodeId === selectedNode.id)}
                isEntry={config.entryId === selectedNode.id}
                onChange={changeNode}
                onMakeEntry={() => edit((c) => ({ ...c, entryId: selectedNode.id }))}
                onDelete={() => deleteNode(selectedNode.id)}
              />
            ) : (
              <Card className="p-5 text-sm text-text-secondary hover:translate-y-0">Select a step in the flow to edit it, or add a step above.</Card>
            )}
          </div>
          {simResult && <FlowSimulator config={config} input={simInput} result={simResult} onChange={changeSim} />}
          <Card className="space-y-4 p-5 hover:translate-y-0">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Flow settings</h2>
              <p className="text-xs text-text-secondary">Name and time zone.</p>
            </div>
            <Input label="Flow name" value={name} maxLength={MAX_FLOW_NAME_LENGTH} error={nameError || undefined} onChange={(e) => setName(e.target.value)} />
            <div>
              <Input
                label="Business time zone"
                list="call-flows-timezones"
                value={config.timezone}
                onChange={(e) => edit((c) => ({ ...c, timezone: e.target.value }))}
                error={isValidTimezone(config.timezone) ? undefined : 'Use an IANA time zone, e.g. America/Chicago'}
                helperText="Business hours and holidays are evaluated in this zone."
              />
              <datalist id="call-flows-timezones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog open={confirmPublish} title="Publish this call flow?" description={publishDescription} confirmLabel={publishing ? 'Publishing…' : 'Publish flow'} onConfirm={handlePublish} onCancel={() => setConfirmPublish(false)} />
      <ConfirmDialog
        open={confirmLive}
        title="Make this flow live?"
        description={`New incoming calls will follow “${record.name}” (published v${record.publishedVersion}). Calls already in progress are not affected.`}
        confirmLabel="Make live"
        onConfirm={handleMakeLive}
        onCancel={() => setConfirmLive(false)}
      />
    </DashboardLayout>
  );
}

// ============================================================
// PAGE (route entry: /dashboard/calls/flows and /dashboard/calls/flows/:id)
// ============================================================

export function CallFlowsPage() {
  const { id } = useParams<{ id: string }>();
  const { user, profile, teamMember, isOwner, permissions, profileLoading } = useAuth();

  // Flows are keyed by the ACCOUNT OWNER's id, never by the logged-in user's id —
  // a team member's own id would silently scope to nothing.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_manage_numbers;

  if (profileLoading || !profile) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        <SkeletonCardList count={3} rows={3} />
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">Call flows are restricted. Ask your account owner to grant you number management access.</p>
        </div>
      </DashboardLayout>
    );
  }

  if (!accountOwnerId || !user) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        <SkeletonCardList count={3} rows={3} />
      </DashboardLayout>
    );
  }

  return id ? <FlowBuilder key={id} accountOwnerId={accountOwnerId} userId={user.id} flowId={id} /> : <FlowList accountOwnerId={accountOwnerId} userId={user.id} />;
}
