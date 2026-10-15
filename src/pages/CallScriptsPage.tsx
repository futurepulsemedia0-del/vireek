import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ScrollText, Lock, FlaskConical, History, MessageSquare, PenLine } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { SkeletonCard, FadeIn } from '@/components/Skeleton';
import { ScriptEditor, type ScriptDraftState, type EditorBusy } from '@/components/call-scripts/ScriptEditor';
import { TestCallSimulator } from '@/components/call-scripts/TestCallSimulator';
import { ExperimentPanel } from '@/components/call-scripts/ExperimentPanel';
import { VersionHistory } from '@/components/call-scripts/VersionHistory';
import {
  LIMITS,
  SCENARIOS,
  STARTER_TEMPLATES,
  ensureScript,
  fetchScripts,
  fetchVersions,
  promoteChallenger,
  publishVersion,
  saveVersion,
  sanitizeScriptText,
  scenarioLabel,
  setTrafficSplit,
  startExperiment,
  stopExperiment,
  unpublishScript,
  validateScriptDraft,
  type CallScript,
  type CallScriptVersion,
  type ScenarioKey,
} from '@/lib/callScripts';

// ============================================================
// HELPERS
// ============================================================

type TabKey = 'editor' | 'test' | 'experiment' | 'history';

const TABS: { key: TabKey; label: string; icon: typeof PenLine }[] = [
  { key: 'editor', label: 'Editor', icon: PenLine },
  { key: 'test', label: 'Test call', icon: MessageSquare },
  { key: 'experiment', label: 'A/B test', icon: FlaskConical },
  { key: 'history', label: 'History', icon: History },
];

function draftFrom(version: CallScriptVersion | null, scenario: ScenarioKey): ScriptDraftState {
  if (version) return { opening_line: version.opening_line, body: version.body, note: '' };
  const starter = STARTER_TEMPLATES[scenario];
  return { opening_line: starter.opening_line, body: starter.body, note: '' };
}

function upsertScript(list: CallScript[], next: CallScript): CallScript[] {
  const without = list.filter((s) => s.id !== next.id);
  return [...without, next].sort((a, b) => a.scenario.localeCompare(b.scenario));
}

function friendlyError(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '42501') return 'You do not have permission to change call scripts.';
  if (err?.code === '23514' && err.message) return err.message;
  if (err?.code === '23505') return 'That was already created. Refresh and try again.';
  return 'Something went wrong. Please try again.';
}

function scenarioStatus(script: CallScript | undefined): { label: string; cls: string } {
  if (!script) return { label: 'Not set up', cls: 'bg-bg-tertiary text-text-secondary' };
  if (script.active_version_id && script.challenger_version_id) return { label: 'A/B running', cls: 'bg-accent/10 text-accent' };
  if (script.active_version_id) return { label: 'Live', cls: 'bg-success-500/10 text-success-500' };
  return { label: 'Draft', cls: 'bg-warning-500/10 text-warning-500' };
}

function ScenarioNav({
  scripts,
  selected,
  onSelect,
  orientation,
}: {
  scripts: CallScript[];
  selected: ScenarioKey;
  onSelect: (key: ScenarioKey) => void;
  orientation: 'vertical' | 'horizontal';
}) {
  const byScenario = new Map(scripts.map((s) => [s.scenario, s] as const));
  return (
    <nav
      aria-label="Scenarios"
      className={orientation === 'horizontal' ? 'flex gap-2 overflow-x-auto pb-1 lg:hidden' : 'hidden flex-col gap-1.5 lg:flex'}
    >
      {SCENARIOS.map((s) => {
        const status = scenarioStatus(byScenario.get(s.key));
        const active = s.key === selected;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect(s.key)}
            aria-current={active ? 'true' : undefined}
            className={`focus-ring flex shrink-0 items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
              active ? 'border-accent bg-accent/10' : 'border-border bg-bg-secondary hover:bg-bg-tertiary'
            }`}
          >
            <span className={`text-sm font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>{s.label}</span>
            <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${status.cls}`}>{status.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export function CallScriptsPage() {
  const navigate = useNavigate();
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canAccess = isOwner || permissions.can_edit_business_profile;

  const [scripts, setScripts] = useState<CallScript[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [scenario, setScenario] = useState<ScenarioKey>('new_inquiry');
  const [tab, setTab] = useState<TabKey>('editor');

  const [versions, setVersions] = useState<CallScriptVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState(false);
  const [versionsReload, setVersionsReload] = useState(0);
  const [draft, setDraft] = useState<ScriptDraftState>(() => draftFrom(null, 'new_inquiry'));

  const [editorBusy, setEditorBusy] = useState<EditorBusy>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [pendingScenario, setPendingScenario] = useState<ScenarioKey | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  const script = useMemo(() => scripts.find((s) => s.scenario === scenario) ?? null, [scripts, scenario]);

  // ---------- load all scripts ----------
  const loadScripts = useCallback(async () => {
    if (!canAccess) return;
    setLoading(true);
    setLoadError(false);
    try {
      setScripts(await fetchScripts());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [canAccess]);

  useEffect(() => {
    void loadScripts();
  }, [loadScripts]);

  // ---------- load versions for the selected scenario ----------
  const scriptId = script?.id ?? null;
  useEffect(() => {
    if (!canAccess || loading) return;
    if (!scriptId) {
      setVersions([]);
      setVersionsError(false);
      setDraft(draftFrom(null, scenario));
      return;
    }
    let cancelled = false;
    setVersionsLoading(true);
    setVersionsError(false);
    fetchVersions(scriptId)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        setDraft(draftFrom(list[0] ?? null, scenario));
      })
      .catch(() => {
        if (!cancelled) setVersionsError(true);
      })
      .finally(() => {
        if (!cancelled) setVersionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scenario, scriptId, canAccess, loading, versionsReload]);

  // ---------- dirty tracking ----------
  const baseline = versions[0] ?? null;
  const initial = useMemo(() => draftFrom(baseline, scenario), [baseline, scenario]);
  const contentChanged =
    sanitizeScriptText(draft.opening_line, LIMITS.openingMax) !== sanitizeScriptText(initial.opening_line, LIMITS.openingMax) ||
    sanitizeScriptText(draft.body, LIMITS.bodyMax) !== sanitizeScriptText(initial.body, LIMITS.bodyMax);
  const edited = contentChanged || draft.note.trim() !== '';
  const dirty = baseline ? contentChanged : true;

  const requestScenario = (next: ScenarioKey) => {
    if (next === scenario) return;
    if (edited) setPendingScenario(next);
    else setScenario(next);
  };

  // ---------- script actions ----------
  const handleSave = async (publish: boolean) => {
    const check = validateScriptDraft({ scenario, opening_line: draft.opening_line, body: draft.body });
    if (!check.ok) return;
    setEditorBusy(publish ? 'publish' : 'save');
    try {
      const current = script ?? (await ensureScript(scenario));
      const saved = await saveVersion({
        scriptId: current.id,
        opening_line: draft.opening_line,
        body: draft.body,
        change_note: draft.note,
      });
      setVersions((prev) => [saved, ...prev.filter((v) => v.id !== saved.id)]);
      setDraft((d) => ({ ...d, note: '' }));

      let next = current;
      if (publish) {
        try {
          next = await publishVersion(current, saved.id);
          toast(`Version ${saved.version_number} is live.`, 'success');
        } catch (e) {
          toast(`Saved as version ${saved.version_number}, but publishing failed. ${friendlyError(e)}`, 'error');
        }
      } else {
        toast(`Saved as version ${saved.version_number}.`, 'success');
      }
      setScripts((prev) => upsertScript(prev, next));
    } catch (e) {
      // Deliberately NOT adding a freshly created script row to state here:
      // that would reload versions and wipe the draft the person just typed.
      toast(friendlyError(e), 'error');
    } finally {
      setEditorBusy(null);
    }
  };

  const runScriptAction = async (action: () => Promise<CallScript>, success: string): Promise<void> => {
    setActionBusy(true);
    try {
      const next = await action();
      setScripts((prev) => upsertScript(prev, next));
      toast(success, 'success');
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const handleUnpublish = async () => {
    if (!script) return;
    setConfirmUnpublish(false);
    setEditorBusy('unpublish');
    try {
      const next = await unpublishScript(script.id);
      setScripts((prev) => upsertScript(prev, next));
      toast('Script unpublished. Calls use your base prompt for this scenario.', 'success');
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setEditorBusy(null);
    }
  };

  const handlePublishVersion = async (version: CallScriptVersion) => {
    if (!script) return;
    setPublishingId(version.id);
    try {
      const next = await publishVersion(script, version.id);
      setScripts((prev) => upsertScript(prev, next));
      toast(`Version ${version.version_number} is live.`, 'success');
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setPublishingId(null);
    }
  };

  const handleEditFrom = (version: CallScriptVersion) => {
    setDraft({ opening_line: version.opening_line, body: version.body, note: `Based on version ${version.version_number}` });
    setTab('editor');
    toast(`Loaded version ${version.version_number} into the editor. Save to create a new version.`, 'info');
  };

  // ---------- derived ----------
  const liveCount = scripts.filter((s) => !!s.active_version_id).length;
  const simulatorSource = !baseline || contentChanged ? 'your current draft' : `saved version ${baseline.version_number}`;

  // ============================================================
  // RENDER
  // ============================================================

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Call Scripts">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Call Scripts change what your AI assistant says on real calls. Ask your account owner to grant you the "Edit Business Profile" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Call Scripts">
      <div className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="focus-ring flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary transition-colors hover:text-text-primary"
          aria-label="Back to dashboard"
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <ScrollText size={16} />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Call Scripts</h1>
          </div>
          <p className="mt-1 text-sm text-text-secondary">
            Tune what your assistant says in each situation, test it, and let real bookings show which version wins
            {!loading && !loadError ? ` · ${liveCount} of ${SCENARIOS.length} scenarios live` : ''}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <SkeletonCard rows={5} withIcon={false} />
          <SkeletonCard rows={8} withIcon={false} />
        </div>
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center">
          <p className="text-base font-semibold text-text-primary">Couldn't load your call scripts</p>
          <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
          <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void loadScripts()}>
            Try again
          </Button>
        </div>
      ) : (
        <FadeIn>
          <details className="mb-4 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
            <summary className="cursor-pointer font-medium text-text-primary">How scripts reach live calls</summary>
            <p className="mt-2 leading-relaxed">
              When a call starts, your live scripts are added to the assistant's instructions through the{' '}
              <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs">{'{{call_scripts_context}}'}</code> variable. Make sure your
              assistant's system prompt in Vapi contains that variable, otherwise scripts are saved but never used. During an A/B test each
              call is assigned fairly at random, and results come from the calls that actually happen.
            </p>
          </details>

          <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
            <div>
              <ScenarioNav scripts={scripts} selected={scenario} onSelect={requestScenario} orientation="horizontal" />
              <ScenarioNav scripts={scripts} selected={scenario} onSelect={requestScenario} orientation="vertical" />
            </div>

            <section className="min-w-0 rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-text-primary">{scenarioLabel(scenario)}</h2>
                <p className="text-sm text-text-secondary">{SCENARIOS.find((s) => s.key === scenario)?.hint}</p>
              </div>

              <div role="tablist" aria-label="Script tools" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-primary p-1">
                {TABS.map((t) => {
                  const Icon = t.icon;
                  const active = tab === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      id={`call-scripts-tab-${t.key}`}
                      aria-selected={active}
                      aria-controls={`call-scripts-panel-${t.key}`}
                      onClick={() => setTab(t.key)}
                      className={`focus-ring flex min-h-[40px] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors ${
                        active ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      <Icon size={15} />
                      {t.label}
                    </button>
                  );
                })}
              </div>

              <div role="tabpanel" id={`call-scripts-panel-${tab}`} aria-labelledby={`call-scripts-tab-${tab}`}>
                {versionsLoading ? (
                  <SkeletonCard rows={6} withIcon={false} />
                ) : versionsError ? (
                  <div role="alert" className="flex flex-col items-center py-10 text-center">
                    <p className="text-base font-semibold text-text-primary">Couldn't load this script's versions</p>
                    <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => setVersionsReload((n) => n + 1)}>
                      Try again
                    </Button>
                  </div>
                ) : tab === 'editor' ? (
                  <ScriptEditor
                    scenario={scenario}
                    script={script}
                    versions={versions}
                    draft={draft}
                    onDraftChange={setDraft}
                    dirty={dirty}
                    busy={editorBusy}
                    onSave={(publish) => void handleSave(publish)}
                    onUnpublish={() => setConfirmUnpublish(true)}
                  />
                ) : tab === 'test' ? (
                  <TestCallSimulator
                    scenario={scenario}
                    opening_line={draft.opening_line}
                    body={draft.body}
                    sourceLabel={simulatorSource}
                  />
                ) : tab === 'experiment' ? (
                  <ExperimentPanel
                    script={script}
                    versions={versions}
                    busy={actionBusy}
                    onStart={(challengerId, pct) =>
                      script
                        ? runScriptAction(() => startExperiment(script.id, challengerId, pct), 'A/B test started.')
                        : Promise.resolve()
                    }
                    onSetSplit={(pct) =>
                      script ? runScriptAction(() => setTrafficSplit(script.id, pct), 'Traffic split updated.') : Promise.resolve()
                    }
                    onStop={() =>
                      script ? runScriptAction(() => stopExperiment(script.id), 'A/B test stopped.') : Promise.resolve()
                    }
                    onPromote={() =>
                      script ? runScriptAction(() => promoteChallenger(script), 'Challenger is now live.') : Promise.resolve()
                    }
                  />
                ) : versions.length === 0 ? (
                  <EmptyState
                    icon={History}
                    title="No saved versions"
                    description="Save your first version in the Editor. Every save is kept here so you can compare and roll back."
                    action={{ label: 'Go to editor', onClick: () => setTab('editor') }}
                  />
                ) : (
                  <VersionHistory
                    script={script}
                    versions={versions}
                    publishingId={publishingId}
                    onEditFrom={handleEditFrom}
                    onPublish={handlePublishVersion}
                  />
                )}
              </div>
            </section>
          </div>
        </FadeIn>
      )}

      <ConfirmDialog
        open={pendingScenario !== null}
        title="Discard unsaved changes?"
        description="You have edits that haven't been saved as a version. Switching scenarios will discard them."
        confirmLabel="Discard changes"
        onCancel={() => setPendingScenario(null)}
        onConfirm={() => {
          if (pendingScenario) setScenario(pendingScenario);
          setPendingScenario(null);
        }}
      />
      <ConfirmDialog
        open={confirmUnpublish}
        title="Unpublish this script?"
        description="New calls in this scenario will go back to your assistant's base prompt. Any running A/B test will end. Saved versions are kept."
        confirmLabel="Unpublish"
        onCancel={() => setConfirmUnpublish(false)}
        onConfirm={handleUnpublish}
      />
    </DashboardLayout>
  );
}
