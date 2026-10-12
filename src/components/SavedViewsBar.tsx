import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, ChevronDown, Copy, Plus, RefreshCw, Star, Trash2, Users } from 'lucide-react';
import {
  copyName,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  MAX_VIEW_NAME_LENGTH,
  orderViews,
  pickDefaultView,
  setDefaultSavedView,
  updateSavedView,
  validateViewName,
  viewMatchesState,
  type SavedView,
  type SavedViewPage,
} from '@/lib/savedViews';
import type { ViewSort } from '@/lib/viewSort';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';

export interface AppliedViewExtras {
  sort: ViewSort | null;
  columns: string[] | null;
}

interface SavedViewsBarProps {
  page: SavedViewPage;
  currentFilters: Record<string, unknown>;
  currentSort?: ViewSort | null;
  currentColumns?: string[] | null;
  /** Called with the stored state. Pages must treat missing keys as "default". */
  onApply: (filters: Record<string, unknown>, extras: AppliedViewExtras) => void;
  /** Open the page on the viewer's default view. Default: true. */
  applyDefaultOnMount?: boolean;
}

const iconButton =
  'focus-ring rounded p-1 text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40';

export function SavedViewsBar({
  page,
  currentFilters,
  currentSort = null,
  currentColumns = null,
  onApply,
  applyDefaultOnMount = true,
}: SavedViewsBarProps) {
  const { toast } = useToast();
  const { user, isOwner } = useAuth();
  const userId = user?.id;

  const [views, setViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [shareNew, setShareNew] = useState(false);
  const [defaultNew, setDefaultNew] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const appliedDefaultRef = useRef(false);
  const onApplyRef = useRef(onApply);
  useEffect(() => {
    onApplyRef.current = onApply;
  });

  const refresh = useCallback(async () => {
    const list = await listSavedViews(page);
    setViews(list);
    return list;
  }, [page]);

  // Initial load (+ open on the viewer's default view, once).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSavedViews(page)
      .then((list) => {
        if (cancelled) return;
        setViews(list);
        setLoadFailed(false);
        if (applyDefaultOnMount && userId && !appliedDefaultRef.current) {
          appliedDefaultRef.current = true;
          const def = pickDefaultView(list, userId);
          if (def) {
            onApplyRef.current(def.filters, { sort: def.sort, columns: def.columns });
            setActiveId(def.id);
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        setViews([]);
        setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, userId, applyDefaultOnMount]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const ordered = useMemo(() => orderViews(views, userId), [views, userId]);
  const mine = ordered.filter((v) => v.user_id === userId);
  const shared = ordered.filter((v) => v.user_id !== userId);
  const activeView = views.find((v) => v.id === activeId) ?? null;
  const modified =
    activeView !== null &&
    !viewMatchesState(activeView, { filters: currentFilters, sort: currentSort, columns: currentColumns });

  const resetSaveForm = () => {
    setSaving(false);
    setNewName('');
    setShareNew(false);
    setDefaultNew(false);
    setNameError(null);
  };

  const applyView = (v: SavedView) => {
    onApply(v.filters, { sort: v.sort, columns: v.columns });
    setActiveId(v.id);
    setOpen(false);
  };

  const handleSave = async () => {
    if (busy) return;
    const error = validateViewName(newName, mine);
    if (error) {
      setNameError(error);
      return;
    }
    setBusy(true);
    try {
      const view = await createSavedView(
        page,
        newName,
        { filters: currentFilters, sort: currentSort, columns: currentColumns },
        { shared: shareNew },
      );
      if (defaultNew) {
        try {
          await setDefaultSavedView(view.id, true);
        } catch {
          toast('View saved, but it could not be set as your default.', 'error');
        }
      }
      try {
        await refresh();
      } catch {
        // Fall back to an optimistic insert when the refresh fails.
        setViews((prev) => [view, ...prev]);
      }
      setActiveId(view.id);
      resetSaveForm();
      toast('View saved.', 'success');
    } catch {
      toast('Could not save view.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleDefault = async (v: SavedView) => {
    if (busy) return;
    setBusy(true);
    try {
      await setDefaultSavedView(v.id, !v.is_default);
      await refresh();
      toast(v.is_default ? 'Default view cleared.' : `“${v.name}” will open by default.`, 'success');
    } catch {
      toast('Could not change the default view.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleShare = async (v: SavedView) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await updateSavedView(v.id, { is_shared: !v.is_shared });
      setViews((prev) => prev.map((x) => (x.id === v.id ? next : x)));
      toast(next.is_shared ? 'Shared with your team.' : 'Now private.', 'success');
    } catch {
      toast('Could not change sharing.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleOverwrite = async (v: SavedView) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await updateSavedView(v.id, {
        filters: currentFilters,
        sort: currentSort,
        columns: currentColumns,
      });
      setViews((prev) => prev.map((x) => (x.id === v.id ? next : x)));
      setActiveId(v.id);
      toast(`“${v.name}” updated.`, 'success');
    } catch {
      toast('Could not update view.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (v: SavedView) => {
    if (busy) return;
    setBusy(true);
    try {
      const copy = await createSavedView(page, copyName(v.name, mine), {
        filters: v.filters,
        sort: v.sort,
        columns: v.columns,
      });
      setViews((prev) => [copy, ...prev]);
      toast('Saved a copy to your views.', 'success');
    } catch {
      toast('Could not copy view.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteSavedView(id);
      setViews((prev) => prev.filter((v) => v.id !== id));
      if (activeId === id) setActiveId(null);
      setPendingDeleteId(null);
    } catch {
      toast('Could not delete view.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (v: SavedView) => {
    const own = v.user_id === userId;
    const canDelete = own || (isOwner && v.is_shared);
    const confirming = pendingDeleteId === v.id;
    return (
      <li key={v.id} className="flex items-center gap-1 px-3 py-2 hover:bg-bg-tertiary">
        <button
          type="button"
          onClick={() => applyView(v)}
          className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm text-text-primary"
          aria-current={v.id === activeId ? 'true' : undefined}
        >
          {v.is_default && <Star size={12} className="shrink-0 fill-current text-warning-500" aria-label="Default view" />}
          <span className="truncate">{v.name}</span>
          {v.id === activeId && <span className="shrink-0 text-[10px] font-medium text-accent">active</span>}
        </button>

        {confirming ? (
          <span className="flex items-center gap-1 text-xs">
            <span className="text-text-secondary">Delete?</span>
            <button type="button" onClick={() => void handleDelete(v.id)} disabled={busy} className="focus-ring rounded px-1.5 py-0.5 font-medium text-danger">
              Yes
            </button>
            <button type="button" onClick={() => setPendingDeleteId(null)} className="focus-ring rounded px-1.5 py-0.5 text-text-secondary">
              No
            </button>
          </span>
        ) : (
          <span className="flex items-center">
            {own && (
              <>
                <button
                  type="button"
                  onClick={() => void handleToggleDefault(v)}
                  disabled={busy}
                  className={iconButton}
                  aria-label={v.is_default ? `Clear default view ${v.name}` : `Set ${v.name} as default`}
                  aria-pressed={v.is_default}
                  title={v.is_default ? 'Opens by default — click to clear' : 'Open this view by default'}
                >
                  <Star size={13} className={v.is_default ? 'fill-current text-warning-500' : ''} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleToggleShare(v)}
                  disabled={busy}
                  className={iconButton}
                  aria-label={v.is_shared ? `Make ${v.name} private` : `Share ${v.name} with team`}
                  aria-pressed={v.is_shared}
                  title={v.is_shared ? 'Shared with team — click to make private' : 'Share with team'}
                >
                  <Users size={13} className={v.is_shared ? 'text-accent' : ''} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleOverwrite(v)}
                  disabled={busy}
                  className={iconButton}
                  aria-label={`Update ${v.name} with current filters`}
                  title="Update with current filters"
                >
                  <RefreshCw size={13} />
                </button>
              </>
            )}
            {!own && (
              <button
                type="button"
                onClick={() => void handleCopy(v)}
                disabled={busy}
                className={iconButton}
                aria-label={`Save a copy of ${v.name}`}
                title="Save a copy to my views"
              >
                <Copy size={13} />
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={() => setPendingDeleteId(v.id)}
                disabled={busy}
                className={`${iconButton} hover:text-danger`}
                aria-label={`Delete ${v.name}`}
              >
                <Trash2 size={13} />
              </button>
            )}
          </span>
        )}
      </li>
    );
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="focus-ring flex max-w-[12rem] items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
      >
        <Bookmark size={15} className="shrink-0" />
        <span className="truncate">{activeView ? activeView.name : 'Views'}</span>
        {modified && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-500" title="Changed since saved" aria-label="Changed since saved" />}
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Saved views"
          className="absolute right-0 top-full z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
        >
          <div className="max-h-72 overflow-y-auto">
            {loading && <p className="px-3 py-3 text-xs text-text-secondary">Loading views…</p>}
            {!loading && loadFailed && <p className="px-3 py-3 text-xs text-danger">Could not load saved views.</p>}
            {!loading && !loadFailed && views.length === 0 && (
              <p className="px-3 py-3 text-xs text-text-secondary">No saved views yet.</p>
            )}
            {mine.length > 0 && (
              <>
                <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">My views</p>
                <ul>{mine.map(renderRow)}</ul>
              </>
            )}
            {shared.length > 0 && (
              <>
                <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">Shared with team</p>
                <ul>{shared.map(renderRow)}</ul>
              </>
            )}
          </div>

          <div className="border-t border-border p-2">
            {saving ? (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    type="text"
                    value={newName}
                    maxLength={MAX_VIEW_NAME_LENGTH}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      setNameError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSave();
                    }}
                    placeholder="View name…"
                    aria-label="View name"
                    aria-invalid={nameError ? true : undefined}
                    className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={busy}
                    className="focus-ring rounded-lg bg-accent px-2 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                  >
                    Save
                  </button>
                </div>
                {nameError && (
                  <p role="alert" className="text-xs text-danger">
                    {nameError}
                  </p>
                )}
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input type="checkbox" checked={shareNew} onChange={(e) => setShareNew(e.target.checked)} />
                  Share with my team
                </label>
                <label className="flex items-center gap-2 text-xs text-text-secondary">
                  <input type="checkbox" checked={defaultNew} onChange={(e) => setDefaultNew(e.target.checked)} />
                  Open this view by default
                </label>
                <button type="button" onClick={resetSaveForm} className="focus-ring rounded px-1 text-xs text-text-secondary hover:text-text-primary">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSaving(true)}
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-accent hover:bg-bg-tertiary"
              >
                <Plus size={13} /> Save current view
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
