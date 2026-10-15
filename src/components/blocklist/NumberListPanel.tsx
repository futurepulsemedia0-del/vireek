import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Loader2, Plus, Search, ShieldBan, Trash2, Upload, PhoneOff } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { exportToCsv } from '@/lib/csvExport';
import { BulkImportDialog } from './BulkImportDialog';
import {
  BLOCK_CATEGORY_LABELS,
  DNC_REASON_LABELS,
  DuplicateEntryError,
  addEntry,
  fetchAllEntries,
  fetchEntries,
  formatPhone,
  removeEntries,
  type ListEntry,
  type ListKind,
} from '@/lib/callBlocklist';

const PAGE_SIZE = 25;
const SELECT_CLASS = 'focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

const COPY = {
  blocklist: {
    icon: ShieldBan,
    emptyTitle: 'Your blocklist is empty',
    emptyBody: 'Block spam and robocall numbers so the AI never answers them. Add one, import a list, or review suspected spam on the Overview tab.',
    addLabel: 'Block a number',
    labels: BLOCK_CATEGORY_LABELS as Record<string, string>,
  },
  dnc: {
    icon: PhoneOff,
    emptyTitle: 'Your Do-Not-Call list is empty',
    emptyBody: 'Customers who reply STOP or opt out are added automatically. You can also add numbers yourself or import a registry scrub.',
    addLabel: 'Add a number',
    labels: DNC_REASON_LABELS as Record<string, string>,
  },
};

interface NumberListPanelProps {
  kind: ListKind;
  ownerId: string;
  userId: string;
  onChanged: () => void;
}

export function NumberListPanel({ kind, ownerId, userId, onChanged }: NumberListPanelProps) {
  const copy = COPY[kind];
  const { toast } = useToast();
  const requestId = useRef(0);

  const [entries, setEntries] = useState<ListEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [showAdd, setShowAdd] = useState(false);
  const [addPhone, setAddPhone] = useState('');
  const [addCategory, setAddCategory] = useState(kind === 'blocklist' ? 'spam' : 'manual');
  const [addNote, setAddNote] = useState('');
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(false);
    fetchEntries(kind, ownerId, { search, category, page, pageSize: PAGE_SIZE })
      .then((res) => {
        if (id !== requestId.current) return;
        setEntries(res.entries);
        setTotal(res.total);
        setSelected(new Set());
      })
      .catch(() => id === requestId.current && setError(true))
      .finally(() => id === requestId.current && setLoading(false));
  }, [kind, ownerId, search, category, page, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    onChanged();
  }, [onChanged]);

  const handleAdd = async () => {
    setAddError('');
    setAdding(true);
    try {
      await addEntry(kind, ownerId, userId, addPhone, addCategory, addNote);
      setAddPhone('');
      setAddNote('');
      setShowAdd(false);
      toast('Number added.', 'success');
      setPage(0);
      refresh();
    } catch (err) {
      setAddError(err instanceof DuplicateEntryError || err instanceof Error ? err.message : 'Could not add that number.');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async () => {
    try {
      await removeEntries(kind, ownerId, Array.from(selected));
      toast(`${selected.size} number${selected.size === 1 ? '' : 's'} removed.`, 'success');
      setConfirmDelete(false);
      refresh();
    } catch {
      toast('Could not remove those numbers. Please try again.', 'error');
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const all = await fetchAllEntries(kind, ownerId);
      exportToCsv(
        all,
        [
          { header: 'Phone', accessor: (e) => e.phone },
          { header: kind === 'blocklist' ? 'Category' : 'Reason', accessor: (e) => copy.labels[e.category] ?? e.category },
          { header: 'Note', accessor: (e) => e.note },
          { header: 'Added', accessor: (e) => e.createdAt },
          ...(kind === 'blocklist' ? [{ header: 'Times blocked', accessor: (e: ListEntry) => e.hitCount }] : []),
        ],
        kind === 'blocklist' ? 'blocklist' : 'do-not-call',
      );
    } catch {
      toast('Export failed. Please try again.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.id));

  const filtered = search !== '' || category !== 'all';
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 sm:max-w-xs">
            <Input label="Search" type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Number or note" />
          </div>
          <div>
            <label htmlFor={`${kind}-filter`} className="mb-1 block text-xs font-medium text-text-secondary">{kind === 'blocklist' ? 'Category' : 'Reason'}</label>
            <select id={`${kind}-filter`} className={SELECT_CLASS} value={category} onChange={(e) => { setCategory(e.target.value); setPage(0); }}>
              <option value="all">All</option>
              {Object.entries(copy.labels).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => setShowAdd((s) => !s)}><Plus size={14} /> {copy.addLabel}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setImportOpen(true)}><Upload size={14} /> Import</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void handleExport()} disabled={exporting || total === 0}>
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Export
          </Button>
        </div>
      </div>

      {showAdd && (
        <Card className="space-y-3 p-4 hover:translate-y-0">
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Phone number" type="tel" inputMode="tel" value={addPhone} onChange={(e) => setAddPhone(e.target.value)} placeholder="(512) 555-0123" error={addError || undefined} />
            {kind === 'blocklist' && (
              <div>
                <label htmlFor="add-category" className="mb-1 block text-xs font-medium text-text-secondary">Category</label>
                <select id="add-category" className={`${SELECT_CLASS} w-full`} value={addCategory} onChange={(e) => setAddCategory(e.target.value)}>
                  {Object.entries(BLOCK_CATEGORY_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
            )}
            <Input label="Note (optional)" maxLength={200} value={addNote} onChange={(e) => setAddNote(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void handleAdd()} disabled={!addPhone.trim() || adding}>
              {adding && <Loader2 size={14} className="animate-spin" />} Save
            </Button>
          </div>
        </Card>
      )}

      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-xl bg-bg-tertiary px-4 py-2.5" role="status">
          <span className="text-sm text-text-primary">{selected.size} selected</span>
          <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} /> Remove
          </Button>
        </div>
      )}

      {loading ? (
        <Card className="divide-y divide-border p-0 hover:translate-y-0" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-4">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-20" />
            </div>
          ))}
        </Card>
      ) : error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load this list" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => setRefreshKey((k) => k + 1) }} />
      ) : entries.length === 0 ? (
        filtered ? (
          <EmptyState icon={Search} title="Nothing matches your search" description="Try a different number, note or filter." action={{ label: 'Clear filters', onClick: () => { setSearchInput(''); setSearch(''); setCategory('all'); setPage(0); } }} />
        ) : (
          <EmptyState icon={copy.icon} title={copy.emptyTitle} description={copy.emptyBody} action={{ label: copy.addLabel, onClick: () => setShowAdd(true) }} secondaryAction={{ label: 'Import a list', onClick: () => setImportOpen(true) }} />
        )
      ) : (
        <Card className="overflow-hidden p-0 hover:translate-y-0">
          <label className="flex items-center gap-3 border-b border-border bg-bg-tertiary/50 px-4 py-2.5 text-xs font-medium text-text-secondary">
            <input type="checkbox" className="focus-ring h-4 w-4 rounded border-border" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.id)))} />
            Select all on this page
          </label>
          <ul className="divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                <input type="checkbox" className="focus-ring mt-1 h-4 w-4 shrink-0 rounded border-border" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Select ${formatPhone(e.phone)}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-text-primary">{formatPhone(e.phone)}</span>
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{copy.labels[e.category] ?? e.category}</span>
                  </div>
                  {e.note && <p className="mt-0.5 break-words text-xs text-text-secondary">{e.note}</p>}
                  <p className="mt-0.5 text-[11px] text-text-secondary">
                    Added {new Date(e.createdAt).toLocaleDateString()}
                    {kind === 'blocklist' && e.hitCount !== null && e.hitCount > 0 && ` · blocked ${e.hitCount} time${e.hitCount === 1 ? '' : 's'}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-text-secondary">
            <span>{from}–{to} of {total.toLocaleString()}</span>
            <div className="flex items-center gap-1">
              <button type="button" className="focus-ring rounded-lg p-1.5 hover:bg-bg-tertiary disabled:opacity-30" onClick={() => setPage((p) => p - 1)} disabled={page === 0} aria-label="Previous page"><ChevronLeft size={16} /></button>
              <button type="button" className="focus-ring rounded-lg p-1.5 hover:bg-bg-tertiary disabled:opacity-30" onClick={() => setPage((p) => p + 1)} disabled={page >= lastPage} aria-label="Next page"><ChevronRight size={16} /></button>
            </div>
          </div>
        </Card>
      )}

      <BulkImportDialog open={importOpen} kind={kind} ownerId={ownerId} userId={userId} onClose={() => setImportOpen(false)} onImported={() => { setPage(0); refresh(); }} />

      <ConfirmDialog
        open={confirmDelete}
        title={kind === 'dnc' ? 'Remove from Do-Not-Call?' : 'Remove from blocklist?'}
        description={
          kind === 'dnc'
            ? 'Removing a number means you may contact it again. Only do this if the customer has asked to be contacted. Opt-outs are a legal obligation.'
            : 'These callers will be able to reach your AI receptionist again.'
        }
        confirmPhrase={kind === 'dnc' ? 'remove' : undefined}
        confirmLabel="Remove"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
