import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  FolderLock,
  Plus,
  Search,
  Paperclip,
  History,
  RefreshCw,
  TriangleAlert,
  Lock,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { DocumentFormModal, type CustomerOption } from '@/components/documents/DocumentFormModal';
import { DocumentDetailPanel } from '@/components/documents/DocumentDetailPanel';
import { useDocumentsScope } from '@/hooks/useDocumentsScope';
import { supabase } from '@/lib/supabase';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  EXPIRY_STATE_LABELS,
  EXPIRY_STATE_STYLES,
  describeExpiry,
  expirySortKey,
  filterDocuments,
  formatFileSize,
  getExpiryState,
  summarizeDocuments,
  type DocumentCategory,
  type DocumentRecord,
  type ExpiryState,
} from '@/lib/documents';
import { checkMyDocumentExpiries, deleteDocument, fetchDocuments } from '@/lib/documentsApi';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type StateFilter = ExpiryState | 'all';

const STAT_CARDS: { key: StateFilter; label: string; tone: string }[] = [
  { key: 'all', label: 'All documents', tone: 'text-text-primary' },
  { key: 'expired', label: 'Expired', tone: 'text-danger' },
  { key: 'expiring', label: 'Expiring soon', tone: 'text-warning-500' },
  { key: 'valid', label: 'Valid', tone: 'text-success-500' },
];

export function DocumentsPage() {
  const { toast } = useToast();
  const { accountOwnerId, canManage, ready } = useDocumentsScope();
  const [searchParams, setSearchParams] = useSearchParams();

  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [category, setCategory] = useState<DocumentCategory | 'all'>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [customerId, setCustomerId] = useState<string>(searchParams.get('customer') ?? 'all');
  const [query, setQuery] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('doc'));
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState<DocumentRecord | null>(null);
  const alertsChecked = useRef(false);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    setLoadError(false);
    try {
      const [docRows, customerRes] = await Promise.all([
        fetchDocuments(accountOwnerId),
        supabase
          .from('customers')
          .select('id, name')
          .eq('user_id', accountOwnerId)
          .order('name')
          .limit(1000),
      ]);
      setDocs(docRows);
      setCustomers((customerRes.data as CustomerOption[]) ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void load();
  }, [ready, load]);

  // Fire due expiry notifications once per visit (idempotent in the database).
  useEffect(() => {
    if (!ready || loading || loadError || alertsChecked.current) return;
    alertsChecked.current = true;
    void checkMyDocumentExpiries().catch(() => undefined);
  }, [ready, loading, loadError]);

  const now = useMemo(() => new Date(), [docs]); // eslint-disable-line react-hooks/exhaustive-deps
  const summary = useMemo(() => summarizeDocuments(docs, now), [docs, now]);

  const visible = useMemo(
    () =>
      filterDocuments(docs, { category, state: stateFilter, customerId, query }, now).sort(
        (a, b) => expirySortKey(a, now) - expirySortKey(b, now) || a.title.localeCompare(b.title),
      ),
    [docs, category, stateFilter, customerId, query, now],
  );

  const selected = useMemo(() => docs.find((d) => d.id === selectedId) ?? null, [docs, selectedId]);

  const select = (id: string | null) => {
    setSelectedId(id);
    const next = new URLSearchParams(searchParams);
    if (id) next.set('doc', id);
    else next.delete('doc');
    setSearchParams(next, { replace: true });
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const handleSaved = async (created: DocumentRecord | null) => {
    setFormOpen(false);
    setEditing(null);
    await load();
    if (created) select(created.id);
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteDocument(deleting.id);
      toast('Document deleted', 'success');
      setDocs((prev) => prev.filter((d) => d.id !== deleting.id));
      if (selectedId === deleting.id) select(null);
    } catch {
      toast('Could not delete this document. You may not have permission.', 'error');
    } finally {
      setDeleting(null);
    }
  };

  const hasActiveFilters =
    category !== 'all' || stateFilter !== 'all' || customerId !== 'all' || query.trim() !== '';
  const clearFilters = () => {
    setCategory('all');
    setStateFilter('all');
    setCustomerId('all');
    setQuery('');
  };

  // ---- Account not resolved (profile still loading, or no account) --------
  if (!ready) {
    return (
      <DashboardLayout activeLabel="Documents">
        <div className="space-y-4" aria-busy="true">
          <div className="h-10 w-64 animate-pulse rounded-xl bg-bg-tertiary" />
          <div className="h-28 animate-pulse rounded-2xl bg-bg-tertiary" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Documents">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <FolderLock size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Documents</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Licenses, insurance, contracts and permits — with expiry alerts, version history and
              secure sharing links.
            </p>
          </div>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={openCreate}
            className="focus-ring flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            <Plus size={16} /> Add document
          </button>
        ) : (
          <p className="flex items-center gap-1.5 rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
            <Lock size={13} /> View only — ask the account owner for the “Edit Business Profile”
            permission to add or change documents.
          </p>
        )}
      </div>

      {loading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading documents">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
          ))}
        </div>
      ) : loadError ? (
        <div
          role="alert"
          className="rounded-2xl border border-border bg-bg-secondary px-6 py-12 text-center"
        >
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
            <TriangleAlert size={22} />
          </span>
          <h3 className="mt-3 text-base font-semibold text-text-primary">
            Couldn’t load your documents
          </h3>
          <p className="mt-1 text-sm text-text-secondary">Check your connection and try again.</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            className="focus-ring mt-4 inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary"
          >
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          icon={FolderLock}
          title="No documents yet"
          description="Keep your contractor license, insurance certificates, contracts and permits in one place — and get alerted before anything expires."
          action={canManage ? { label: 'Add your first document', onClick: openCreate } : undefined}
        />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {STAT_CARDS.map((s) => {
              const count = s.key === 'all' ? summary.total : summary[s.key];
              const active = stateFilter === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setStateFilter(active && s.key !== 'all' ? 'all' : s.key)}
                  aria-pressed={active}
                  className={`focus-ring rounded-2xl border p-4 text-left transition-colors ${
                    active
                      ? 'border-accent bg-accent/5'
                      : 'border-border bg-bg-secondary hover:border-accent/40'
                  }`}
                >
                  <p className={`text-2xl font-bold ${s.tone}`}>{count}</p>
                  <p className="text-xs text-text-secondary">{s.label}</p>
                </button>
              );
            })}
          </div>

          <div className="mb-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
              <div className="relative">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search title, number, issuer, customer…"
                  aria-label="Search documents"
                  className={`${inputClass} pl-9`}
                />
              </div>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                aria-label="Filter by customer"
                className={inputClass}
              >
                <option value="all">All customers</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div
              className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
              role="group"
              aria-label="Filter by category"
            >
              {(['all', ...DOCUMENT_CATEGORIES] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  aria-pressed={category === c}
                  className={`focus-ring shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    category === c
                      ? 'bg-accent text-white'
                      : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {c === 'all' ? 'All' : DOCUMENT_CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-12 text-center">
              <p className="text-sm text-text-secondary">No documents match these filters.</p>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="focus-ring mt-3 rounded-lg px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <ul className="space-y-3">
              {visible.map((d) => {
                const state = getExpiryState(d.expires_on, d.alert_days, now);
                return (
                  <motion.li
                    key={d.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <button
                      type="button"
                      onClick={() => select(d.id)}
                      className="focus-ring w-full rounded-2xl border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent/40"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="break-words text-sm font-semibold text-text-primary">
                              {d.title}
                            </p>
                            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                              {DOCUMENT_CATEGORY_LABELS[d.category]}
                            </span>
                          </div>
                          <p className="mt-1 break-words text-xs text-text-secondary">
                            {[
                              d.reference_number && `#${d.reference_number}`,
                              d.issuer,
                              d.customer?.name,
                            ]
                              .filter(Boolean)
                              .join(' · ') || 'No details added'}
                          </p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary">
                            {d.current_file_name ? (
                              <span className="flex min-w-0 items-center gap-1">
                                <Paperclip size={11} className="shrink-0" />
                                <span className="truncate">
                                  {d.current_file_name} · {formatFileSize(d.current_file_size)}
                                </span>
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-warning-500">
                                <Paperclip size={11} /> No file attached
                              </span>
                            )}
                            {d.version_count > 1 && (
                              <span className="flex items-center gap-1">
                                <History size={11} /> {d.version_count} versions
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span
                            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${EXPIRY_STATE_STYLES[state]}`}
                          >
                            {EXPIRY_STATE_LABELS[state]}
                          </span>
                          <span className="text-[11px] text-text-secondary">
                            {describeExpiry(d.expires_on, now)}
                          </span>
                        </div>
                      </div>
                    </button>
                  </motion.li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {accountOwnerId && (
        <DocumentFormModal
          open={formOpen}
          ownerId={accountOwnerId}
          document={editing}
          customers={customers}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSaved={handleSaved}
        />
      )}

      {accountOwnerId && (
        <DocumentDetailPanel
          document={selected}
          ownerId={accountOwnerId}
          canManage={canManage}
          onClose={() => select(null)}
          onEdit={(doc) => {
            setEditing(doc);
            setFormOpen(true);
          }}
          onDelete={(doc) => setDeleting(doc)}
          onChanged={() => void load()}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this document?"
        description="The document and ALL of its versions and stored files are permanently removed. This can't be undone."
        confirmLabel="Yes, delete document"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
