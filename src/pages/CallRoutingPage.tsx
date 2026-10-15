import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, GitBranch, Loader2, Lock, Plus, RefreshCw, RotateCcw, Rocket, Save } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { RoutingFlow, RULE_ICONS } from '@/components/call-routing/RoutingFlow';
import { RuleEditor, FallbackEditor } from '@/components/call-routing/RuleEditor';
import { RoutingSimulator } from '@/components/call-routing/RoutingSimulator';
import { FlowSettings } from '@/components/call-routing/FlowSettings';
import {
  COMMON_LANGUAGES,
  MAX_RULES,
  RULE_KIND_META,
  RoutingConflictError,
  browserTimezone,
  configsEqual,
  createRule,
  createStarterConfig,
  fetchRoutingContext,
  fetchRoutingRecord,
  publishRouting,
  saveRoutingDraft,
  simulateCall,
  validateConfig,
  wallClockNow,
  type CallRoutingConfig,
  type RoutingContext,
  type RoutingRecord,
  type RoutingRule,
  type RoutingTarget,
  type RuleKind,
  type SimulationInput,
} from '@/lib/callRouting';

const RULE_KINDS = Object.keys(RULE_KIND_META) as RuleKind[];
const PAGE_LABEL = 'Call Routing';

export function CallRoutingPage() {
  const navigate = useNavigate();
  const { user, profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();

  // Calls, jobs and team data are keyed by the ACCOUNT OWNER's id, never by the
  // logged-in user's id — a team member's own id would silently scope to nothing.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_manage_numbers;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [ctx, setCtx] = useState<RoutingContext | null>(null);
  const [record, setRecord] = useState<RoutingRecord | null>(null);
  const [config, setConfig] = useState<CallRoutingConfig | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [simInput, setSimInput] = useState<SimulationInput>({
    at: wallClockNow(browserTimezone()),
    language: '',
    departmentId: null,
    emergency: false,
    ringOutcome: 'answered',
  });
  const editorRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    setLoadError(false);
    setConflict(false);
    try {
      const [rec, context] = await Promise.all([fetchRoutingRecord(accountOwnerId), fetchRoutingContext(accountOwnerId)]);
      setCtx(context);
      setRecord(rec);
      setConfig(rec?.draft ?? null);
      setSelectedId(null);
      setSimInput((prev) => ({ ...prev, at: wallClockNow(rec?.draft.timezone ?? browserTimezone()) }));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (canAccess) void load();
  }, [canAccess, load]);

  const issues = useMemo(() => (config && ctx ? validateConfig(config, ctx) : []), [config, ctx]);
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const simResult = useMemo(() => (config && ctx ? simulateCall(config, ctx, simInput) : null), [config, ctx, simInput]);
  const languageOptions = useMemo(() => {
    const seen = new Map<string, string>();
    [...COMMON_LANGUAGES, ...(ctx?.members.flatMap((m) => m.languages) ?? [])].forEach((l) => {
      const t = l.trim();
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    });
    return Array.from(seen.values());
  }, [ctx]);

  const dirty = config !== null && (record ? !configsEqual(config, record.draft) : true);
  const unpublished = config !== null && !configsEqual(config, record?.published ?? null);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const edit = (fn: (c: CallRoutingConfig) => CallRoutingConfig) => setConfig((c) => (c ? fn(c) : c));
  const select = (id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };

  const addRule = (kind: RuleKind) => {
    if (!config || config.rules.length >= MAX_RULES) {
      toast(`A flow can have at most ${MAX_RULES} rules.`, 'error');
      return;
    }
    const rule = createRule(kind);
    edit((c) => ({ ...c, rules: kind === 'emergency' ? [rule, ...c.rules] : [...c.rules, rule] }));
    select(rule.id);
  };
  const moveRule = (id: string, dir: -1 | 1) =>
    edit((c) => {
      const i = c.rules.findIndex((r) => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.rules.length) return c;
      const rules = [...c.rules];
      [rules[i], rules[j]] = [rules[j], rules[i]];
      return { ...c, rules };
    });
  const toggleRule = (id: string) => edit((c) => ({ ...c, rules: c.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) }));
  const changeRule = (rule: RoutingRule) => edit((c) => ({ ...c, rules: c.rules.map((r) => (r.id === rule.id ? rule : r)) }));
  const deleteRule = (id: string) => {
    edit((c) => ({ ...c, rules: c.rules.filter((r) => r.id !== id) }));
    setSelectedId(null);
  };
  const changeFallback = (fallback: RoutingTarget) => edit((c) => ({ ...c, fallback }));

  const handleError = (err: unknown, fallbackMessage: string) => {
    if (err instanceof RoutingConflictError) {
      setConflict(true);
      toast(err.message, 'error');
    } else {
      toast(fallbackMessage, 'error');
    }
  };

  const handleSave = async () => {
    if (!config || !user || !accountOwnerId) return;
    setSaving(true);
    try {
      setRecord(await saveRoutingDraft(accountOwnerId, user.id, config, record?.updatedAt ?? null));
      toast('Draft saved.', 'success');
    } catch (err) {
      handleError(err, 'Could not save your changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!config || !user || !accountOwnerId || errorCount > 0) return;
    setPublishing(true);
    try {
      const base = !record || dirty ? await saveRoutingDraft(accountOwnerId, user.id, config, record?.updatedAt ?? null) : record;
      setRecord(await publishRouting(accountOwnerId, user.id, config, base.publishedVersion, base.updatedAt));
      toast('Routing published. New calls use this flow.', 'success');
    } catch (err) {
      handleError(err, 'Could not publish. Nothing was changed.');
    } finally {
      setPublishing(false);
      setConfirmPublish(false);
    }
  };

  // ---------- gates & loading ----------
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
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">Call routing is restricted. Ask your account owner to grant you number management access.</p>
        </div>
      </DashboardLayout>
    );
  }

  const selectedRule = config?.rules.find((r) => r.id === selectedId) ?? null;
  const statusLabel = !record?.published ? 'Draft only' : unpublished ? `Live v${record.publishedVersion} · unpublished changes` : `Live v${record.publishedVersion}`;
  const statusStyle = !record?.published ? 'bg-bg-tertiary text-text-secondary' : unpublished ? 'bg-warning-500/10 text-warning-500' : 'bg-success-500/10 text-success-500';

  const header = (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Call Routing</h1>
            {config && <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusStyle}`}>{statusLabel}</span>}
          </div>
          <p className="mt-1 text-sm text-text-secondary">Decide exactly who answers every call — by hours, holiday, language, department and urgency.</p>
        </div>
      </div>
      {config && (
        <div className="flex flex-wrap items-center gap-2">
          {dirty && record && (
            <Button type="button" variant="ghost" size="sm" onClick={() => { setConfig(record.draft); setSelectedId(null); }} disabled={saving || publishing}>
              <RotateCcw size={14} /> Discard
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={handleSave} disabled={!dirty || saving || publishing}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save draft
          </Button>
          <Button type="button" size="sm" onClick={() => setConfirmPublish(true)} disabled={errorCount > 0 || publishing || saving || (!dirty && !unpublished)} title={errorCount > 0 ? `Fix ${errorCount} error(s) to publish` : undefined}>
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
        <EmptyState icon={AlertTriangle} title="Couldn't load call routing" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      </DashboardLayout>
    );
  }

  if (!config) {
    return (
      <DashboardLayout activeLabel={PAGE_LABEL}>
        {header}
        <EmptyState
          icon={GitBranch}
          title="Build your call flow"
          description="Start from a safe template — emergencies and after-hours calls reach your AI receptionist — then customize it."
          action={{ label: 'Create starter flow', onClick: () => setConfig(createStarterConfig(browserTimezone())) }}
        />
      </DashboardLayout>
    );
  }

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

      {issues.length > 0 && (
        <Card className="mb-4 p-4 hover:translate-y-0">
          <p className="text-sm font-semibold text-text-primary">
            {errorCount > 0 ? `${errorCount} problem${errorCount === 1 ? '' : 's'} to fix before publishing` : 'Ready to publish'}
            {warningCount > 0 && <span className="font-normal text-text-secondary"> · {warningCount} suggestion{warningCount === 1 ? '' : 's'}</span>}
          </p>
          <ul className="mt-2 space-y-1">
            {issues.slice(0, 8).map((i, idx) => (
              <li key={idx} className={`text-xs ${i.severity === 'error' ? 'text-danger' : 'text-text-secondary'}`}>
                {i.ruleId ? (
                  <button type="button" className="focus-ring text-left underline-offset-2 hover:underline" onClick={() => select(i.ruleId as string)}>
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
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Add a rule">
            {RULE_KINDS.map((kind) => {
              const Icon = RULE_ICONS[kind];
              return (
                <Button key={kind} type="button" variant="secondary" size="sm" onClick={() => addRule(kind)}>
                  <Plus size={12} />
                  <Icon size={14} />
                  {RULE_KIND_META[kind].label}
                </Button>
              );
            })}
          </div>
          <RoutingFlow config={config} ctx={ctx} selectedId={selectedId} issues={issues} simulation={simResult} onSelect={select} onMove={moveRule} onToggle={toggleRule} />
        </div>

        <div className="min-w-0 space-y-6">
          <div ref={editorRef}>
            {selectedRule ? (
              <RuleEditor rule={selectedRule} config={config} ctx={ctx} languageOptions={languageOptions} issues={issues.filter((i) => i.ruleId === selectedRule.id)} onChange={changeRule} onDelete={() => deleteRule(selectedRule.id)} />
            ) : selectedId === 'fallback' ? (
              <FallbackEditor config={config} ctx={ctx} issues={issues} onChange={changeFallback} />
            ) : (
              <Card className="p-5 text-sm text-text-secondary hover:translate-y-0">Select a step in the flow to edit it, or add a rule above.</Card>
            )}
          </div>
          {simResult && <RoutingSimulator config={config} input={simInput} result={simResult} languageOptions={languageOptions} onChange={setSimInput} />}
          <FlowSettings config={config} ctx={ctx} onChange={(c) => edit(() => c)} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmPublish}
        title="Publish this call flow?"
        description="New incoming calls will follow this flow immediately. Calls already in progress are not affected."
        confirmLabel={publishing ? 'Publishing…' : 'Publish flow'}
        onConfirm={handlePublish}
        onCancel={() => setConfirmPublish(false)}
      />
    </DashboardLayout>
  );
}
