import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Check, LayoutDashboard, Lock, Plus, RotateCcw, TriangleAlert as AlertTriangle, Undo2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { OverviewGrid } from '@/components/overview/OverviewGrid';
import {
  WIDGETS,
  buildPresetLayout,
  hiddenItems,
  moveWidget,
  moveWidgetBy,
  resizeWidget,
  setWidgetHidden,
  visibleItems,
  type OverviewLayout,
  type OverviewWidgetId,
} from '@/lib/overviewLayout';
import {
  ROLE_DESCRIPTIONS,
  ROLE_KEYS,
  WIDGET_DESCRIPTIONS,
  buildRoleMaps,
  copyLayout,
  isRoleDirty,
  permissionNote,
  publishedLayout,
  roleLabel,
  validateRoleLayout,
  type RoleKey,
  type RoleLayoutMaps,
} from '@/lib/dashboardRoleLayouts';
import { deleteRoleLayout, fetchRoleLayouts, saveRoleLayout } from '@/lib/dashboardRoleLayoutsApi';

const PAGE = 'Dashboard Builder';

/** The builder shows every widget, whatever permissions the designer has. */
const ALL_ALLOWED = () => true;

type Status = 'loading' | 'error' | 'ready';
type Pending = { kind: 'reset' } | { kind: 'copy'; from: RoleKey } | null;

function renderPlaceholder(id: OverviewWidgetId) {
  const note = permissionNote(id);
  return (
    <div className="flex h-full min-h-[120px] flex-col justify-end rounded-2xl border border-border bg-bg-secondary p-4 pt-12">
      <p className="text-sm font-semibold text-text-primary">{WIDGETS[id].title}</p>
      <p className="mt-1 text-xs text-text-secondary">{WIDGET_DESCRIPTIONS[id]}</p>
      {note && <p className="mt-2 text-[11px] text-text-secondary">{note}</p>}
    </div>
  );
}

function Header() {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        <LayoutDashboard size={24} aria-hidden="true" />
      </span>
      <div>
        <h1 className="text-xl font-bold text-text-primary">Dashboard Builder</h1>
        <p className="text-sm text-text-secondary">Design the Overview each role sees when they sign in.</p>
      </div>
    </div>
  );
}

function NoAccess() {
  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <Lock size={26} aria-hidden="true" />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Dashboard layouts are managed by people who can manage the team. Ask your account owner to grant you the "Manage Team" permission.
        </p>
      </div>
    </DashboardLayout>
  );
}

export function DashboardBuilderPage() {
  const { profile, profileLoading, isOwner, permissions, teamMember } = useAuth();
  const { toast } = useToast();
  // Layouts belong to the ACCOUNT: team members read and write the owner's rows.
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canManage = isOwner || permissions.can_manage_team;

  const [status, setStatus] = useState<Status>('loading');
  const [maps, setMaps] = useState<RoleLayoutMaps | null>(null);
  const [role, setRole] = useState<RoleKey>('owner');
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Pending>(null);

  const load = useCallback(async () => {
    if (!ownerId) {
      setStatus('error');
      return;
    }
    setStatus('loading');
    try {
      setMaps(buildRoleMaps(await fetchRoleLayouts(ownerId)));
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [ownerId]);

  useEffect(() => {
    if (!profileLoading && canManage) void load();
  }, [profileLoading, canManage, load]);

  const dirtyRoles = useMemo(
    () => (maps ? ROLE_KEYS.filter((r) => isRoleDirty(maps.drafts[r], maps.saved[r], r)) : []),
    [maps],
  );

  useEffect(() => {
    if (dirtyRoles.length === 0) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirtyRoles.length]);

  /** Applies a pure layout edit to the selected role's draft. Functional, so rapid drag events never use stale state. */
  const updateDraft = useCallback(
    (edit: (layout: OverviewLayout) => OverviewLayout) => {
      setMaps((m) => {
        if (!m) return m;
        const next = edit(m.drafts[role]);
        return next === m.drafts[role] ? m : { ...m, drafts: { ...m.drafts, [role]: next } };
      });
    },
    [role],
  );

  const onMove = useCallback((id: OverviewWidgetId, targetId: OverviewWidgetId) => updateDraft((l) => moveWidget(l, id, targetId)), [updateDraft]);
  const onMoveBy = useCallback((id: OverviewWidgetId, delta: -1 | 1) => updateDraft((l) => moveWidgetBy(l, id, delta, ALL_ALLOWED)), [updateDraft]);
  const onResize = useCallback((id: OverviewWidgetId, size: { w?: number; h?: number }) => updateDraft((l) => resizeWidget(l, id, size)), [updateDraft]);
  const onHide = useCallback((id: OverviewWidgetId) => updateDraft((l) => setWidgetHidden(l, id, true)), [updateDraft]);
  const onAdd = useCallback((id: OverviewWidgetId) => updateDraft((l) => setWidgetHidden(l, id, false)), [updateDraft]);

  if (profileLoading) {
    return (
      <DashboardLayout activeLabel={PAGE}>
        <SkeletonCardList count={3} rows={3} />
      </DashboardLayout>
    );
  }
  if (!canManage) return <NoAccess />;

  const draft = maps?.drafts[role] ?? null;
  const saved = maps?.saved[role] ?? null;
  const roleDirty = Boolean(draft && isRoleDirty(draft, saved, role));
  const problem = draft ? validateRoleLayout(draft) : null;
  const visible = draft ? visibleItems(draft, ALL_ALLOWED) : [];
  const available = draft ? hiddenItems(draft, ALL_ALLOWED) : [];

  const handleSave = async () => {
    if (!maps || !ownerId || saving) return;
    const target = role;
    const layout = maps.drafts[target];
    if (validateRoleLayout(layout)) return;
    setSaving(true);
    try {
      await saveRoleLayout(ownerId, target, layout);
      setMaps((m) => (m ? { ...m, saved: { ...m.saved, [target]: layout } } : m));
      toast(`${roleLabel(target)} layout saved.`, 'success');
    } catch {
      toast('Could not save this layout. Check your connection and try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    const target = role;
    setMaps((m) => (m ? { ...m, drafts: { ...m.drafts, [target]: publishedLayout(m.saved[target], target) } } : m));
  };

  const handleReset = async () => {
    if (!maps || !ownerId) return;
    const target = role;
    setSaving(true);
    try {
      if (maps.saved[target]) await deleteRoleLayout(ownerId, target);
      setMaps((m) =>
        m ? { saved: { ...m.saved, [target]: null }, drafts: { ...m.drafts, [target]: buildPresetLayout(target) } } : m,
      );
      toast(`${roleLabel(target)} layout reset to the built-in default.`, 'info');
    } catch {
      toast('Could not reset this layout. Check your connection and try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = (from: RoleKey) => {
    const target = role;
    setMaps((m) => (m ? { ...m, drafts: { ...m.drafts, [target]: copyLayout(m.drafts[from]) } } : m));
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, current: RoleKey) => {
    const idx = ROLE_KEYS.indexOf(current);
    let next: number;
    if (e.key === 'ArrowRight') next = (idx + 1) % ROLE_KEYS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + ROLE_KEYS.length) % ROLE_KEYS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ROLE_KEYS.length - 1;
    else return;
    e.preventDefault();
    const target = ROLE_KEYS[next];
    setRole(target);
    document.getElementById(`role-tab-${target}`)?.focus();
  };

  const confirmCopy = pending?.kind === 'copy' ? pending.from : null;

  return (
    <DashboardLayout activeLabel={PAGE}>
      <Header />

      {status === 'loading' && <SkeletonCardList count={3} rows={3} />}

      {status === 'error' && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load dashboard layouts"
          description="Check your connection and try again."
          action={{ label: 'Retry', onClick: () => void load() }}
        />
      )}

      {status === 'ready' && maps && draft && (
        <div className="space-y-5">
          <p className="rounded-xl border border-border bg-bg-secondary px-4 py-3 text-xs leading-relaxed text-text-secondary">
            Drag widgets to reorder, drag the corner to resize, and add more from the list. Team members who customized their own Overview keep it; everyone else in the role sees the layout you save here. On phones, widgets always stack full width.
          </p>

          <div role="tablist" aria-label="Role" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {ROLE_KEYS.map((r) => {
              const selected = r === role;
              return (
                <button
                  key={r}
                  id={`role-tab-${r}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="role-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setRole(r)}
                  onKeyDown={(e) => onTabKey(e, r)}
                  className={`focus-ring inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-medium transition-colors ${
                    selected
                      ? 'border-accent bg-accent/10 text-text-primary'
                      : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {roleLabel(r)}
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                    {maps.saved[r] ? 'Custom' : 'Default'}
                  </span>
                  {dirtyRoles.includes(r) && (
                    <span role="img" aria-label="Unsaved changes" className="h-2 w-2 rounded-full bg-accent" />
                  )}
                </button>
              );
            })}
          </div>

          <div role="tabpanel" id="role-panel" aria-labelledby={`role-tab-${role}`} className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-sm font-semibold text-text-primary">{roleLabel(role)} dashboard</p>
                <p className="text-xs text-text-secondary">{ROLE_DESCRIPTIONS[role]}</p>
              </div>

              <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                Copy from
                <select
                  value=""
                  onChange={(e) => {
                    const from = e.target.value as RoleKey;
                    if (from) setPending({ kind: 'copy', from });
                  }}
                  disabled={saving}
                  className="focus-ring min-h-[40px] rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary"
                >
                  <option value="">Choose a role…</option>
                  {ROLE_KEYS.filter((r) => r !== role).map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              </label>

              <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={!roleDirty || saving}>
                <Undo2 size={16} aria-hidden="true" />
                Discard changes
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPending({ kind: 'reset' })} disabled={saving || (!saved && !roleDirty)}>
                <RotateCcw size={16} aria-hidden="true" />
                Reset to default
              </Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={!roleDirty || saving || problem !== null}>
                <Check size={16} aria-hidden="true" />
                {saving ? 'Saving…' : 'Save layout'}
              </Button>
              {problem && (
                <p role="alert" className="basis-full text-xs text-danger">
                  {problem}
                </p>
              )}
            </div>

            <section aria-label="Available widgets" className="rounded-2xl border border-border bg-bg-secondary p-4">
              <h2 className="text-sm font-semibold text-text-primary">
                Available widgets <span className="font-normal text-text-secondary">({available.length})</span>
              </h2>
              {available.length === 0 ? (
                <p className="mt-2 text-xs text-text-secondary">
                  Every widget is already on the canvas. Hide one with its eye icon to make it available here.
                </p>
              ) : (
                <ul className="mt-3 grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
                  {available.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">{WIDGETS[item.id].title}</p>
                        <p className="text-xs text-text-secondary">{WIDGET_DESCRIPTIONS[item.id]}</p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Add ${WIDGETS[item.id].title} to the ${roleLabel(role)} dashboard`}
                        onClick={() => onAdd(item.id)}
                        disabled={saving}
                      >
                        <Plus size={14} aria-hidden="true" />
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label={`${roleLabel(role)} dashboard canvas`}>
              {visible.length === 0 ? (
                <EmptyState
                  icon={LayoutDashboard}
                  title="No widgets on this dashboard"
                  description="Add at least one widget from the list above."
                />
              ) : (
                <OverviewGrid
                  items={visible}
                  editing
                  renderWidget={renderPlaceholder}
                  onMove={onMove}
                  onMoveBy={onMoveBy}
                  onResize={onResize}
                  onHide={onHide}
                />
              )}
            </section>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'reset' ? `Reset the ${roleLabel(role)} dashboard?` : `Copy the ${confirmCopy ? roleLabel(confirmCopy) : ''} layout?`}
        description={
          pending?.kind === 'reset'
            ? 'The saved layout for this role is removed and the built-in default applies again. People who customized their own Overview are not affected.'
            : `This replaces the ${roleLabel(role)} draft with the current ${confirmCopy ? roleLabel(confirmCopy) : ''} draft. Nothing is published until you save.`
        }
        confirmLabel={pending?.kind === 'reset' ? 'Reset layout' : 'Copy layout'}
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          const p = pending;
          setPending(null);
          if (p?.kind === 'reset') await handleReset();
          else if (p?.kind === 'copy') handleCopy(p.from);
        }}
      />
    </DashboardLayout>
  );
}

export default DashboardBuilderPage;
