import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  CalendarClock,
  ExternalLink,
  FileText,
  FlaskConical,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
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
import { HazardChips, ReviewBadge, SignalBadge } from '@/components/safety/SdsUi';
import { SdsEditor } from '@/components/safety/SdsEditor';
import {
  DEFAULT_SDS_FILTERS,
  HAZARD_CLASSES,
  docToForm,
  describeSdsError,
  emptySdsForm,
  fetchSdsList,
  filterSds,
  openSdsFile,
  setSdsArchived,
  summarizeSds,
  type SdsDocument,
  type SdsFilters,
  type SdsHazardClass,
  type SdsStatus,
} from '@/lib/sds';

const iconButtonClass =
  'focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';

const STATUS_TABS: Array<{ key: SdsStatus | 'all'; label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

function StatCard({ label, value, tone = 'text-text-primary' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone}`}>{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: string | null }) {
  if (!children) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</h3>
      <p className="mt-1 whitespace-pre-line text-sm text-text-primary">{children}</p>
    </div>
  );
}

// ============================================================
// Detail dialog — everything a technician needs, big and readable
// ============================================================

function SdsDetailDialog({ doc, onClose, onOpenFile }: { doc: SdsDocument; onClose: () => void; onOpenFile: (d: SdsDocument) => void }) {
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sds-detail-title"
        className="relative flex h-[94dvh] w-full max-w-2xl flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:h-auto sm:max-h-[90vh] sm:rounded-2xl dark:shadow-card-hover-dark"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="sds-detail-title" className="text-lg font-bold text-text-primary">{doc.product_name}</h2>
            <p className="text-xs text-text-secondary">
              {[doc.manufacturer, doc.product_code].filter(Boolean).join(' · ') || 'No manufacturer listed'}
            </p>
          </div>
          <button type="button" onClick={onClose} className={iconButtonClass} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <SignalBadge signal={doc.signal_word} />
            <ReviewBadge doc={doc} />
            {doc.status === 'archived' && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">Archived</span>}
          </div>
          <HazardChips classes={doc.hazard_classes} />
          <Section title="First aid">{doc.first_aid}</Section>
          <Section title="Required PPE">{doc.ppe}</Section>
          <Section title="Hazard statements">{doc.hazard_statements}</Section>
          <Section title="Storage and handling">{doc.storage_notes}</Section>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {doc.cas_numbers.length > 0 && (
              <div className="col-span-2">
                <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary">CAS numbers</dt>
                <dd className="mt-1 text-text-primary">{doc.cas_numbers.join(', ')}</dd>
              </div>
            )}
            {doc.location && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Kept at</dt>
                <dd className="mt-1 text-text-primary">{doc.location}</dd>
              </div>
            )}
            {doc.revision_date && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Revision date</dt>
                <dd className="mt-1 text-text-primary">{doc.revision_date}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button>
          {doc.file_path ? (
            <Button type="button" size="sm" onClick={() => onOpenFile(doc)}>
              <ExternalLink size={16} /> Open full sheet
            </Button>
          ) : (
            <p className="self-center text-xs text-text-secondary">No file attached</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function SdsLibraryPage() {
  const { isOwner, profile, teamMember, permissions } = useAuth();
  const { toast } = useToast();
  const [params] = useSearchParams();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canManage = isOwner || permissions.can_manage_team;

  const [docs, setDocs] = useState<SdsDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<SdsFilters>(() => ({ ...DEFAULT_SDS_FILTERS, query: params.get('q') ?? '' }));
  const [editor, setEditor] = useState<null | { id: string | null; initial: ReturnType<typeof emptySdsForm> }>(null);
  const [detail, setDetail] = useState<SdsDocument | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SdsDocument | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setDocs(await fetchSdsList(accountOwnerId));
    } catch (err) {
      setLoadError(describeSdsError(err, 'Could not load the safety data sheets.'));
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => { void load(); }, [load]);

  const stats = useMemo(() => summarizeSds(docs), [docs]);
  const visible = useMemo(() => filterSds(docs, filters), [docs, filters]);
  const patch = (p: Partial<SdsFilters>) => setFilters((f) => ({ ...f, ...p }));
  const filtersActive = filters.query.trim() !== '' || filters.hazard !== 'all' || filters.attentionOnly;

  const openFile = async (doc: SdsDocument) => {
    if (!doc.file_path) return;
    try {
      await openSdsFile(doc.file_path);
    } catch (err) {
      toast(describeSdsError(err, 'Could not open the file.'), 'error');
    }
  };

  const setArchived = async (doc: SdsDocument, archived: boolean) => {
    if (!accountOwnerId) return;
    setBusyId(doc.id);
    try {
      await setSdsArchived(accountOwnerId, doc.id, archived);
      toast(archived ? 'Sheet archived. It can no longer be attached to new jobs.' : 'Sheet restored.', 'success');
      await load();
    } catch (err) {
      toast(describeSdsError(err, 'Could not update the sheet.'), 'error');
    } finally {
      setBusyId(null);
      setArchiveTarget(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Safety Data Sheets">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><FlaskConical size={22} /></span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Safety Data Sheets</h1>
            <p className="text-sm text-text-secondary">
              Find any product's hazards, first aid and PPE in seconds, and attach it to a job or checklist step.
            </p>
          </div>
        </div>
        {canManage && (
          <Button type="button" size="sm" onClick={() => setEditor({ id: null, initial: emptySdsForm() })} disabled={!accountOwnerId}>
            <Plus size={16} /> Add sheet
          </Button>
        )}
      </div>

      {!loading && !loadError && docs.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Active sheets" value={stats.total} />
          <StatCard label="Signal word: Danger" value={stats.danger} tone={stats.danger > 0 ? 'text-danger' : 'text-text-primary'} />
          <StatCard label="Needs review" value={stats.needsReview} tone={stats.needsReview > 0 ? 'text-warning-500' : 'text-text-primary'} />
          <StatCard label="With a file" value={`${stats.withFile} / ${stats.total}`} tone="text-success" />
        </div>
      )}

      {!loading && !loadError && docs.length > 0 && (
        <div className="mb-5 space-y-3">
          <Input
            type="search"
            icon={Search}
            value={filters.query}
            onChange={(e) => patch({ query: e.target.value })}
            placeholder="Search product, manufacturer, CAS number or location"
            aria-label="Search safety data sheets"
            className="!py-2.5 !text-sm"
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div role="tablist" aria-label="Sheet status" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={filters.status === tab.key}
                  onClick={() => patch({ status: tab.key })}
                  className={`focus-ring whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${filters.status === tab.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Filter by hazard"
                value={filters.hazard}
                onChange={(e) => patch({ hazard: e.target.value as SdsHazardClass | 'all' })}
                className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
              >
                <option value="all">All hazards</option>
                {HAZARD_CLASSES.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
              </select>
              <button
                type="button"
                aria-pressed={filters.attentionOnly}
                onClick={() => patch({ attentionOnly: !filters.attentionOnly })}
                className={`focus-ring inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${filters.attentionOnly ? 'border-warning-500 bg-warning-500/10 text-warning-500' : 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'}`}
              >
                <CalendarClock size={14} aria-hidden="true" /> Needs review
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div role="status" aria-label="Loading safety data sheets"><SkeletonCardList count={4} rows={2} /></div>
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-8 text-center">
          <AlertCircle className="text-danger" />
          <p className="text-sm text-text-primary">{loadError}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void load()}><RefreshCw size={16} /> Try again</Button>
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No safety data sheets yet"
          description={canManage
            ? 'Add the sheets for the refrigerants, solvents and chemicals your crews use, then attach them to jobs so the right one is in every technician’s hands.'
            : 'Your account owner has not added any sheets yet. Ask them to add the products your crew uses.'}
          action={canManage ? { label: 'Add your first sheet', onClick: () => setEditor({ id: null, initial: emptySdsForm() }) } : undefined}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No sheets match"
          description="Try a different product name, a CAS number, or clear the filters."
          action={filtersActive ? { label: 'Clear filters', onClick: () => setFilters({ ...DEFAULT_SDS_FILTERS, status: filters.status }) } : undefined}
        />
      ) : (
        <ul className="space-y-3" aria-label="Safety data sheets">
          {visible.map((d) => {
            const busy = busyId === d.id;
            return (
              <li key={d.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => setDetail(d)} className="focus-ring min-w-0 flex-1 rounded-lg text-left" aria-label={`View ${d.product_name}`}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-base font-semibold text-text-primary">{d.product_name}</span>
                      <SignalBadge signal={d.signal_word} />
                      {d.status === 'archived' && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">Archived</span>}
                    </span>
                    <span className="mt-1 block text-sm text-text-secondary">
                      {[d.manufacturer, d.product_code].filter(Boolean).join(' · ') || 'No manufacturer listed'}
                    </span>
                  </button>
                  <div className="flex items-center">
                    {d.file_path && (
                      <button type="button" className={iconButtonClass} aria-label={`Open file for ${d.product_name}`} title="Open full sheet" onClick={() => void openFile(d)}>
                        <FileText size={18} />
                      </button>
                    )}
                    {canManage && (
                      <>
                        <button
                          type="button"
                          className={iconButtonClass}
                          aria-label={`Edit ${d.product_name}`}
                          title="Edit"
                          disabled={busy}
                          onClick={() => setEditor({ id: d.id, initial: docToForm(d) })}
                        >
                          <Pencil size={18} />
                        </button>
                        {d.status === 'archived' ? (
                          <button type="button" className={iconButtonClass} aria-label={`Restore ${d.product_name}`} title="Restore" disabled={busy} onClick={() => void setArchived(d, false)}>
                            <ArchiveRestore size={18} />
                          </button>
                        ) : (
                          <button type="button" className={iconButtonClass} aria-label={`Archive ${d.product_name}`} title="Archive" disabled={busy} onClick={() => setArchiveTarget(d)}>
                            <Archive size={18} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  <HazardChips classes={d.hazard_classes} />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-secondary">
                    <ReviewBadge doc={d} />
                    {d.cas_numbers.length > 0 && <span>CAS {d.cas_numbers.join(', ')}</span>}
                    {d.location && <span className="inline-flex items-center gap-1"><MapPin size={12} aria-hidden="true" /> {d.location}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {detail && <SdsDetailDialog doc={detail} onClose={() => setDetail(null)} onOpenFile={(d) => void openFile(d)} />}
      {editor && accountOwnerId && (
        <SdsEditor
          accountOwnerId={accountOwnerId}
          sdsId={editor.id}
          initial={editor.initial}
          onClose={() => setEditor(null)}
          onSaved={(_doc, message) => { toast(message, 'success'); setEditor(null); void load(); }}
        />
      )}
      <ConfirmDialog
        open={archiveTarget !== null}
        title="Archive this sheet?"
        description={`"${archiveTarget?.product_name ?? ''}" stays on the jobs it is already attached to, but it can't be attached to new ones. You can restore it any time.`}
        confirmLabel="Archive"
        onConfirm={() => (archiveTarget ? setArchived(archiveTarget, true) : undefined)}
        onCancel={() => setArchiveTarget(null)}
      />
    </DashboardLayout>
  );
}
