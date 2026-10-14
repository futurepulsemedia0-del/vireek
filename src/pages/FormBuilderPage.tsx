import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Camera,
  ClipboardList,
  Copy,
  GitBranch,
  ListChecks,
  Lock,
  Pencil,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { FormBuilderEditor } from '@/components/forms/FormBuilderEditor';
import type { EditorSeed } from '@/components/forms/FormBuilderEditor';
import {
  TRADES,
  deleteTemplate,
  describeFormError,
  emptyBuilderState,
  fetchManagedTemplates,
  featureFlags,
  filterManaged,
  fromTemplate,
  setTemplateActive,
} from '@/lib/formBuilder';
import type { ManagedFilter, ManagedTemplate } from '@/lib/formBuilder';

const iconButton =
  'focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';

function tradeLabel(trade: string | null): string | null {
  if (!trade) return null;
  return TRADES.find((t) => t.value === trade)?.label ?? trade;
}

function TemplateCard({
  template,
  busy,
  onEdit,
  onDuplicate,
  onToggleActive,
  onDelete,
}: {
  template: ManagedTemplate;
  busy: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const flags = featureFlags(template.fields);
  const badge = template.isSystem ? 'Default' : template.overridesDefault ? 'Customized default' : 'Custom';
  const trade = tradeLabel(template.trade);

  return (
    <article className={`flex flex-col rounded-2xl border border-border bg-bg-secondary p-4 ${template.active ? '' : 'opacity-70'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-text-primary">{template.title}</h3>
          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {[trade, `v${template.version}`, !template.active ? 'Archived' : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <span className="shrink-0 rounded-lg bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">{badge}</span>
      </div>

      {template.description && <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{template.description}</p>}

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-text-secondary">
        <li className="flex items-center gap-1.5">
          <ListChecks size={13} /> {template.fields.length} fields
        </li>
        {flags.photos && (
          <li className="flex items-center gap-1.5">
            <Camera size={13} /> Photos
          </li>
        )}
        {flags.signatures && (
          <li className="flex items-center gap-1.5">
            <PenLine size={13} /> Signature
          </li>
        )}
        {flags.logic && (
          <li className="flex items-center gap-1.5">
            <GitBranch size={13} /> Conditional
          </li>
        )}
      </ul>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
        <Button type="button" variant="secondary" size="sm" onClick={onEdit} disabled={busy}>
          <Pencil size={14} /> {template.isSystem ? 'Customize' : 'Edit'}
        </Button>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onDuplicate} disabled={busy} className={iconButton} aria-label={`Duplicate ${template.title}`}>
            <Copy size={16} />
          </button>
          {!template.isSystem && (
            <>
              <button
                type="button"
                onClick={onToggleActive}
                disabled={busy}
                className={iconButton}
                aria-label={template.active ? `Archive ${template.title}` : `Restore ${template.title}`}
              >
                {template.active ? <Archive size={16} /> : <ArchiveRestore size={16} />}
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className={`${iconButton} hover:text-danger`}
                aria-label={template.overridesDefault ? `Revert ${template.title} to the default` : `Delete ${template.title}`}
              >
                {template.overridesDefault ? <Undo2 size={16} /> : <Trash2 size={16} />}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

export function FormBuilderPage() {
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canManage = isOwner || permissions.can_edit_business_profile;
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [templates, setTemplates] = useState<ManagedTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ManagedFilter>('all');
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorSeed | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ManagedTemplate | null>(null);

  // Only the most recently started load may write state.
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    const id = ++loadIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await fetchManagedTemplates(accountOwnerId);
      if (id !== loadIdRef.current) return;
      setTemplates(rows);
    } catch (err) {
      if (id !== loadIdRef.current) return;
      setLoadError(describeFormError(err, 'Could not load your forms.'));
    } finally {
      if (id === loadIdRef.current) setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (user && canManage) void load();
  }, [user, canManage, load]);

  const visible = useMemo(() => filterManaged(templates, search, filter), [templates, search, filter]);
  const takenSlugs = useMemo(() => new Set(templates.map((t) => t.slug)), [templates]);
  const counts = useMemo(
    () => ({
      all: templates.length,
      custom: templates.filter((t) => !t.isSystem && t.active).length,
      default: templates.filter((t) => t.isSystem).length,
      archived: templates.filter((t) => !t.isSystem && !t.active).length,
    }),
    [templates]
  );

  const openNew = () => setEditor({ slug: null, mode: 'new', liveVersion: 0, state: emptyBuilderState() });

  const openEdit = (t: ManagedTemplate) =>
    setEditor({
      slug: t.slug,
      mode: t.isSystem ? 'customize' : 'edit',
      liveVersion: t.isSystem ? 0 : t.version,
      state: fromTemplate(t),
    });

  const openDuplicate = (t: ManagedTemplate) =>
    setEditor({
      slug: null,
      mode: 'new',
      liveVersion: 0,
      state: { ...fromTemplate(t), title: `Copy of ${t.title}`.slice(0, 120) },
    });

  const handleToggleActive = async (t: ManagedTemplate) => {
    if (busySlug) return;
    setBusySlug(t.slug);
    try {
      await setTemplateActive(t.slug, !t.active);
      toast(
        t.active
          ? t.overridesDefault
            ? 'Archived. Technicians see the default version again.'
            : 'Form archived. Technicians no longer see it.'
          : 'Form restored.',
        'success'
      );
      await load();
    } catch (err) {
      toast(describeFormError(err, 'Could not update the form.'), 'error');
    } finally {
      setBusySlug(null);
    }
  };

  const handleConfirmDelete = async () => {
    const target = pendingDelete;
    if (!target) return;
    setBusySlug(target.slug);
    try {
      await deleteTemplate(target.slug);
      toast(target.overridesDefault ? 'Reverted to the default form.' : 'Form deleted.', 'success');
      setPendingDelete(null);
      await load();
    } catch (err) {
      toast(describeFormError(err, 'Could not delete the form.'), 'error');
      setPendingDelete(null);
    } finally {
      setBusySlug(null);
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Form Builder">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Building inspection forms changes what every technician sees in the field. Ask your account owner to grant you the "Edit Business Profile" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  if (editor && accountOwnerId) {
    return (
      <DashboardLayout activeLabel="Form Builder">
        <FormBuilderEditor
          key={editor.slug ?? 'new'}
          seed={editor}
          takenSlugs={takenSlugs}
          onExit={() => {
            setEditor(null);
            void load();
          }}
          onPublished={() => void load()}
        />
      </DashboardLayout>
    );
  }

  const tabs: Array<{ key: ManagedFilter; label: string }> = [
    { key: 'all', label: `All (${counts.all})` },
    { key: 'custom', label: `Yours (${counts.custom})` },
    { key: 'default', label: `Defaults (${counts.default})` },
    { key: 'archived', label: `Archived (${counts.archived})` },
  ];

  return (
    <DashboardLayout activeLabel="Form Builder">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ClipboardList size={22} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Form Builder</h1>
            <p className="text-sm text-text-secondary">
              Build inspection forms with photos, signatures, pass/fail checks and conditional questions. Technicians fill them in offline.
            </p>
          </div>
        </div>
        <Button type="button" size="sm" onClick={openNew} disabled={!accountOwnerId}>
          <Plus size={16} /> New form
        </Button>
      </div>

      {!loading && !loadError && templates.length > 0 && (
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="sm:w-80">
            <Input
              type="search"
              icon={Search}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search forms"
              aria-label="Search forms"
              className="!py-2.5 !text-sm"
            />
          </div>
          <div role="tablist" aria-label="Form filter" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={filter === tab.key}
                onClick={() => setFilter(tab.key)}
                className={`focus-ring whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === tab.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <SkeletonCardList count={6} rows={3} />
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-border bg-bg-secondary px-6 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
            <AlertCircle size={24} />
          </span>
          <h3 className="mt-3 text-base font-semibold text-text-primary">Couldn't load your forms</h3>
          <p className="mt-1 max-w-sm text-sm text-text-secondary">{loadError}</p>
          <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
            <RefreshCw size={15} /> Try again
          </Button>
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No forms yet"
          description="Create your first inspection form. Technicians get it on their phone, and it works with no signal."
          action={{ label: 'Create a form', onClick: openNew }}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No forms match"
          description={search.trim() ? 'Try a different search term or filter.' : 'Nothing in this filter yet.'}
          secondaryAction={{
            label: 'Clear filters',
            onClick: () => {
              setSearch('');
              setFilter('all');
            },
          }}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => (
            <TemplateCard
              key={t.slug}
              template={t}
              busy={busySlug === t.slug}
              onEdit={() => openEdit(t)}
              onDuplicate={() => openDuplicate(t)}
              onToggleActive={() => void handleToggleActive(t)}
              onDelete={() => setPendingDelete(t)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.overridesDefault ? 'Revert to the default form?' : 'Delete this form?'}
        description={
          pendingDelete?.overridesDefault
            ? `Your customized "${pendingDelete?.title ?? ''}" and its version history will be removed. Technicians go back to the built-in default.`
            : `"${pendingDelete?.title ?? ''}" and its version history will be removed. Forms technicians already submitted are kept.`
        }
        confirmLabel={pendingDelete?.overridesDefault ? 'Yes, revert' : 'Yes, delete form'}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardLayout>
  );
}
