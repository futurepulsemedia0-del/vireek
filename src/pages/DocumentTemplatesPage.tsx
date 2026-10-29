/**
 * Document Templates — /dashboard/document-templates
 *
 * Design how quotes, invoices and reports look as PDFs: brand colors, fonts, header, table, totals,
 * section order, terms and footer — with a live preview and a real sample-PDF download.
 * Rules and security live in the database (supabase/migrations/20280101000000_document_templates.sql);
 * pure logic in lib/documentTemplates.ts; PDF output in lib/documentTemplatePdf.ts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Copy, Download, FileText, Loader2, Lock, Plus, RefreshCw, Save, Search, Star } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DesignerPanel } from '@/components/documentTemplates/DesignerPanel';
import { DocumentPreview } from '@/components/documentTemplates/DocumentPreview';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { fetchBrandSettings, logoPublicUrl } from '@/lib/branding';
import {
  DEFAULT_FILTERS,
  DOC_TYPES,
  DOC_TYPE_LABELS,
  PRESETS,
  applyPreset,
  buildSampleData,
  draftsEqual,
  filterTemplates,
  summarizeTemplates,
  uniqueCopyName,
  unsupportedFields,
  validateName,
  type DocType,
  type DocumentDesign,
  type DocumentTemplate,
  type PresetId,
  type TemplateFilters,
} from '@/lib/documentTemplates';
import {
  TemplateConflictError,
  createDocumentTemplate,
  describeDocumentTemplateError,
  fetchDocumentTemplates,
  setDocumentTemplateDefault,
  setDocumentTemplateStatus,
  updateDocumentTemplate,
} from '@/lib/documentTemplatesApi';
import { downloadTemplatePdf, loadLogoDataUrl } from '@/lib/documentTemplatePdf';

const SELECT_CLASS =
  'focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary transition-colors focus-visible:border-accent';

const fmtUpdated = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

function TypeBadge({ type }: { type: DocType }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2.5 py-0.5 text-xs font-medium text-text-secondary">
      {DOC_TYPE_LABELS[type]}
    </span>
  );
}

function DefaultBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-semibold text-accent">
      <Star size={12} aria-hidden="true" /> Default
    </span>
  );
}

// ============================================================
// Editor
// ============================================================

interface EditorProps {
  template: DocumentTemplate;
  accountOwnerId: string;
  canEdit: boolean;
  businessName: string;
  businessLines: string[];
  logoUrl: string | null;
  allNames: string[];
  onBack: () => void;
  onSaved: (t: DocumentTemplate) => void;
  onReload: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}

function TemplateEditor({
  template,
  accountOwnerId,
  canEdit,
  businessName,
  businessLines,
  logoUrl,
  allNames,
  onBack,
  onSaved,
  onReload,
  onDirtyChange,
}: EditorProps) {
  const { toast } = useToast();
  const [name, setName] = useState(template.name);
  const [design, setDesign] = useState<DocumentDesign>(template.design);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [mobileTab, setMobileTab] = useState<'edit' | 'preview'>('edit');
  const [touched, setTouched] = useState(false);

  const nameError = touched ? validateName(name) : null;
  const dirty = !draftsEqual({ name, design }, { name: template.name, design: template.design }, template.doc_type);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const sample = useMemo(
    () => buildSampleData(template.doc_type, { name: businessName, lines: businessLines, logoDataUrl: logoUrl }),
    [template.doc_type, businessName, businessLines, logoUrl],
  );
  const warnings = useMemo(() => unsupportedFields(design, name), [design, name]);
  const duplicateName = allNames.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase());

  const save = useCallback(async () => {
    if (!canEdit || saving || !dirty) return;
    setTouched(true);
    const err = validateName(name);
    if (err) {
      toast(err, 'error');
      return;
    }
    setSaving(true);
    try {
      const saved = await updateDocumentTemplate(template.id, accountOwnerId, template.updated_at, template.doc_type, { name, design });
      setConflict(false);
      onSaved(saved);
      toast('Template saved', 'success');
    } catch (e) {
      if (e instanceof TemplateConflictError) setConflict(true);
      toast(describeDocumentTemplateError(e), 'error');
    } finally {
      setSaving(false);
    }
  }, [canEdit, saving, dirty, name, design, template, accountOwnerId, onSaved, toast]);

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const downloadSample = async () => {
    setDownloading(true);
    try {
      const logo = design.header.showLogo ? await loadLogoDataUrl(logoUrl) : null;
      await downloadTemplatePdf(design, { ...sample, business: { ...sample.business, logoDataUrl: logo } }, `sample-${template.doc_type}.pdf`);
    } catch {
      toast('Could not generate the sample PDF.', 'error');
    } finally {
      setDownloading(false);
    }
  };

  const reset = () => {
    setName(template.name);
    setDesign(template.design);
    setTouched(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to all templates">
          <ArrowLeft size={16} aria-hidden="true" /> All templates
        </Button>
        <TypeBadge type={template.doc_type} />
        {template.is_default && <DefaultBadge />}
        {template.status === 'archived' && <span className="text-xs font-medium text-text-secondary">Archived</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={downloadSample} disabled={downloading}>
            {downloading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
            Download sample PDF
          </Button>
          {canEdit && dirty && (
            <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>
              Discard changes
            </Button>
          )}
          {canEdit && (
            <Button size="sm" onClick={save} disabled={saving || !dirty || template.status === 'archived'}>
              {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </Button>
          )}
        </div>
      </div>

      {!canEdit && (
        <p role="status" className="rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-secondary">
          You can view this template. Ask an owner or someone who can edit the business profile to change it.
        </p>
      )}
      {template.status === 'archived' && (
        <p role="status" className="rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-secondary">
          This template is archived and read-only. Restore it from the list to edit it.
        </p>
      )}
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-text-primary">
          <span>Someone else changed this template. Reload to get the latest version (your unsaved edits will be replaced).</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              await onReload();
              setConflict(false);
            }}
          >
            <RefreshCw size={14} aria-hidden="true" /> Reload
          </Button>
        </div>
      )}
      {warnings.length > 0 && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            PDF fonts only support Latin characters. Other characters in {warnings.join(', ')} will print as “?”.
          </span>
        </p>
      )}

      <Input
        label="Template name"
        value={name}
        maxLength={80}
        disabled={!canEdit || template.status === 'archived'}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => setTouched(true)}
        error={nameError ?? undefined}
        helperText={duplicateName && name.trim().toLowerCase() !== template.name.trim().toLowerCase() ? 'Another template already uses this name — saving may fail.' : undefined}
      />

      {/* Mobile: switch between settings and preview. Desktop: side by side. */}
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-bg-secondary p-1 lg:hidden" role="tablist" aria-label="Editor view">
        {(['edit', 'preview'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={mobileTab === tab}
            onClick={() => setMobileTab(tab)}
            className={`focus-ring min-h-[44px] rounded-lg text-sm font-semibold transition-colors ${
              mobileTab === tab ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary'
            }`}
          >
            {tab === 'edit' ? 'Settings' : 'Preview'}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className={mobileTab === 'edit' ? 'block' : 'hidden lg:block'}>
          <DesignerPanel
            docType={template.doc_type}
            design={design}
            onChange={setDesign}
            readOnly={!canEdit || template.status === 'archived'}
          />
        </div>
        <div className={`${mobileTab === 'preview' ? 'block' : 'hidden lg:block'} lg:sticky lg:top-4 lg:self-start`}>
          <DocumentPreview design={design} data={sample} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function DocumentTemplatesPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();

  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canEdit = isOwner || permissions.can_edit_business_profile;
  const canView = canEdit || permissions.can_view_billing;
  const selectedId = params.get('template');

  const [templates, setTemplates] = useState<DocumentTemplate[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filters, setFilters] = useState<TemplateFilters>(DEFAULT_FILTERS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [brandName, setBrandName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<null | (() => void)>(null);

  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<DocType>('quote');
  const [newPreset, setNewPreset] = useState<PresetId>('classic');
  const [newName, setNewName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoadError(false);
    try {
      setTemplates(await fetchDocumentTemplates(accountOwnerId));
    } catch {
      setLoadError(true);
      setTemplates((prev) => prev ?? []);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  // Logo is best-effort: a failure just means the preview shows no logo.
  useEffect(() => {
    if (!accountOwnerId || !canView) return;
    let cancelled = false;
    fetchBrandSettings(accountOwnerId)
      .then((row) => {
        if (!cancelled) setLogoUrl(logoPublicUrl(row?.logo_path ?? null));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accountOwnerId, canView]);

  useEffect(() => {
    setBrandName((profile?.company_name ?? '').trim());
  }, [profile?.company_name]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const businessLines = useMemo(
    () => [profile?.phone, profile?.email].filter((v): v is string => typeof v === 'string' && v.trim().length > 0),
    [profile?.phone, profile?.email],
  );

  const selected = useMemo(() => (templates ?? []).find((t) => t.id === selectedId) ?? null, [templates, selectedId]);
  const visible = useMemo(() => filterTemplates(templates ?? [], filters), [templates, filters]);
  const summary = useMemo(() => summarizeTemplates(templates ?? []), [templates]);

  const replaceTemplate = useCallback((t: DocumentTemplate) => {
    setTemplates((prev) => {
      const list = prev ?? [];
      const next = list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list];
      // A default swap changes other rows of the same type; keep local state consistent.
      return t.is_default ? next.map((x) => (x.id !== t.id && x.doc_type === t.doc_type ? { ...x, is_default: false } : x)) : next;
    });
  }, []);

  const guardLeave = (action: () => void) => (dirty ? setPendingLeave(() => action) : action());
  const openTemplate = (id: string) => setParams({ template: id });
  const closeEditor = () => setParams({});

  const startCreate = () => {
    setCreating(true);
    setNewName('');
  };

  const create = async () => {
    if (!accountOwnerId) return;
    const typeLabel = DOC_TYPE_LABELS[newType];
    const presetLabel = PRESETS.find((p) => p.id === newPreset)?.label ?? 'Classic';
    const taken = (templates ?? []).filter((t) => t.status === 'active' && t.doc_type === newType).map((t) => t.name);
    const fallbackName = `${typeLabel} — ${presetLabel}`;
    const name = newName.trim() || (taken.some((n) => n.trim().toLowerCase() === fallbackName.toLowerCase()) ? uniqueCopyName(fallbackName, taken) : fallbackName);
    const err = validateName(name);
    if (err) {
      toast(err, 'error');
      return;
    }
    setCreateBusy(true);
    try {
      const created = await createDocumentTemplate(accountOwnerId, { name, docType: newType, design: applyPreset(newType, newPreset) });
      replaceTemplate(created);
      setCreating(false);
      toast(`"${created.name}" created`, 'success');
      openTemplate(created.id);
    } catch (e) {
      toast(describeDocumentTemplateError(e), 'error');
    } finally {
      setCreateBusy(false);
    }
  };

  const runOn = async (t: DocumentTemplate, action: () => Promise<DocumentTemplate | void>, ok: string) => {
    setBusyId(t.id);
    try {
      const result = await action();
      if (result) replaceTemplate(result);
      toast(ok, 'success');
    } catch (e) {
      toast(describeDocumentTemplateError(e), 'error');
      if (e instanceof TemplateConflictError) void load();
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = (t: DocumentTemplate) =>
    runOn(
      t,
      async () => {
        if (!accountOwnerId) return;
        const names = (templates ?? []).filter((x) => x.status === 'active' && x.doc_type === t.doc_type).map((x) => x.name);
        return createDocumentTemplate(accountOwnerId, { name: uniqueCopyName(t.name, names), docType: t.doc_type, design: t.design });
      },
      'Template duplicated',
    );
  const toggleDefault = (t: DocumentTemplate) =>
    runOn(t, () => setDocumentTemplateDefault(t.id, !t.is_default), t.is_default ? 'Default removed' : `Now the default ${DOC_TYPE_LABELS[t.doc_type].toLowerCase()} template`);
  const toggleArchive = (t: DocumentTemplate) =>
    runOn(
      t,
      () => (accountOwnerId ? setDocumentTemplateStatus(t.id, accountOwnerId, t.updated_at, t.status === 'active' ? 'archived' : 'active') : Promise.resolve()),
      t.status === 'active' ? 'Template archived' : 'Template restored',
    );

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------
  const shell = (children: React.ReactNode) => (
    <DashboardLayout activeLabel="Document Templates">
      <div className="mx-auto max-w-7xl space-y-5">{children}</div>
    </DashboardLayout>
  );

  if (!canView) {
    return shell(
      <EmptyState
        icon={Lock}
        title="Document templates are restricted"
        description="Ask an account owner for access to billing or business profile settings."
      />,
    );
  }

  if (templates === null) {
    return shell(
      <>
        <div className="h-8 w-64 animate-pulse rounded-lg bg-bg-tertiary" aria-hidden="true" />
        <SkeletonCardList count={3} rows={2} />
      </>,
    );
  }

  if (selectedId) {
    if (!selected) {
      return shell(
        loadError ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load this template" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void load() }} />
        ) : (
          <EmptyState
            icon={FileText}
            title="Template unavailable"
            description="It may have been removed, or the link is out of date."
            action={{ label: 'Back to templates', onClick: closeEditor }}
          />
        ),
      );
    }
    return shell(
      <>
        <TemplateEditor
          key={`${selected.id}:${selected.updated_at}`}
          template={selected}
          accountOwnerId={accountOwnerId ?? ''}
          canEdit={canEdit}
          businessName={brandName || 'Your Business Name'}
          businessLines={businessLines}
          logoUrl={logoUrl}
          allNames={(templates ?? []).filter((t) => t.id !== selected.id && t.status === 'active' && t.doc_type === selected.doc_type).map((t) => t.name)}
          onBack={() => guardLeave(closeEditor)}
          onSaved={replaceTemplate}
          onReload={load}
          onDirtyChange={setDirty}
        />
        <ConfirmDialog
          open={pendingLeave !== null}
          title="Discard unsaved changes?"
          description="You have edits that haven't been saved. If you leave now they will be lost."
          confirmLabel="Discard and leave"
          onConfirm={() => {
            const go = pendingLeave;
            setPendingLeave(null);
            setDirty(false);
            go?.();
          }}
          onCancel={() => setPendingLeave(null)}
        />
      </>,
    );
  }

  const nothingYet = templates.length === 0;

  return shell(
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Document templates</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Design how your quotes, invoices and reports look as PDFs. Set one default per type — invoice PDFs already use your default invoice template; quote and report defaults are saved for when those exports use templates.
          </p>
        </div>
        {canEdit && (
          <Button onClick={startCreate} aria-expanded={creating}>
            <Plus size={16} aria-hidden="true" /> New template
          </Button>
        )}
      </div>

      {loadError && !nothingYet && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-text-primary">
          <span>We couldn't refresh your templates.</span>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </Button>
        </div>
      )}

      {creating && canEdit && (
        <section aria-label="Create a template" className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="dt-new-type" className="mb-1.5 block text-sm font-medium text-text-primary">
                Document type
              </label>
              <select id="dt-new-type" value={newType} onChange={(e) => setNewType(e.target.value as DocType)} className={SELECT_CLASS}>
                {DOC_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {DOC_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="dt-new-preset" className="mb-1.5 block text-sm font-medium text-text-primary">
                Starting style
              </label>
              <select id="dt-new-preset" value={newPreset} onChange={(e) => setNewPreset(e.target.value as PresetId)} className={SELECT_CLASS}>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} — {p.description}
                  </option>
                ))}
              </select>
            </div>
            <Input label="Name (optional)" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} placeholder={`${DOC_TYPE_LABELS[newType]} — ${PRESETS.find((p) => p.id === newPreset)?.label}`} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={create} disabled={createBusy}>
              {createBusy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
              {createBusy ? 'Creating…' : 'Create and design'}
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={createBusy}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      {nothingYet && loadError ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load your templates"
          description="Check your connection and try again."
          action={{ label: 'Try again', onClick: () => void load() }}
        />
      ) : nothingYet ? (
        <EmptyState
          icon={FileText}
          title="No templates yet"
          description={canEdit ? 'Create your first template to give quotes, invoices and reports your own look.' : 'An owner or editor can create templates for your account.'}
          action={canEdit ? { label: 'Create a template', onClick: startCreate } : undefined}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {DOC_TYPES.map((t) => (
              <div key={t} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="text-xs font-medium text-text-secondary">{DOC_TYPE_LABELS[t]} templates</p>
                <p className="mt-1 text-2xl font-bold text-text-primary">{summary.byType[t]}</p>
                <p className="mt-1 truncate text-xs text-text-secondary">
                  {summary.defaults[t] ? `Default: ${(templates ?? []).find((x) => x.id === summary.defaults[t])?.name ?? '—'}` : 'No default set'}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[200px] flex-1">
              <Input
                icon={Search}
                aria-label="Search templates"
                placeholder="Search templates"
                value={filters.query}
                onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
              />
            </div>
            <div role="group" aria-label="Filter by type" className="flex flex-wrap gap-1">
              {(['all', ...DOC_TYPES] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={filters.type === t}
                  onClick={() => setFilters((f) => ({ ...f, type: t }))}
                  className={`focus-ring min-h-[44px] rounded-xl border px-3 text-sm font-medium transition-colors ${
                    filters.type === t ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t === 'all' ? 'All' : DOC_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
            {summary.archived > 0 && (
              <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={filters.showArchived}
                  onChange={(e) => setFilters((f) => ({ ...f, showArchived: e.target.checked }))}
                  className="focus-ring h-5 w-5"
                />
                Show archived ({summary.archived})
              </label>
            )}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={Search}
              title="Nothing matches"
              description="Try a different search or filter."
              action={{ label: 'Clear filters', onClick: () => setFilters(DEFAULT_FILTERS) }}
            />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Templates">
              {visible.map((t) => {
                const busy = busyId === t.id;
                const archived = t.status === 'archived';
                return (
                  <li key={t.id} className={`flex flex-col rounded-2xl border border-border bg-bg-secondary p-4 ${archived ? 'opacity-70' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <TypeBadge type={t.doc_type} />
                      {t.is_default && <DefaultBadge />}
                      {archived && <span className="text-xs font-medium text-text-secondary">Archived</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => openTemplate(t.id)}
                      className="focus-ring mt-3 rounded-lg text-left"
                      aria-label={`Open ${t.name}`}
                    >
                      <span className="block break-words text-base font-semibold text-text-primary">{t.name}</span>
                    </button>
                    <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
                      <span
                        aria-hidden="true"
                        className="inline-block h-3 w-3 rounded-full border border-border"
                        style={{ background: t.design.theme.primary }}
                      />
                      <span>Updated {fmtUpdated(t.updated_at)}</span>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => openTemplate(t.id)}>
                        {canEdit && !archived ? 'Edit' : 'View'}
                      </Button>
                      {canEdit && !archived && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => toggleDefault(t)} aria-label={t.is_default ? `Remove default from ${t.name}` : `Make ${t.name} the default`}>
                          <Star size={14} aria-hidden="true" /> {t.is_default ? 'Unset default' : 'Make default'}
                        </Button>
                      )}
                      {canEdit && !archived && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => duplicate(t)} aria-label={`Duplicate ${t.name}`}>
                          <Copy size={14} aria-hidden="true" /> Duplicate
                        </Button>
                      )}
                      {canEdit && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => toggleArchive(t)} aria-label={`${archived ? 'Restore' : 'Archive'} ${t.name}`}>
                          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
                          {archived ? 'Restore' : 'Archive'}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>,
  );
}
