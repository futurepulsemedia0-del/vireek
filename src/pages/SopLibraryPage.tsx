import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  BookOpenCheck,
  Download,
  FileText,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { ProgressBar, StatusBadge } from '@/components/sop/SopUi';
import { EditorLookups, SopEditor } from '@/components/sop/SopEditor';
import {
  CompletionRow,
  SopFormState,
  SopStatus,
  SopSummary,
  SopVersionRow,
  completionToCsv,
  deleteDraftSop,
  describeSopError,
  emptySopForm,
  fetchCompletionReport,
  fetchSopForm,
  fetchSopVersions,
  fetchSops,
  fetchTeamLookups,
  formatDue,
  setSopArchived,
  sortTraining,
  summarizeBySop,
  summarizeCompletion,
} from '@/lib/sop';

type StatusFilter = 'all' | SopStatus;

const iconButtonClass =
  'focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';

const STATUS_TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'published', label: 'Published' },
  { key: 'draft', label: 'Drafts' },
  { key: 'archived', label: 'Archived' },
];

function StatCard({ label, value, tone = 'text-text-primary' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone}`}>{value}</p>
    </div>
  );
}

// ============================================================
// Completion drawer — who has / has not completed one SOP
// ============================================================

function CompletionDialog({ sop, onClose }: { sop: SopSummary; onClose: () => void }) {
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  const { toast } = useToast();
  const [rows, setRows] = useState<CompletionRow[] | null>(null);
  const [versions, setVersions] = useState<SopVersionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchCompletionReport(sop.id), fetchSopVersions(sop.id)])
      .then(([r, v]) => {
        if (cancelled) return;
        setRows(sortTraining(r));
        setVersions(v);
      })
      .catch((err) => { if (!cancelled) setError(describeSopError(err, 'Could not load completion.')); });
    return () => { cancelled = true; };
  }, [sop.id]);

  const summary = useMemo(() => summarizeCompletion(rows ?? []), [rows]);

  const exportCsv = () => {
    if (!rows) return;
    const blob = new Blob([completionToCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sop-completion-${sop.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Completion report exported.', 'success');
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sop-completion-title"
        className="relative flex h-[94dvh] w-full max-w-3xl flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:h-auto sm:max-h-[90vh] sm:rounded-2xl dark:shadow-card-hover-dark"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="sop-completion-title" className="truncate text-lg font-bold text-text-primary">{sop.title}</h2>
            <p className="text-xs text-text-secondary">Version {sop.published_version} · completion</p>
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" variant="secondary" size="sm" onClick={exportCsv} disabled={!rows || rows.length === 0}>
              <Download size={16} /> Export CSV
            </Button>
            <button type="button" onClick={onClose} className={iconButtonClass} aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {!rows && !error && <SkeletonCardList count={3} rows={1} />}
          {rows && (
            <>
              <div>
                <div className="mb-1.5 flex justify-between text-sm">
                  <span className="font-medium text-text-primary">{summary.completed} of {summary.total} complete</span>
                  <span className="text-text-secondary">{summary.pct}%</span>
                </div>
                <ProgressBar pct={summary.pct} label="Completion" />
              </div>

              {rows.length === 0 ? (
                <p className="text-sm text-text-secondary">Nobody is assigned yet, or the people assigned have not accepted their invite.</p>
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {rows.map((r) => (
                    <li key={`${r.user_id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-text-primary">{r.full_name}</p>
                        <p className="truncate text-xs text-text-secondary">
                          {r.role}
                          {r.acknowledged_at
                            ? ` · acknowledged ${new Date(r.acknowledged_at).toLocaleString()}`
                            : ` · ${formatDue(r.due_at)}`}
                          {r.quiz_required && r.best_score !== null ? ` · best quiz ${r.best_score}%` : ''}
                        </p>
                      </div>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}

              {versions.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-bold text-text-primary">Version history</h3>
                  <ul className="space-y-1.5 text-xs text-text-secondary">
                    {versions.map((v) => (
                      <li key={v.version}>
                        <span className="font-semibold text-text-primary">v{v.version}</span> · {new Date(v.published_at).toLocaleDateString()}
                        {v.change_note ? ` — ${v.change_note}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function SopLibraryPage() {
  const { isOwner, profile, teamMember, permissions } = useAuth();
  const { toast } = useToast();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canManage = isOwner || permissions.can_manage_team;

  const [sops, setSops] = useState<SopSummary[]>([]);
  const [report, setReport] = useState<CompletionRow[]>([]);
  const [lookups, setLookups] = useState<EditorLookups>({ members: [], customRoles: [], templates: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const [editor, setEditor] = useState<null | { sopId: string | null; initial: SopFormState; version: number }>(null);
  const [completionFor, setCompletionFor] = useState<SopSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SopSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canManage) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [list, rep, look] = await Promise.all([fetchSops(accountOwnerId), fetchCompletionReport(null), fetchTeamLookups(accountOwnerId)]);
      setSops(list);
      setReport(rep);
      setLookups(look);
    } catch (err) {
      setLoadError(describeSopError(err, 'Could not load the SOP library.'));
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId, canManage]);

  useEffect(() => { void load(); }, [load]);

  const bySop = useMemo(() => summarizeBySop(report), [report]);
  const overall = useMemo(() => summarizeCompletion(report), [report]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sops.filter((s) => (status === 'all' || s.status === status) && (!q || `${s.title} ${s.category ?? ''} ${s.summary ?? ''}`.toLowerCase().includes(q)));
  }, [sops, search, status]);

  const openEditor = async (sop: SopSummary | null) => {
    if (!accountOwnerId) return;
    if (!sop) { setEditor({ sopId: null, initial: emptySopForm(), version: 0 }); return; }
    setBusyId(sop.id);
    try {
      setEditor({ sopId: sop.id, initial: await fetchSopForm(accountOwnerId, sop.id), version: sop.published_version });
    } catch (err) {
      toast(describeSopError(err, 'Could not open the SOP.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const toggleArchive = async (sop: SopSummary) => {
    setBusyId(sop.id);
    try {
      await setSopArchived(sop.id, sop.status !== 'archived');
      toast(sop.status === 'archived' ? 'SOP restored.' : 'SOP archived. It no longer appears in anyone\'s training.', 'success');
      await load();
    } catch (err) {
      toast(describeSopError(err, 'Could not update the SOP.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteDraftSop(deleteTarget.id);
      toast('Draft deleted.', 'success');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast(describeSopError(err, 'Could not delete the draft.'), 'error');
      setDeleteTarget(null);
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="SOP Library">
        <EmptyState
          icon={Lock}
          title="You don't have access to the SOP Library"
          description="Ask your account owner for the Manage Team permission. You can still complete your assigned training under My Training."
        />
      </DashboardLayout>
    );
  }

  const published = sops.filter((s) => s.status === 'published').length;

  return (
    <DashboardLayout activeLabel="SOP Library">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><BookOpenCheck size={22} /></span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">SOP Library</h1>
            <p className="text-sm text-text-secondary">
              Standard operating procedures with read-and-acknowledge, quizzes and proof of completion — linked to your job templates.
            </p>
          </div>
        </div>
        <Button type="button" size="sm" onClick={() => void openEditor(null)} disabled={!accountOwnerId}>
          <Plus size={16} /> New SOP
        </Button>
      </div>

      {!loading && !loadError && sops.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Published SOPs" value={published} />
          <StatCard label="Completion" value={`${overall.pct}%`} tone="text-success" />
          <StatCard label="Overdue" value={overall.overdue} tone={overall.overdue > 0 ? 'text-danger' : 'text-text-primary'} />
          <StatCard label="Needs re-acknowledge" value={overall.needsReack} tone={overall.needsReack > 0 ? 'text-warning-500' : 'text-text-primary'} />
        </div>
      )}

      {!loading && !loadError && sops.length > 0 && (
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="sm:w-80">
            <Input type="search" icon={Search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SOPs" aria-label="Search SOPs" className="!py-2.5 !text-sm" />
          </div>
          <div role="tablist" aria-label="SOP status" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={status === tab.key}
                onClick={() => setStatus(tab.key)}
                className={`focus-ring whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${status === tab.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <SkeletonCardList count={4} rows={2} />
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-8 text-center">
          <AlertCircle className="text-danger" />
          <p className="text-sm text-text-primary">{loadError}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}><RefreshCw size={16} /> Try again</Button>
        </div>
      ) : sops.length === 0 ? (
        <EmptyState
          icon={BookOpenCheck}
          title="No SOPs yet"
          description="Write or upload your first procedure, assign it to your technicians and get a timestamped acknowledgement from each of them."
          action={{ label: 'Create your first SOP', onClick: () => void openEditor(null) }}
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={Search} title="No SOPs match" description="Try a different search or status filter." />
      ) : (
        <ul className="space-y-3">
          {visible.map((s) => {
            const sum = bySop.get(s.id);
            const busy = busyId === s.id;
            return (
              <li key={s.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-semibold text-text-primary">{s.title}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.status === 'published' ? 'bg-success/10 text-success' : s.status === 'draft' ? 'bg-bg-tertiary text-text-secondary' : 'bg-warning-500/10 text-warning-500'}`}>
                        {s.status === 'published' ? `Published v${s.published_version}` : s.status === 'draft' ? 'Draft' : 'Archived'}
                      </span>
                      {s.category && <span className="text-xs text-text-secondary">{s.category}</span>}
                    </div>
                    {s.summary && <p className="mt-1 text-sm text-text-secondary">{s.summary}</p>}
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
                      {s.file_name && <span className="inline-flex items-center gap-1"><FileText size={12} /> {s.file_name}</span>}
                      <span>{s.quiz_count > 0 ? `${s.quiz_count}-question quiz` : 'No quiz'}</span>
                      <span>{s.assignment_count} assignment{s.assignment_count === 1 ? '' : 's'}</span>
                      <span>{s.template_count} linked template{s.template_count === 1 ? '' : 's'}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {s.published_version > 0 && (
                      <button type="button" className={iconButtonClass} aria-label={`Completion for ${s.title}`} title="Completion" onClick={() => setCompletionFor(s)}>
                        <Users size={18} />
                      </button>
                    )}
                    <button type="button" className={iconButtonClass} aria-label={`Edit ${s.title}`} title="Edit" disabled={busy} onClick={() => void openEditor(s)}>
                      <Pencil size={18} />
                    </button>
                    {s.published_version > 0 ? (
                      <button type="button" className={iconButtonClass} aria-label={s.status === 'archived' ? `Restore ${s.title}` : `Archive ${s.title}`} title={s.status === 'archived' ? 'Restore' : 'Archive'} disabled={busy} onClick={() => void toggleArchive(s)}>
                        {s.status === 'archived' ? <ArchiveRestore size={18} /> : <Archive size={18} />}
                      </button>
                    ) : (
                      <button type="button" className={iconButtonClass} aria-label={`Delete draft ${s.title}`} title="Delete draft" disabled={busy} onClick={() => setDeleteTarget(s)}>
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                </div>

                {s.status === 'published' && sum && sum.total > 0 && (
                  <div className="mt-4">
                    <div className="mb-1.5 flex justify-between text-xs text-text-secondary">
                      <span>{sum.completed} of {sum.total} complete{sum.overdue > 0 ? ` · ${sum.overdue} overdue` : ''}{sum.needsReack > 0 ? ` · ${sum.needsReack} to re-acknowledge` : ''}</span>
                      <span>{sum.pct}%</span>
                    </div>
                    <ProgressBar pct={sum.pct} label={`${s.title} completion`} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editor && accountOwnerId && (
        <SopEditor
          accountOwnerId={accountOwnerId}
          sopId={editor.sopId}
          initial={editor.initial}
          publishedVersion={editor.version}
          lookups={lookups}
          onClose={() => setEditor(null)}
          onSaved={(message) => { toast(message, 'success'); setEditor(null); void load(); }}
        />
      )}
      {completionFor && <CompletionDialog sop={completionFor} onClose={() => setCompletionFor(null)} />}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this draft?"
        description={`"${deleteTarget?.title ?? ''}" was never published, so nobody has acknowledged it. This can't be undone.`}
        confirmLabel="Delete draft"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </DashboardLayout>
  );
}
